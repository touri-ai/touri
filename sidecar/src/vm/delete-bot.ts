import type { Database } from "bun:sqlite"
import { opendir } from "node:fs/promises"
import { join, relative } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import type { Kernel, RegisteredErrorCode, RouteModule, VmRuntime } from "@touri/contracts"
import { deletedBrowserSessionKey, removeBotSessionFile, removeBotSessionKey } from "../browser/sessionVault"
import { createGroupStore } from "../groups/store"
import { removeBotHomeDirectoryAsync, removePrivateFileAsync } from "../kernel/async-files"
import {
  collectUnusedOutputBlobs,
  getStorageCollectionRetryDelay,
  isStorageUpgradePending,
} from "../kernel/data-maintenance"
import { errorResponse, TouriError } from "../kernel/errors"
import { attachmentReferences } from "../kernel/output-blobs"
import { botReplayRows, purgeBotReplay } from "../kernel/transcript-storage"
import { providerLoginAccount } from "./provider-login"

const BOT_FILE_BATCH_SIZE = 16

export const deleteBotRoute = (
  kernel: Kernel,
  runtime: VmRuntime,
  collectBlobs = collectUnusedOutputBlobs,
): RouteModule["routes"][number] => {
  const deleting = new Set<string>()
  return {
    method: "DELETE",
    path: "/bots/:id",
    handler: async ({ params, body }) => {
      const botId = params.id ?? ""
      const bot = kernel.services.use("store.api")?.getBot({ botId })
      if (!bot) return { status: 404, json: { errorCode: "NOT_FOUND", error: "Bot não encontrado" } }
      const input = body as { name?: unknown; deleteVolumes?: unknown } | null
      if (input?.name !== bot.name || (input.deleteVolumes !== undefined && typeof input.deleteVolumes !== "boolean"))
        return { status: 400, json: { errorCode: "CONFIRM_REQUIRED", error: "Digite o nome do bot para excluir." } }
      if (deleting.has(botId)) return errorResponse(new TouriError("TOURI-E1014"))

      deleting.add(botId)
      const db = kernel.db as Database
      try {
        await performDeletionStep("TOURI-E1015", () => stopBotTasks(kernel, botId))
        await performDeletionStep("TOURI-E1016", () => deleteBotLogins(kernel, botId))
        if (bot.machine !== "local" || db.query("SELECT bot_id FROM bot_machines WHERE bot_id = ?").get(botId))
          await performDeletionStep("TOURI-E8003", () =>
            runtime.destroy({ botId, deleteVolumes: input.deleteVolumes === true }),
          )
        const groups = createGroupStore(kernel)
        const groupIds = groups
          .list()
          .filter((group) => group.memberIds.includes(botId))
          .map((group) => group.id)
        const attachments = await performDeletionStep("TOURI-E2014", () => deleteBotData(kernel, botId))
        await removeBotSessionFile(kernel, botId)
        db.query(
          "INSERT INTO settings(key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
        ).run(deletedBrowserSessionKey(botId), "true", Date.now())
        try {
          await removeBotSessionKey(kernel, botId)
          db.query("DELETE FROM settings WHERE key = ?").run(deletedBrowserSessionKey(botId))
        } catch (error) {
          kernel.log({ level: "warn", module: "vm", msg: kernel.redact(String(error)) })
          kernel.services.use("storage.maintenance")?.scheduleSessionKeyRetry()
        }
        publishBotDeletion(kernel, botId, groups, groupIds)
        const collected = await collectDeletedBotBlobs(kernel, botId, attachments, collectBlobs)
        if (!collected) {
          kernel.services.use("storage.maintenance")?.start()
          return errorResponse(new TouriError("TOURI-E2015"))
        }

        return { status: 200, json: {} }
      } catch (error) {
        kernel.services.use("storage.maintenance")?.start()
        db.query("UPDATE bots SET paused = ? WHERE id = ?").run(bot.paused ? 1 : 0, botId)
        return errorResponse(error)
      } finally {
        deleting.delete(botId)
      }
    },
  }
}

const performDeletionStep = async <T>(code: RegisteredErrorCode, action: () => T | Promise<T>): Promise<T> => {
  try {
    return await action()
  } catch (cause) {
    if (cause instanceof TouriError) throw cause
    throw new TouriError(code, { cause })
  }
}

const stopBotTasks = async (kernel: Kernel, botId: string) => {
  // Pause before waiting for turns so the scheduler cannot start more work.
  const db = kernel.db as Database
  db.query("UPDATE bots SET paused = 1 WHERE id = ?").run(botId)
  await kernel.services.use("runtime.cancelBotTurns")?.({ botId })
  await kernel.services.use("vm.desktop")?.closeBot(botId)
}

const publishBotDeletion = (
  kernel: Kernel,
  botId: string,
  groups: ReturnType<typeof createGroupStore>,
  groupIds: string[],
) => {
  kernel.publish({ type: "transcript.resync" })
  groupIds.forEach((id) => {
    const group = groups.get(id)
    if (group) kernel.publish({ type: "group.updated", group })
    groups.threads(id).forEach((thread) => {
      kernel.publish({ type: "thread.updated", thread })
    })
  })
  kernel.publish({ type: "bot.deleted", botId })
}

const collectDeletedBotBlobs = async (
  kernel: Kernel,
  botId: string,
  attachments: Set<string>,
  collectBlobs: typeof collectUnusedOutputBlobs,
): Promise<boolean> => {
  const db = kernel.db as Database
  const marker = `storage.deleted-attachments:${botId}`
  const timeoutMs = 5000
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    for (const attempt of [1, 2, 3]) {
      if (isStorageUpgradePending(db)) return false

      signal.throwIfAborted()
      let deferred = false
      await collectBlobs(
        db,
        kernel.paths.appData,
        Date.now(),
        () => sleep(0, undefined, { signal }),
        attachments,
        undefined,
        () => {
          deferred = true
        },
        signal,
        timeoutMs,
      )
      // Shared and backup-pinned attachments intentionally survive a completed pass.
      if (!deferred && !db.query("SELECT 1 FROM settings WHERE key = ?").get(marker)) return true
      if (attempt === 3 || isStorageUpgradePending(db)) return false

      // Concurrent writes can invalidate a scan; leave sustained contention to maintenance.
      await sleep(getStorageCollectionRetryDelay(attempt), undefined, { signal })
    }
  } catch (error) {
    kernel.log({ level: "warn", module: "vm", msg: kernel.redact(String(error)) })
  }
  return false
}

const deleteBotLogins = async (kernel: Kernel, botId: string) => {
  for (const provider of ["claude", "codex"] as const) {
    const result = await kernel.callHost("keychain.delete", { account: providerLoginAccount(botId, provider) })
    if (!result.success) throw new TouriError("TOURI-E1016")
  }
}

const deleteBotData = async (kernel: Kernel, botId: string): Promise<Set<string>> => {
  const db = kernel.db as Database
  const attachments = getBotAttachments(db, botId)
  try {
    const files = await getBotFilePaths(kernel, botId)
    await removeBotFilesInBatches(kernel.paths.appData, files)
    const homes = [
      relative(kernel.paths.appData, kernel.paths.botsDir),
      "provider-homes/codex",
      "provider-homes/codex-vault",
    ]
    for (const path of homes) await removeBotHomeDirectoryAsync({ root: kernel.paths.appData, path, botId })
  } catch (cause) {
    throw new TouriError("TOURI-E2013", { cause })
  }
  return db.transaction(() => {
    detachBotGroupThreads(db, botId)
    saveRemovedGroupMembers(kernel, botId)
    createGroupStore(kernel).removeBot(botId)
    db.query(
      "INSERT INTO settings(key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
    ).run(`storage.deleted-attachments:${botId}`, JSON.stringify([...attachments]), Date.now())
    purgeBotReplay(db, botId)
    deleteBotRunReferences(db, botId)
    const threads = "SELECT id FROM threads WHERE bot_id = ?"
    db.query(`DELETE FROM group_message_links WHERE source_thread_id IN (${threads})`).run(botId)
    db.query(`UPDATE threads SET group_thread_id = NULL WHERE group_thread_id IN (${threads}) AND bot_id != ?`).run(
      botId,
      botId,
    )
    const threadTables = ["send_journal", "messages_fts", "transcript_retention"]
    threadTables.forEach((table) => {
      db.query(`DELETE FROM ${table} WHERE thread_id IN (${threads})`).run(botId)
    })
    // Open the existing retention guard only inside this scoped transaction.
    db.query(
      "UPDATE transcript_maintenance SET delete_before_id = (SELECT COALESCE(MAX(id), 0) FROM transcript_entries) WHERE id = 1",
    ).run()
    db.query(`DELETE FROM transcript_entries WHERE thread_id IN (${threads})`).run(botId)
    db.query("UPDATE transcript_maintenance SET delete_before_id = 0 WHERE id = 1").run()
    db.query(
      "DELETE FROM notification_log WHERE notification_id IN (SELECT id FROM notifications WHERE bot_id = ?)",
    ).run(botId)
    db.query("DELETE FROM notifications WHERE bot_id = ?").run(botId)
    db.query("DELETE FROM tool_calls WHERE bot_id = ?").run(botId)
    const botTables = ["bot_mcp_servers", "cloud_runs", "cloud_machines"]
    botTables.forEach((table) => {
      db.query(`DELETE FROM ${table} WHERE bot_id = ?`).run(botId)
    })
    db.query("DELETE FROM processes WHERE vm_bot_id = ?").run(botId)
    db.query("DELETE FROM browser_tabs WHERE owner_bot_id = ?").run(botId)
    db.query("DELETE FROM settings WHERE key = ?").run(`approval-grants:${botId}`)
    // Cascades remove only this bot's private threads, routines and group membership.
    db.query("DELETE FROM bots WHERE id = ?").run(botId)
    return attachments
  })()
}

const saveRemovedGroupMembers = (kernel: Kernel, botId: string) => {
  const db = kernel.db as Database
  const store = kernel.services.use("store.api")
  const bot = store?.getBot({ botId })
  if (!store || !bot) return
  const turns = db
    .query(`SELECT root.id, root.thread_id FROM group_turns turn JOIN runs root ON root.id = turn.run_id
      WHERE root.bot_id != ? AND root.status IN ('queued','starting','running') AND (
        EXISTS (SELECT 1 FROM json_each(turn.recipients_json) WHERE value = ?)
        OR EXISTS (SELECT 1 FROM group_run_links link JOIN runs member ON member.id = link.run_id
          WHERE link.turn_id = root.id AND member.bot_id = ?))`)
    .all(botId, botId, botId) as { id: string; thread_id: string }[]
  turns.forEach((turn) => {
    const thread = store.getThread({ threadId: turn.thread_id })
    if (!thread || thread.botId === botId) return
    const text = "O membro foi removido do grupo."
    const result = store.insertMessage({
      message: {
        id: kernel.newId(),
        threadId: thread.id,
        parentId: thread.activeLeafId,
        role: "system",
        kind: "notice",
        status: "complete",
        runId: turn.id,
        text,
        parts: [{ type: "notice", code: "group_member_removed", level: "warning", text }],
        sender: { id: bot.id, name: bot.name },
        source: "local",
      },
    })
    if (!result.success) throw new TouriError("TOURI-E2014")
  })
}

const detachBotGroupThreads = (db: Database, botId: string) => {
  // Shared conversations belong to the remaining group, just as when members are edited.
  const nextMember = `SELECT m.bot_id FROM group_members m
    WHERE m.group_id = threads.group_id AND m.bot_id != ? ORDER BY m.position LIMIT 1`
  db.query(`UPDATE threads SET bot_id = (${nextMember})
    WHERE bot_id = ? AND group_id IS NOT NULL AND group_thread_id IS NULL
      AND EXISTS (${nextMember})`).run(botId, botId, botId)
  // Completed ask-all turns also keep their surviving members' result links.
  db.query(`UPDATE runs SET bot_id = (SELECT bot_id FROM threads WHERE id = runs.thread_id)
    WHERE bot_id = ? AND thread_id IN (SELECT id FROM threads WHERE bot_id != ?)
      AND id IN (SELECT turn.run_id FROM group_turns turn JOIN runs root ON root.id = turn.run_id
        JOIN messages request ON request.id = root.request_message_id
        WHERE EXISTS (SELECT 1 FROM json_each(request.parts_json)
          WHERE json_extract(value, '$.type') = 'notice' AND json_extract(value, '$.code') = 'group_ask_all'))`).run(
    botId,
    botId,
  )
}

const deleteBotRunReferences = (db: Database, botId: string) => {
  // A group run can belong to a different bot than its shared thread.
  const runs = "SELECT id FROM runs WHERE bot_id = ? OR thread_id IN (SELECT id FROM threads WHERE bot_id = ?)"
  db.query(`DELETE FROM group_run_links WHERE run_id IN (${runs}) OR turn_id IN (${runs})`).run(
    botId,
    botId,
    botId,
    botId,
  )
  db.query(`DELETE FROM group_turns WHERE run_id IN (${runs})`).run(botId, botId)
  // Keep delivery acknowledgements on surviving shared conversations for reconnect/retry.
  db.query(`UPDATE send_journal SET run_id = NULL WHERE run_id IN (${runs})`).run(botId, botId)
  db.query(
    `DELETE FROM tool_resolutions WHERE run_id IN (${runs}) OR thread_id IN (SELECT id FROM threads WHERE bot_id = ?)`,
  ).run(botId, botId, botId)
}

const getBotAttachments = (db: Database, botId: string) => {
  const attachments = new Set<string>()
  const references = db
    .query(
      "SELECT parts_json AS json FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE bot_id=?) UNION ALL SELECT event_json AS json FROM transcript_entries WHERE thread_id IN (SELECT id FROM threads WHERE bot_id=?)",
    )
    .all(botId, botId) as { json: string }[]
  references.forEach((row) => {
    attachmentReferences(JSON.parse(row.json), attachments)
  })
  botReplayRows(db, botId).forEach((row) => {
    attachmentReferences(JSON.parse(row.event_json), attachments)
  })
  return attachments
}

const getBotFilePaths = async (kernel: Kernel, botId: string) => {
  const db = kernel.db as Database
  const threads = db.query("SELECT id FROM threads WHERE bot_id=?").all(botId) as { id: string }[]
  const configurations = await getBotConfigurationPaths(kernel.paths.runDir, threads)
  const sessions = db
    .query(
      "SELECT rollout_path FROM provider_sessions WHERE thread_id IN (SELECT id FROM threads WHERE bot_id=?) AND rollout_path IS NOT NULL",
    )
    .all(botId) as { rollout_path: string }[]
  const privateSessions = sessions
    .filter((session) => {
      const suffix = relative(kernel.paths.sessionsDir, session.rollout_path)
      if (!suffix || suffix.startsWith("..") || suffix.startsWith("/")) return false
      // Native CLI histories and sessions referenced by another bot remain user-owned.
      return !db
        .query(
          "SELECT id FROM provider_sessions WHERE rollout_path=? AND thread_id NOT IN (SELECT id FROM threads WHERE bot_id=?)",
        )
        .get(session.rollout_path, botId)
    })
    .map((session) => session.rollout_path)
  return [...configurations, ...privateSessions]
}

const getBotConfigurationPaths = async (runDir: string, threads: { id: string }[]): Promise<string[]> => {
  const directory = await opendir(join(runDir, "claude")).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    throw error
  })
  if (!directory) return []

  const names = new Set(
    threads.flatMap((thread) => ["mcp.json", "settings.json", "system.md"].map((suffix) => `${thread.id}.${suffix}`)),
  )
  // Accumulate locally to avoid copying the matches on every directory entry.
  const paths: string[] = []
  for await (const entry of directory) {
    if (names.has(entry.name)) paths.push(join(runDir, "claude", entry.name))
  }
  return paths
}

const removeBotFilesInBatches = async (root: string, files: string[]): Promise<void> => {
  for (let offset = 0; offset < files.length; offset += BOT_FILE_BATCH_SIZE) {
    const batch = files.slice(offset, offset + BOT_FILE_BATCH_SIZE)
    await Promise.all(batch.map((path) => removePrivateFileAsync({ root, path })))
  }
}
