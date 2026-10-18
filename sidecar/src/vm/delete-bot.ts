import { CString, dlopen, read } from "bun:ffi"
import type { Database } from "bun:sqlite"
import { closeSync, constants, fsyncSync } from "node:fs"
import { join, relative } from "node:path"
import type { Kernel, RegisteredErrorCode, RouteModule, VmRuntime } from "@touri/contracts"
import { removeBotSession } from "../browser/sessionVault"
import { createGroupStore } from "../groups/store"
import { collectUnusedOutputBlobs } from "../kernel/data-maintenance"
import { errorResponse, TouriError } from "../kernel/errors"
import { openWorkspaceDirectory, removePrivateFile } from "../kernel/files"
import { attachmentReferences } from "../kernel/output-blobs"
import { botReplayRows, purgeBotReplay } from "../kernel/transcript-storage"
import { direntNameOffset, errnoSymbol, libcLibrary, removeDirectoryFlag } from "../platform/posix"
import { nativeFileOperation } from "../platform/windows-native"
import { providerLoginAccount } from "./provider-login"

export const deleteBotRoute = (kernel: Kernel, runtime: VmRuntime): RouteModule["routes"][number] => {
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
        publishBotDeletion(kernel, botId, groups, groupIds)
        await collectUnusedOutputBlobs(db, kernel.paths.appData, Date.now(), null, attachments)
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
  const turns = getBotGroupTurns(db, botId)
  const runIds = turns.flatMap(({ run_id }) => {
    const children = db.query("SELECT run_id FROM group_run_links WHERE turn_id = ?").all(run_id) as {
      run_id: string
    }[]
    return [run_id, ...children.map((child) => child.run_id)]
  })
  for (const turn of turns) kernel.services.use("groups.runtime")?.cancel(turn.run_id)
  await kernel.services.use("runtime.cancelBotTurns")?.({ botId })
  await waitForStoppedRuns(kernel, runIds)
  await kernel.services.use("vm.desktop")?.closeBot(botId)
}

const getBotGroupTurns = (db: Database, botId: string) =>
  db
    .query(`SELECT g.run_id FROM group_turns g JOIN runs r ON r.id = g.run_id
    WHERE r.status IN ('queued','starting','running') AND (
      g.group_id IN (SELECT group_id FROM group_members WHERE bot_id = ?)
      OR r.bot_id = ? OR r.thread_id IN (SELECT id FROM threads WHERE bot_id = ?))`)
    .all(botId, botId, botId) as { run_id: string }[]

const waitForStoppedRuns = async (kernel: Kernel, runIds: string[]) => {
  const db = kernel.db as Database
  const getPendingRun = () =>
    db
      .query(
        "SELECT 1 FROM runs WHERE id IN (SELECT value FROM json_each(?)) AND status IN ('queued','starting','running') LIMIT 1",
      )
      .get(JSON.stringify(runIds))
  if (!getPendingRun()) return

  await new Promise<void>((resolve, reject) => {
    const finish = (error?: TouriError) => {
      clearTimeout(timer)
      unsubscribe()
      if (error) return reject(error)
      resolve()
    }
    const unsubscribe = kernel.subscribe(({ event }) => {
      if (event.type === "run.updated" && !getPendingRun()) finish()
    })
    const timer = setTimeout(() => finish(new TouriError("TOURI-E1015")), 10_000)
    if (!getPendingRun()) finish()
  })
}

const publishBotDeletion = (
  kernel: Kernel,
  botId: string,
  groups: ReturnType<typeof createGroupStore>,
  groupIds: string[],
) => {
  kernel.publish({ type: "transcript.resync" })
  for (const id of groupIds) {
    const group = groups.get(id)
    if (group) kernel.publish({ type: "group.updated", group })
    for (const thread of groups.threads(id)) kernel.publish({ type: "thread.updated", thread })
  }
  kernel.publish({ type: "bot.deleted", botId })
}

const deleteBotLogins = async (kernel: Kernel, botId: string) => {
  for (const provider of ["claude", "codex"] as const) {
    const result = await kernel.callHost("keychain.delete", { account: providerLoginAccount(botId, provider) })
    if (!result.success) throw new TouriError("TOURI-E1016")
  }
  await removeBotSession(kernel, botId)
}

const deleteBotData = (kernel: Kernel, botId: string) => {
  const db = kernel.db as Database
  return db.transaction(() => {
    detachBotGroupThreads(db, botId)
    const attachments = getBotAttachments(db, botId)
    const files = getBotFilePaths(kernel, botId)
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
    for (const table of ["send_journal", "messages_fts", "transcript_retention"])
      db.query(`DELETE FROM ${table} WHERE thread_id IN (${threads})`).run(botId)
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
    for (const table of ["bot_mcp_servers", "cloud_runs", "cloud_machines"])
      db.query(`DELETE FROM ${table} WHERE bot_id = ?`).run(botId)
    db.query("DELETE FROM processes WHERE vm_bot_id = ?").run(botId)
    db.query("DELETE FROM browser_tabs WHERE owner_bot_id = ?").run(botId)
    db.query("DELETE FROM settings WHERE key = ?").run(`approval-grants:${botId}`)
    // Cascades remove only this bot's private threads, routines and group membership.
    db.query("DELETE FROM bots WHERE id = ?").run(botId)
    deleteBotFiles(kernel, botId, files)
    return attachments
  })()
}

const detachBotGroupThreads = (db: Database, botId: string) => {
  // Shared conversations belong to the remaining group, just as when members are edited.
  const nextMember = `SELECT m.bot_id FROM group_members m
    WHERE m.group_id = threads.group_id AND m.bot_id != ? ORDER BY m.position LIMIT 1`
  db.query(`UPDATE threads SET bot_id = (${nextMember})
    WHERE bot_id = ? AND group_id IS NOT NULL AND group_thread_id IS NULL
      AND EXISTS (${nextMember})`).run(botId, botId, botId)
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
  for (const row of references) attachmentReferences(JSON.parse(row.json), attachments)
  for (const row of botReplayRows(db, botId)) attachmentReferences(JSON.parse(row.event_json), attachments)
  return attachments
}

const getBotFilePaths = (kernel: Kernel, botId: string) => {
  const db = kernel.db as Database
  const threads = db.query("SELECT id FROM threads WHERE bot_id=?").all(botId) as { id: string }[]
  const configurations = threads.flatMap((thread) =>
    ["mcp.json", "settings.json", "system.md"].map((suffix) =>
      join(kernel.paths.runDir, "claude", `${thread.id}.${suffix}`),
    ),
  )
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

const deleteBotFiles = (kernel: Kernel, botId: string, paths: string[]) => {
  try {
    for (const path of paths) removePrivateFile({ root: kernel.paths.appData, path })
    removeBotHome(kernel, botId)
  } catch (cause) {
    throw new TouriError("TOURI-E2013", { cause })
  }
}

const openNative = () =>
  dlopen(libcLibrary, {
    openat: { args: ["i32", "cstring", "i32"], returns: "i32" },
    unlinkat: { args: ["i32", "cstring", "i32"], returns: "i32" },
    dup: { args: ["i32"], returns: "i32" },
    fdopendir: { args: ["i32"], returns: "ptr" },
    readdir: { args: ["ptr"], returns: "ptr" },
    closedir: { args: ["ptr"], returns: "i32" },
    [errnoSymbol]: { args: [], returns: "ptr" },
  }).symbols
let cachedNative: ReturnType<typeof openNative> | undefined
const native = () => (cachedNative ??= openNative())

const errno = () => {
  const pointer = native()[errnoSymbol]?.()
  return pointer ? read.i32(pointer) : 0
}
const cstring = (value: string) => Buffer.from(`${value}\0`)

// Walk and unlink relative to pinned directories. A bot-controlled symlink
// cannot turn deletion of its home into deletion of a project/host directory.
const removeBotHome = (kernel: Kernel, botId: string) => {
  if (process.platform === "win32") {
    if (!botId || botId === "." || botId === ".." || /[\\/\0]/.test(botId)) throw new Error("Pasta do bot inválida.")
    nativeFileOperation("remove_tree", { root: kernel.paths.appData, path: join(kernel.paths.botsDir, botId) })
    return
  }
  const parent = openWorkspaceDirectory({
    root: kernel.paths.appData,
    path: relative(kernel.paths.appData, kernel.paths.botsDir),
  })
  const remove = (directory: number, name: string) => {
    const child = native().openat(
      directory,
      cstring(name),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    if (child < 0) {
      const error = errno()
      if (error === 2) return
      if (error !== 20 && error !== 40 && error !== 62) throw new Error("Não foi possível remover a pasta do bot.")
      if (native().unlinkat(directory, cstring(name), 0) !== 0 && errno() !== 2)
        throw new Error("Não foi possível remover um arquivo do bot.")
      return
    }
    try {
      const duplicate = native().dup(child)
      const stream = native().fdopendir(duplicate)
      if (!stream) {
        closeSync(duplicate)
        throw new Error("Não foi possível ler a pasta do bot.")
      }
      try {
        while (true) {
          const entry = native().readdir(stream)
          if (!entry) break
          const entryName = new CString(entry, direntNameOffset).toString()
          if (entryName !== "." && entryName !== "..") remove(child, entryName)
        }
      } finally {
        native().closedir(stream)
      }
      fsyncSync(child)
    } finally {
      closeSync(child)
    }
    if (native().unlinkat(directory, cstring(name), removeDirectoryFlag) !== 0 && errno() !== 2)
      throw new Error("Não foi possível remover a pasta do bot.")
  }
  try {
    if (!botId || botId === "." || botId === ".." || /[\\/\0]/.test(botId)) throw new Error("Pasta do bot inválida.")
    remove(parent, botId)
    fsyncSync(parent)
  } finally {
    closeSync(parent)
  }
}
