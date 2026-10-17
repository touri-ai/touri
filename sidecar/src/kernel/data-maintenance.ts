import type { Database } from "bun:sqlite"
import { existsSync, lstatSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import type { MessagePart, StorageMaintenanceStatus, StorageStats } from "@touri/contracts"
import { removePrivateFile } from "./files"
import { historyMigrationStatus } from "./history-backfill"
import { attachmentReferences, externalizeMessageParts, OUTPUT_BLOB_ORIGIN } from "./output-blobs"
import { createStorageUpgrade, maintainDatabasePages } from "./storage-upgrade"
import { compactTranscript } from "./transcript-storage"

export const DEFAULT_DATA_RETENTION_DAYS = 30
const DAY = 24 * 60 * 60 * 1000
const progressKey = "storage.maintenance.progress"
type Cursor = { cursor: number; total: number; completedAt: number; changed?: boolean }

export const validDataRetentionDays = (days: unknown): days is number =>
  Number.isInteger(days) && Number(days) >= 0 && Number(days) <= 3650

export const dataRetentionDays = (database: Database): number => {
  const row = database.query("SELECT value_json FROM settings WHERE key = 'dataRetentionDays'").get() as {
    value_json: string
  } | null
  try {
    const days: unknown = row ? JSON.parse(row.value_json) : DEFAULT_DATA_RETENTION_DAYS
    return validDataRetentionDays(days) ? days : DEFAULT_DATA_RETENTION_DAYS
  } catch {
    return DEFAULT_DATA_RETENTION_DAYS
  }
}

const summarizeParts = (parts: MessagePart[]): MessagePart[] => {
  let summarized = false
  const next = parts.flatMap((part): MessagePart[] => {
    if (part.type === "reasoning") {
      summarized = true
      return []
    }
    if (part.type !== "tool_call" && part.type !== "command" && part.type !== "file_change") return [part]
    const { outputAttachmentId: _id, outputBytes: _bytes, outputPreview: _preview, ...summary } = part
    if (
      summary.type === "tool_call" &&
      (part.outputAttachmentId || summary.outputJson !== null || summary.inputJson !== "{}" || summary.outputTail)
    ) {
      summarized = true
      const { outputTail: _tail, ...toolSummary } = summary
      return [{ ...toolSummary, inputJson: "{}", outputJson: null }]
    }
    if (part.type === "command" && (part.outputAttachmentId || part.outputTail)) {
      summarized = true
      return [{ ...summary, type: "command", outputTail: "" } as MessagePart]
    }
    if (part.type === "file_change" && (part.outputAttachmentId || part.diff !== null)) {
      summarized = true
      return [{ ...summary, type: "file_change", diff: null } as MessagePart]
    }
    return [part]
  })
  if (summarized && !next.some((part) => part.type === "notice" && part.code === "compaction"))
    next.push({
      type: "notice",
      level: "info",
      code: "compaction",
      text: "Detalhes antigos resumidos pela política de retenção. O texto da conversa foi preservado.",
    })
  return next
}

// Keyset pagination bounds both reads and writes. Only the committed cursor is
// persisted, and projection writes do not create another copy in the event logs.
export const compactMessageBatch = ({
  database,
  appData,
  cursor,
  total,
  limit = 50,
  now = Date.now(),
}: {
  database: Database
  appData: string
  cursor: number
  total: number
  limit?: number
  now?: number
}): { cursor: number; changed: boolean } =>
  database.transaction(() => {
    const rows = database
      .query(`SELECT m.rowid AS row_id, m.thread_id, m.id, m.run_id, m.updated_at,
      m.status, EXISTS(SELECT 1 FROM runs r WHERE r.thread_id = m.thread_id
        AND r.status IN ('queued','starting','running')) AS active
    FROM messages m WHERE m.rowid > ? AND m.rowid <= ? ORDER BY m.rowid LIMIT ?`)
      .all(cursor, total, limit) as Array<{
      row_id: number
      thread_id: string
      id: string
      run_id: string | null
      updated_at: number
      status: string
      active: number
    }>
    const days = dataRetentionDays(database)
    const started = performance.now()
    let nextCursor = cursor
    let changed = false
    database.exec("UPDATE transcript_maintenance SET projection_write = 1 WHERE id = 1")
    for (const row of rows) {
      if (nextCursor !== cursor && performance.now() - started >= 8) break
      nextCursor = row.row_id
      if (row.status === "streaming" || row.active) continue
      // Fetch one body at a time: a legacy message can contain megabytes of tool
      // output, so loading a whole batch before yielding defeats the time budget.
      const body = database
        .query("SELECT parts_json FROM messages WHERE thread_id = ? AND id = ?")
        .get(row.thread_id, row.id) as { parts_json: string }
      const parts = JSON.parse(body.parts_json) as MessagePart[]
      const expired = days > 0 && row.updated_at < now - days * DAY
      const next = expired ? summarizeParts(parts) : parts
      const json = JSON.stringify(externalizeMessageParts({ database, appData, parts: next }))
      if (json !== body.parts_json) {
        database
          .query("UPDATE messages SET parts_json = ? WHERE thread_id = ? AND id = ?")
          .run(json, row.thread_id, row.id)
        changed = true
      }
      // Recovery state follows the same retention policy after its run settles.
      // Retained message/journal references still protect the shared body file.
      if (expired && row.run_id) {
        const terminal = database
          .query("SELECT 1 FROM runs WHERE id = ? AND status IN ('succeeded','failed','canceled','interrupted')")
          .get(row.run_id)
        if (terminal)
          for (const part of parts) {
            if (!("callId" in part)) continue
            const tool = database
              .query("SELECT part_json FROM tool_resolutions WHERE run_id = ? AND call_id = ?")
              .get(row.run_id, part.callId) as { part_json: string } | null
            if (!tool) continue
            const summary = JSON.stringify(summarizeParts([JSON.parse(tool.part_json) as MessagePart])[0])
            if (summary === tool.part_json) continue
            database
              .query("UPDATE tool_resolutions SET part_json = ? WHERE run_id = ? AND call_id = ?")
              .run(summary, row.run_id, part.callId)
            changed = true
          }
      }
    }
    database.exec("UPDATE transcript_maintenance SET projection_write = 0 WHERE id = 1")
    return { cursor: rows.length === 0 ? total : nextCursor, changed }
  })()

export const collectUnusedOutputBlobs = async (
  database: Database,
  appData: string,
  now = Date.now(),
  yieldBatch: (() => Promise<void>) | null = () => Bun.sleep(0),
  deletedBotAttachments = new Set<string>(),
): Promise<number> => {
  // Bot deletion can request collection while the backup worker is reading.
  // Keep its referenced files intact until their backup pins are committed.
  if (database.query("SELECT 1 FROM schema_meta WHERE key = 'storage_upgrade_22' AND value <> 'done'").get()) return 0
  // Include replay/recovery references, so retention never deletes a file still
  // needed by an unpublished entry or a reconnecting client. User uploads stay.
  const pending = database
    .query("SELECT key,value_json FROM settings WHERE key LIKE 'storage.deleted-attachments:%'")
    .all() as { key: string; value_json: string }[]
  const eligible = new Set(deletedBotAttachments)
  for (const row of pending) {
    const ids: unknown = JSON.parse(row.value_json)
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") eligible.add(id)
  }
  const candidates = database
    .query(`SELECT id,path FROM attachments
      WHERE (origin_path=? OR id IN (SELECT value FROM json_each(?)))
        AND NOT EXISTS (SELECT 1 FROM storage_backup_attachments b WHERE b.attachment_id = attachments.id)`)
    .all(OUTPUT_BLOB_ORIGIN, JSON.stringify([...eligible])) as Array<{ id: string; path: string }>
  const changes = () => Number((database.query("SELECT total_changes() AS n").get() as { n: number }).n)
  let observed = changes()
  const referenced = new Set<string>()
  if (candidates.length)
    for (const [table, key, column] of [
      ["messages", "rowid", "parts_json"],
      ["tool_resolutions", "rowid", "part_json"],
      ["transcript_entries", "id", "event_json"],
      ["ui_event_log", "seq", "event_json"],
      ["send_journal", "rowid", "request_json"],
    ]) {
      let cursor = 0
      while (true) {
        const rows = database
          .query(`SELECT ${key} AS cursor, ${column} AS json FROM ${table} WHERE ${key} > ? ORDER BY ${key} LIMIT 50`)
          .all(cursor) as Array<{ cursor: number; json: string }>
        for (const row of rows) {
          attachmentReferences(JSON.parse(row.json), referenced)
          cursor = row.cursor
        }
        if (rows.length < 50) break
        if (yieldBatch) await yieldBatch()
        // A writer can introduce a new reference while we yield. Defer collection
        // rather than deleting against an incomplete view of live/recovery data.
        if (changes() !== observed) return 0
      }
    }
  let removed = 0
  for (const blob of candidates) {
    if (referenced.has(blob.id)) continue
    removePrivateFile({ root: appData, path: blob.path })
    database.query("DELETE FROM attachments WHERE id = ?").run(blob.id)
    removed += 1
    observed = changes()
    if (removed % 25 === 0) {
      if (yieldBatch) await yieldBatch()
      if (changes() !== observed) return removed
    }
  }
  // A crash/rollback can lose attachment metadata after the file was committed.
  // Only our dedicated suffix is eligible; uploads and recent writes stay intact.
  const known = new Set(
    (database.query("SELECT id FROM attachments").all() as Array<{ id: string }>).map((row) => row.id),
  )
  const attachmentsDir = join(appData, "attachments")
  if (existsSync(attachmentsDir))
    for (const directory of readdirSync(attachmentsDir, { withFileTypes: true })) {
      if (!directory.isDirectory() || !/^[a-f0-9]{2}$/.test(directory.name)) continue
      for (const file of readdirSync(join(attachmentsDir, directory.name), { withFileTypes: true })) {
        const match = /^([a-f0-9]{64})\.tool-output\.txt$/.exec(file.name)
        if (!file.isFile() || !match?.[1] || known.has(match[1])) continue
        const path = join(attachmentsDir, directory.name, file.name)
        if (lstatSync(path).mtimeMs > now - DAY) continue
        removePrivateFile({ root: appData, path })
        removed += 1
        if (removed % 25 === 0) {
          if (yieldBatch) await yieldBatch()
          if (changes() !== observed) return removed
        }
      }
    }
  for (const row of pending) database.query("DELETE FROM settings WHERE key=?").run(row.key)
  return removed
}

export const storageStats = (database: Database, filename: string): StorageStats => {
  const sum = (sql: string): number => Number((database.query(sql).get() as { n: number | null }).n ?? 0)
  const pageSize = (database.query("PRAGMA page_size").get() as { page_size: number }).page_size
  return {
    databaseBytes: statSync(filename).size,
    walBytes: existsSync(`${filename}-wal`) ? statSync(`${filename}-wal`).size : 0,
    reusableBytes:
      (database.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count * pageSize,
    messageTextBytes: sum("SELECT SUM(length(CAST(text AS BLOB))) AS n FROM messages"),
    messagePartsBytes: sum("SELECT SUM(length(CAST(parts_json AS BLOB))) AS n FROM messages"),
    transcriptBytes: sum("SELECT SUM(length(CAST(event_json AS BLOB))) AS n FROM transcript_entries"),
    eventBytes: sum("SELECT SUM(length(CAST(event_json AS BLOB))) AS n FROM ui_event_log"),
    attachmentBytes: sum("SELECT SUM(bytes) AS n FROM attachments"),
    turns: sum("SELECT COUNT(*) AS n FROM messages WHERE role = 'user'"),
  }
}

export const createStorageMaintenance = ({
  database,
  appData,
  publishResync,
  onError,
}: {
  database: Database
  appData: string
  publishResync: () => void
  onError: () => void
}) => {
  const stored = database.query("SELECT value_json FROM settings WHERE key = ?").get(progressKey) as {
    value_json: string
  } | null
  let progress: Cursor = { cursor: 0, total: 0, completedAt: 0 }
  try {
    const restored = stored ? (JSON.parse(stored.value_json) as Cursor) : progress
    if (
      Number.isSafeInteger(restored.cursor) &&
      restored.cursor >= 0 &&
      Number.isSafeInteger(restored.total) &&
      restored.total >= restored.cursor &&
      Number.isFinite(restored.completedAt) &&
      restored.completedAt >= 0
    )
      progress = restored
  } catch {
    /* A damaged marker safely retries the idempotent pass. */
  }
  const upgrade = createStorageUpgrade({ database, appData })
  let status: StorageMaintenanceStatus = upgrade.snapshot() ?? {
    running: false,
    processed: progress.cursor,
    total: progress.total,
  }
  let stopped = false
  // Reclaim only a few pages per turn. PASSIVE checkpoints never wait for readers.
  const pageTimer = setInterval(() => {
    if (stopped || upgrade.snapshot()) return
    try {
      maintainDatabasePages(database)
    } catch {
      onError()
    }
  }, 60_000)
  let manual = false
  let vacuum = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const save = (value = progress) =>
    database
      .query(`INSERT INTO settings(key,value_json,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
      .run(progressKey, JSON.stringify(value), Date.now())
  const step = async () => {
    if (stopped) return
    if (historyMigrationStatus(database).running) {
      timer = setTimeout(step, 100)
      return
    }
    try {
      if (upgrade.snapshot()) {
        status = upgrade.snapshot() ?? status
        const pending = await upgrade.step()
        if (stopped) return
        status = upgrade.snapshot() ?? status
        if (pending) {
          timer = setTimeout(step, 10)
          return
        }
        publishResync()
        // Revisit message outputs even if the previous daily pass was recent.
        progress = { cursor: 0, total: 0, completedAt: 0 }
      }
      if (!status.running) {
        if (progress.completedAt > Date.now() - DAY) {
          timer = setTimeout(step, DAY)
          return
        }
        status = { running: true, processed: progress.cursor, total: progress.total }
      }
      if (!progress.total || progress.completedAt) {
        progress = {
          cursor: 0,
          total: Number((database.query("SELECT MAX(rowid) AS n FROM messages").get() as { n: number | null }).n ?? 0),
          completedAt: 0,
        }
      }
      progress = database.transaction(() => {
        const next = compactMessageBatch({ database, appData, cursor: progress.cursor, total: progress.total })
        const committed = { ...progress, cursor: next.cursor, changed: progress.changed || next.changed }
        save(committed)
        return committed
      })()
      status = { running: true, processed: progress.cursor, total: progress.total }
      if (progress.cursor < progress.total) {
        timer = setTimeout(step, 10)
        return
      }
      // Capture the recovery tail before pruning. Snapshots/files retain detail;
      // removing replay entries causes clients to refresh from those snapshots.
      if (progress.changed || manual) publishResync()
      if (compactTranscript(manual ? { database, events: 0, entriesPerThread: 0, maxAgeMs: 0 } : { database })) {
        timer = setTimeout(step, 10)
        return
      }
      await collectUnusedOutputBlobs(database, appData, Date.now(), async () => {
        await Bun.sleep(0)
        if (stopped) throw new Error("Manutenção encerrada")
      })
      if (stopped) return
      if (vacuum) {
        database.exec("PRAGMA wal_checkpoint(TRUNCATE)")
        database.exec("PRAGMA auto_vacuum=INCREMENTAL")
        database.exec("VACUUM")
        database.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      }
      if (progress.changed || manual) publishResync()
      manual = false
      vacuum = false
      progress.completedAt = Date.now()
      save()
      status = { running: false, processed: progress.cursor, total: progress.total }
      timer = setTimeout(step, DAY)
    } catch {
      if (stopped) return
      onError()
      status = { ...status, running: false, error: "Não foi possível compactar os dados. Tente novamente." }
      timer = setTimeout(step, 1000)
    }
  }
  timer = setTimeout(step, 100)
  return {
    start: (withVacuum = false): boolean => {
      if (stopped || status.running || historyMigrationStatus(database).running) return false
      clearTimeout(timer)
      progress = { cursor: 0, total: 0, completedAt: 0 }
      status = { running: true, processed: 0, total: 0 }
      manual = true
      vacuum = withVacuum
      timer = setTimeout(step, 0)
      return true
    },
    snapshot: (): StorageMaintenanceStatus => ({ ...status }),
    dispose: () => {
      stopped = true
      upgrade.dispose()
      clearInterval(pageTimer)
      clearTimeout(timer)
    },
  }
}
