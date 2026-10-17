import type { Database } from "bun:sqlite"
import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { atomicWriteFile, movePrivateFile, removePrivateFile } from "./files"
import { materializeTranscript } from "./transcript-storage"

const progressKey = "storage.upgrade.22"
const marker = "storage_upgrade_22"
type Progress = { cursor: number; total: number; backup: boolean }

/** Old databases reuse freed pages until an explicit VACUUM enables this mode. */
export const maintainDatabasePages = (database: Database): void => {
  database.exec("PRAGMA busy_timeout = 0")
  try {
    database.exec("PRAGMA wal_checkpoint(PASSIVE)")
    if ((database.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number }).auto_vacuum === 2)
      database.exec("PRAGMA incremental_vacuum(32)")
  } finally {
    database.exec("PRAGMA busy_timeout = 5000")
  }
}

// A separate connection takes a consistent WAL snapshot. Copying the live file
// alone can lose committed WAL pages; serializing it would block HTTP and allocate
// the entire old history on the main thread. Keep the backup local and private.
const backupSource = `import { Database } from "bun:sqlite";
import { openSync, fsyncSync, closeSync } from "node:fs";
self.onmessage = ({ data: { filename, destination } }) => {
  let source;
  let backup;
  let stage = "open-source";
  try {
    source = new Database(filename, { readonly: true });
    source.exec("PRAGMA busy_timeout = 1000");
    stage = "copy";
    source.query("VACUUM INTO ?").run(destination);
    source.close(); source = null;
    stage = "verify";
    backup = new Database(destination, { readonly: true });
    if (backup.query("PRAGMA quick_check").get().quick_check !== "ok") throw new Error("backup");
    backup.close(); backup = null;
    stage = "sync";
    const fd = openSync(destination, "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    self.postMessage({ ok: true });
  } catch (error) {
    const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code)
      ? error.code : "BACKUP_FAILED";
    self.postMessage({ ok: false, stage, code });
  }
  finally { source?.close(); backup?.close(); }
};`

export const createStorageUpgrade = ({ database, appData }: { database: Database; appData: string }) => {
  const row = database.query("SELECT value_json FROM settings WHERE key = ?").get(progressKey) as {
    value_json: string
  } | null
  const pending = database.query("SELECT 1 FROM schema_meta WHERE key = ? AND value <> 'done'").get(marker)
  let progress: Progress | null = null
  if (pending) {
    try {
      const saved = row ? (JSON.parse(row.value_json) as Progress) : null
      if (
        saved &&
        Number.isSafeInteger(saved.cursor) &&
        saved.cursor >= 0 &&
        Number.isSafeInteger(saved.total) &&
        saved.total >= saved.cursor &&
        typeof saved.backup === "boolean"
      )
        progress = saved
    } catch {
      /* Rebuild damaged progress before permitting destructive maintenance. */
    }
    if (!progress)
      progress = {
        cursor: 0,
        total: Number(
          (database.query("SELECT COALESCE(MAX(id), 0) AS n FROM transcript_entries").get() as { n: number }).n,
        ),
        backup: false,
      }
  }
  let stopped = false
  let worker: Worker | undefined
  let rejectBackup: ((reason: Error) => void) | undefined
  const save = (next: Progress) => {
    database
      .query(`INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
      .run(progressKey, JSON.stringify(next), Date.now())
  }
  const backup = async (): Promise<void> => {
    const temporary = join(appData, "backups", "history-before-22.pending")
    const original = join(appData, "backups", "history-before-22.db")
    // A damaged cursor must never replace the original pre-upgrade backup.
    const destination = existsSync(original)
      ? join(appData, "backups", `history-before-22-recovery-${randomBytes(6).toString("hex")}.db`)
      : original
    removePrivateFile({ root: appData, path: temporary })
    atomicWriteFile({ root: appData, path: temporary, content: "" })
    const url = URL.createObjectURL(new Blob([backupSource], { type: "application/javascript" }))
    try {
      await new Promise<void>((resolve, reject) => {
        rejectBackup = reject
        worker = new Worker(url, { smol: true })
        worker.onmessage = ({ data }) => {
          if (data?.ok === true) return resolve()
          const stage = ["open-source", "copy", "verify", "sync"].includes(data?.stage) ? data.stage : "worker"
          const code =
            typeof data?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(data.code) ? data.code : "BACKUP_FAILED"
          reject(new Error(`Storage backup failed (${stage}: ${code})`))
        }
        worker.onerror = () => reject(new Error("Storage backup failed"))
        worker.postMessage({ filename: database.filename, destination: temporary })
      })
      if (stopped) return
      movePrivateFile({ root: appData, from: temporary, to: destination })
    } finally {
      worker?.terminate()
      worker = undefined
      rejectBackup = undefined
      URL.revokeObjectURL(url)
    }
  }

  return {
    snapshot: () => (progress ? { running: true, processed: progress.cursor, total: progress.total } : null),
    step: async (): Promise<boolean> => {
      if (!progress || stopped) return false
      if (!progress.backup) {
        await backup()
        if (stopped) return true
        const backedUp = { ...progress, backup: true }
        database.transaction(() => {
          // A later retention pass must not remove an output file required to
          // restore this backup. Pinning additional concurrent outputs is safe.
          database.exec("INSERT OR IGNORE INTO storage_backup_attachments SELECT id FROM attachments")
          save(backedUp)
        })()
        progress = backedUp
      }
      // Apply every durable delta before discarding its replay representation.
      // The projection, tool resolutions and output files keep the actual history.
      materializeTranscript(database)
      const checkpoint = Number(
        (
          database.query("SELECT value FROM schema_meta WHERE key = 'transcript_event_checkpoint'").get() as {
            value: string
          }
        ).value,
      )
      const upper = Math.min(progress.total, checkpoint)
      const rows = database
        .query("SELECT id, thread_id, seq FROM transcript_entries WHERE id > ? AND id <= ? ORDER BY id LIMIT 25")
        .all(progress.cursor, upper) as Array<{ id: number; thread_id: string; seq: number }>
      let cursor = progress.cursor
      database.transaction(() => {
        const started = performance.now()
        for (const entry of rows) {
          if (cursor !== progress?.cursor && performance.now() - started >= 8) break
          database.query("UPDATE transcript_maintenance SET delete_before_id = ? WHERE id = 1").run(entry.id)
          database.query("DELETE FROM transcript_entries WHERE id = ?").run(entry.id)
          database.query("DELETE FROM rejections WHERE thread_id = ? AND seq = ?").run(entry.thread_id, entry.seq)
          database
            .query(`INSERT INTO transcript_retention(thread_id, through_seq) VALUES (?, ?)
            ON CONFLICT(thread_id) DO UPDATE SET through_seq = MAX(through_seq, excluded.through_seq)`)
            .run(entry.thread_id, entry.seq)
          cursor = entry.id
        }
        database.exec("UPDATE transcript_maintenance SET delete_before_id = 0 WHERE id = 1")
        const complete = rows.length === 0 && checkpoint >= (progress?.total ?? 0)
        if (complete) {
          database.query("UPDATE schema_meta SET value = 'done' WHERE key = ?").run(marker)
          database.query("DELETE FROM settings WHERE key = ?").run(progressKey)
        } else if (progress) save({ ...progress, cursor })
      })()
      if (rows.length === 0 && checkpoint >= progress.total) {
        progress = null
        return false
      }
      progress = { ...progress, cursor }
      return true
    },
    dispose: () => {
      stopped = true
      worker?.terminate()
      rejectBackup?.(new Error("Storage backup stopped"))
    },
  }
}
