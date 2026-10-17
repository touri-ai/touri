import { CString, dlopen, read } from "bun:ffi"
import type { Database } from "bun:sqlite"
import { closeSync, constants, fsyncSync } from "node:fs"
import { join, relative } from "node:path"
import type { Kernel, RouteModule, VmRuntime } from "@touri/contracts"
import { removeBotSession } from "../browser/sessionVault"
import { collectUnusedOutputBlobs } from "../kernel/data-maintenance"
import { openWorkspaceDirectory, removePrivateFile } from "../kernel/files"
import { attachmentReferences } from "../kernel/output-blobs"
import { botReplayRows, purgeBotReplay } from "../kernel/transcript-storage"
import { direntNameOffset, errnoSymbol, libcLibrary, removeDirectoryFlag } from "../platform/posix"
import { nativeFileOperation } from "../platform/windows-native"
import { providerLoginAccount } from "./provider-login"

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
      if (deleting.has(botId)) return { status: 409, json: { error: "A exclusão já está em andamento." } }
      deleting.add(botId)
      const db = kernel.db as Database
      // Pause before waiting for turns so the scheduler cannot start more work.
      db.query("UPDATE bots SET paused = 1 WHERE id = ?").run(botId)
      try {
        await kernel.services.use("runtime.cancelBotTurns")?.({ botId })
        await kernel.services.use("vm.desktop")?.closeBot(botId)
        for (const provider of ["claude", "codex"] as const) {
          const result = await kernel.callHost("keychain.delete", { account: providerLoginAccount(botId, provider) })
          if (!result.success) throw new Error("Não foi possível apagar os logins do bot no cofre. Tente novamente.")
        }
        if (bot.machine !== "local") await runtime.destroy({ botId, deleteVolumes: input.deleteVolumes === true })
        const threads = db.query("SELECT id FROM threads WHERE bot_id=?").all(botId) as { id: string }[]
        const attachments = new Set<string>()
        const references = db
          .query(
            "SELECT parts_json AS json FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE bot_id=?) UNION ALL SELECT event_json AS json FROM transcript_entries WHERE thread_id IN (SELECT id FROM threads WHERE bot_id=?)",
          )
          .all(botId, botId) as { json: string }[]
        for (const row of references) attachmentReferences(JSON.parse(row.json), attachments)
        for (const row of botReplayRows(db, botId)) attachmentReferences(JSON.parse(row.event_json), attachments)
        for (const thread of threads) {
          for (const suffix of ["mcp.json", "settings.json", "system.md"])
            removePrivateFile({
              root: kernel.paths.appData,
              path: join(kernel.paths.runDir, "claude", `${thread.id}.${suffix}`),
            })
        }
        const sessions = db
          .query(
            "SELECT rollout_path FROM provider_sessions WHERE thread_id IN (SELECT id FROM threads WHERE bot_id=?) AND rollout_path IS NOT NULL",
          )
          .all(botId) as { rollout_path: string }[]
        for (const session of sessions) {
          const suffix = relative(kernel.paths.sessionsDir, session.rollout_path)
          if (!suffix || suffix.startsWith("..") || suffix.startsWith("/")) continue // Native CLI histories are shared, user-owned files.
          if (
            db
              .query(
                "SELECT id FROM provider_sessions WHERE rollout_path=? AND thread_id NOT IN (SELECT id FROM threads WHERE bot_id=?)",
              )
              .get(session.rollout_path, botId)
          )
            continue
          removePrivateFile({ root: kernel.paths.appData, path: session.rollout_path })
        }
        removeBotHome(kernel, botId)
        db.transaction(() => {
          db.query(
            "INSERT INTO settings(key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
          ).run(`storage.deleted-attachments:${botId}`, JSON.stringify([...attachments]), Date.now())
          purgeBotReplay(db, botId)
          const threads = "SELECT id FROM threads WHERE bot_id = ?"
          const runs = "SELECT id FROM runs WHERE bot_id = ?"
          db.query(`DELETE FROM group_run_links WHERE run_id IN (${runs}) OR turn_id IN (${runs})`).run(botId, botId)
          db.query(`DELETE FROM group_turns WHERE run_id IN (${runs})`).run(botId)
          db.query(`DELETE FROM group_message_links WHERE source_thread_id IN (${threads})`).run(botId)
          db.query(
            `UPDATE threads SET group_thread_id = NULL WHERE group_thread_id IN (${threads}) AND bot_id != ?`,
          ).run(botId, botId)
          for (const table of ["send_journal", "tool_resolutions", "messages_fts", "transcript_retention"])
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
          // Cascades remove only this bot's threads, messages, routines and routine runs.
          db.query("DELETE FROM bots WHERE id = ?").run(botId)
        })()
        await removeBotSession(kernel, botId)
        kernel.publish({ type: "transcript.resync" })
        kernel.publish({ type: "bot.deleted", botId })
        await collectUnusedOutputBlobs(db, kernel.paths.appData, Date.now(), null, attachments)
        return { status: 200, json: {} }
      } catch (error) {
        kernel.services.use("storage.maintenance")?.start()
        db.query("UPDATE bots SET paused = ? WHERE id = ?").run(bot.paused ? 1 : 0, botId)
        return { status: 409, json: { errorCode: "MACHINE_ERROR", error: kernel.redact(String(error)) } }
      } finally {
        deleting.delete(botId)
      }
    },
  }
}
