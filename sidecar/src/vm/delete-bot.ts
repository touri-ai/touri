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
import { deleteBotWorkerSource } from "./delete-bot-worker"
import { providerLoginAccount } from "./provider-login"

type DeletionJob = {
  bot_id: string
  delete_volumes: number
  phase: string
  cursor: number
  high_water: number
  attachment_page: number
  processed: number
  file_cursor: string
  error_code: RegisteredErrorCode | null
  created_at: number
  updated_at: number
}

type DeletionBatchResult = { done: boolean; phase: string; processed: number }

const BATCH_SIZE = 32
const BOT_FILE_BATCH_SIZE = 16

export const deleteBotRoutes = (
  kernel: Kernel,
  runtime: VmRuntime,
  collectBlobs = collectUnusedOutputBlobs,
): RouteModule["routes"] => {
  const db = kernel.db as Database
  const manager = createBotDeletionManager(kernel, runtime, collectBlobs)
  kernel.services.provide("storage.botDeletion", { dispose: manager.dispose })
  manager.resume()

  return [
    {
      method: "GET",
      path: "/storage/bot-deletions",
      handler: async () => ({
        status: 200,
        json: {
          deletions: db
            .query(`SELECT bot_id AS botId, phase, processed, error_code AS errorCode,
              created_at AS createdAt, updated_at AS updatedAt
              FROM bot_deletions ORDER BY created_at LIMIT 100`)
            .all(),
        },
      }),
    },
    {
      method: "DELETE",
      path: "/bots/:id",
      handler: async ({ params, body }) => {
        const botId = params.id ?? ""
        if (db.query("SELECT 1 FROM bot_deletions WHERE bot_id = ?").get(botId))
          return errorResponse(new TouriError("TOURI-E1014"))

        const bot = kernel.services.use("store.api")?.getBot({ botId })
        if (!bot) return { status: 404, json: { errorCode: "NOT_FOUND", error: "Bot não encontrado" } }
        const input = body as { name?: unknown; deleteVolumes?: unknown } | null
        if (input?.name !== bot.name || (input.deleteVolumes !== undefined && typeof input.deleteVolumes !== "boolean"))
          return { status: 400, json: { errorCode: "CONFIRM_REQUIRED", error: "Digite o nome do bot para excluir." } }

        const at = Date.now()
        db.transaction(() => {
          db.query(`INSERT INTO bot_deletions(bot_id, delete_volumes, phase, created_at, updated_at)
            VALUES (?, ?, 'stopping', ?, ?)
            ON CONFLICT(bot_id) DO NOTHING`).run(botId, input.deleteVolumes === true ? 1 : 0, at, at)
          db.query("UPDATE bots SET paused = 1, updated_at = ? WHERE id = ?").run(at, botId)
          db.query(`UPDATE schema_meta SET value = cast(max(cast(value AS INTEGER),
            (SELECT coalesce(max(seq), 0) FROM ui_event_log)) AS TEXT) WHERE key = 'ui_event_floor_seq'`).run()
        }).immediate()
        publishBotDeletion(kernel, botId)
        manager.start(botId)
        return { status: 202, json: { botId, phase: "stopping" } }
      },
    },
  ]
}

export const deleteBotRoute = (
  kernel: Kernel,
  runtime: VmRuntime,
  collectBlobs = collectUnusedOutputBlobs,
): RouteModule["routes"][number] => {
  const route = deleteBotRoutes(kernel, runtime, collectBlobs).find(({ method }) => method === "DELETE")
  if (!route) throw new Error("Bot deletion route missing")
  return route
}

export const createBotDeletionManager = (
  kernel: Kernel,
  runtime: VmRuntime,
  collectBlobs: typeof collectUnusedOutputBlobs,
) => {
  const db = kernel.db as Database
  let disposed = false
  let worker: Worker | undefined
  let workerUrl: string | undefined
  let workerReady: Promise<void> | undefined
  let resolveWorkerReady: (() => void) | undefined
  let rejectWorkerReady: ((error: Error) => void) | undefined
  let pendingBatch:
    | { id: string; resolve: (result: DeletionBatchResult) => void; reject: (error: Error) => void }
    | undefined
  // Correlation belongs to this manager's lifetime; it does not need cryptographic randomness.
  let batchId = 0
  // One worker response can be correlated at a time, even when several bots are purging.
  let batchQueue: Promise<void> = Promise.resolve()
  const running = new Set<string>()
  const immediate = new Map<string, ReturnType<typeof setImmediate>>()
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()

  const clearWorker = () => {
    worker?.terminate()
    worker = undefined
    if (workerUrl) URL.revokeObjectURL(workerUrl)
    workerUrl = undefined
    workerReady = undefined
    resolveWorkerReady = undefined
    rejectWorkerReady = undefined
    pendingBatch?.reject(new Error("Bot deletion worker stopped"))
    pendingBatch = undefined
  }

  const failWorker = (error: Error) => {
    rejectWorkerReady?.(error)
    resolveWorkerReady = undefined
    rejectWorkerReady = undefined
    pendingBatch?.reject(error)
    pendingBatch = undefined
    clearWorker()
  }

  const ensureWorker = (): Promise<void> => {
    if (workerReady) return workerReady
    workerUrl = URL.createObjectURL(new Blob([deleteBotWorkerSource], { type: "application/javascript" }))
    worker = new Worker(workerUrl, { smol: true, ref: false })
    workerReady = new Promise<void>((resolve, reject) => {
      resolveWorkerReady = resolve
      rejectWorkerReady = reject
    })
    worker.onmessage = ({ data }: MessageEvent<Record<string, unknown>>) => {
      if (data.type === "ready") {
        resolveWorkerReady?.()
        resolveWorkerReady = undefined
        rejectWorkerReady = undefined
        return
      }
      if (data.type === "startup-error") {
        failWorker(new Error("Bot deletion worker could not start"))
        return
      }
      if (data.type === "batch" && data.id === pendingBatch?.id) {
        const batch = pendingBatch
        if (!batch) return
        const result = data.result as DeletionBatchResult
        batch.resolve(result)
        pendingBatch = undefined
        return
      }
      if (data.type === "batch-error" && data.id === pendingBatch?.id) {
        const batch = pendingBatch
        if (!batch) return
        const busy = data.busy === true
        const code = typeof data.code === "string" && data.code.startsWith("SQLITE_") ? data.code : "unexpected"
        batch.reject(new Error(busy ? "SQLITE_BUSY" : code))
        pendingBatch = undefined
      }
    }
    worker.onerror = (event) => {
      event.preventDefault()
      failWorker(new Error("Bot deletion worker failed"))
    }
    worker.addEventListener("close", () => {
      if (!disposed && worker) failWorker(new Error("Bot deletion worker closed"))
    })
    worker.postMessage({ type: "start", filename: db.filename })
    return workerReady
  }

  const processBatch = (botId: string): Promise<DeletionBatchResult> => {
    const operation = batchQueue.then(async () => {
      if (disposed) throw new Error("Bot deletion worker stopped")
      await ensureWorker()
      if (!worker) throw new Error("Bot deletion worker is unavailable")
      const id = String(++batchId)
      return new Promise<DeletionBatchResult>((resolve, reject) => {
        pendingBatch = { id, resolve, reject }
        worker?.postMessage({ type: "batch", id, botId })
      })
    })
    batchQueue = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  const updateJob = (
    botId: string,
    patch: { phase?: string; cursor?: number; highWater?: number; fileCursor?: string },
  ) => {
    db.query(`UPDATE bot_deletions SET phase = coalesce(?, phase), cursor = coalesce(?, cursor),
      high_water = coalesce(?, high_water), file_cursor = coalesce(?, file_cursor),
      error_code = NULL, updated_at = ? WHERE bot_id = ?`).run(
      patch.phase ?? null,
      patch.cursor ?? null,
      patch.highWater ?? null,
      patch.fileCursor ?? null,
      Date.now(),
      botId,
    )
  }

  const setJobError = (botId: string, error: unknown) => {
    const code = error instanceof TouriError ? error.code : "TOURI-E2014"
    const phase = (() => {
      try {
        const job = db.query("SELECT phase FROM bot_deletions WHERE bot_id = ?").get(botId) as { phase: string } | null
        return job?.phase ?? "unknown"
      } catch {
        return "unknown"
      }
    })()
    const failure =
      error instanceof Error && "code" in error && typeof error.code === "string" && error.code.startsWith("SQLITE_")
        ? error.code
        : "unexpected"
    db.query("UPDATE bot_deletions SET error_code = ?, updated_at = ? WHERE bot_id = ?").run(code, Date.now(), botId)
    kernel.log({
      level: "warn",
      module: "vm",
      msg: `Bot deletion deferred (${code})`,
      data: { phase, failure },
    })
  }

  const removeBotFilesBatch = async (botId: string, cursor: string) => {
    const rows = db
      .query("SELECT id FROM threads WHERE bot_id = ? AND id > ? ORDER BY id LIMIT ?")
      .all(botId, cursor, BATCH_SIZE) as Array<{ id: string }>
    if (!rows.length) {
      const homes = [
        relative(kernel.paths.appData, kernel.paths.botsDir),
        ...(await getProviderHomePaths(kernel.paths.appData)),
      ]
      for (const path of homes) await removeBotHomeDirectoryAsync({ root: kernel.paths.appData, path, botId })
      updateJob(botId, { phase: "replay", cursor: 0, highWater: 0, fileCursor: "" })
      return false
    }

    const sessions = getBotSessionBatch(db, rows)
    if (sessions.length) {
      const paths = sessions
        .filter((session) => {
          const suffix = relative(kernel.paths.sessionsDir, session.rollout_path)
          if (!suffix || suffix.startsWith("..") || suffix.startsWith("/")) return false
          return !db
            .query(`SELECT 1 FROM provider_sessions WHERE rollout_path = ?
              AND thread_id NOT IN (SELECT id FROM threads WHERE bot_id = ?) LIMIT 1`)
            .get(session.rollout_path, botId)
        })
        .map((session) => session.rollout_path)
      await Promise.all(paths.map((path) => removePrivateFileAsync({ root: kernel.paths.appData, path })))
      db.transaction(() => {
        sessions.forEach(({ id }) => {
          db.query("UPDATE provider_sessions SET rollout_path = NULL WHERE id = ?").run(id)
        })
      })()
      return true
    }

    const paths = await getBotConfigurationPaths(kernel.paths.runDir, rows)
    for (let offset = 0; offset < paths.length; offset += BOT_FILE_BATCH_SIZE) {
      const batch = paths.slice(offset, offset + BOT_FILE_BATCH_SIZE)
      await Promise.all(batch.map((path) => removePrivateFileAsync({ root: kernel.paths.appData, path })))
      if (offset + BOT_FILE_BATCH_SIZE < paths.length) await new Promise<void>((resolve) => setImmediate(resolve))
    }
    updateJob(botId, { phase: "files", fileCursor: rows.at(-1)?.id ?? cursor })
    return true
  }

  const prepareBotGroups = (botId: string) => {
    detachBotGroupThreads(db, botId)
    saveRemovedGroupMembers(kernel, botId)
    const store = createGroupStore(kernel)
    const groups = store.removeBot(botId)
    groups.forEach((group) => {
      kernel.publish({ type: "group.updated", group })
      store.threads(group.id).forEach((thread) => {
        kernel.publish({ type: "thread.updated", thread })
      })
    })
  }

  const prepareBotDeletion = async (job: DeletionJob) => {
    const bot = db
      .query("SELECT id, CASE WHEN cloud_target = 1 THEN 'cloud' ELSE machine END AS machine FROM bots WHERE id = ?")
      .get(job.bot_id) as {
      id: string
      machine: string
    } | null
    if (!bot) {
      db.query("DELETE FROM bot_deletions WHERE bot_id = ?").run(job.bot_id)
      return
    }

    await performDeletionStep("TOURI-E1015", () => stopBotTasks(kernel, job.bot_id))
    await performDeletionStep("TOURI-E1016", () => deleteBotLogins(kernel, job.bot_id))
    if (bot.machine !== "local" || db.query("SELECT bot_id FROM bot_machines WHERE bot_id = ?").get(job.bot_id))
      await performDeletionStep("TOURI-E8003", () =>
        runtime.destroy({ botId: job.bot_id, deleteVolumes: job.delete_volumes === 1 }),
      )
    prepareBotGroups(job.bot_id)
    updateJob(job.bot_id, { phase: "files", fileCursor: "" })
  }

  const runJob = async (botId: string) => {
    if (disposed || running.has(botId)) return
    running.add(botId)
    try {
      while (!disposed) {
        const job = db.query("SELECT * FROM bot_deletions WHERE bot_id = ?").get(botId) as DeletionJob | null
        if (!job) return
        if (job.phase === "stopping") {
          await prepareBotDeletion(job)
          continue
        }
        if (job.phase === "files") {
          const more = await performDeletionStep("TOURI-E2013", () => removeBotFilesBatch(botId, job.file_cursor))
          if (more) await new Promise<void>((resolve) => setImmediate(resolve))
          continue
        }
        if (
          ["replay", "messages", "transcript", "attachments"].includes(job.phase) ||
          job.phase.startsWith("records:")
        ) {
          await processBatch(botId)
          await new Promise<void>((resolve) => setImmediate(resolve))
          continue
        }
        if (job.phase === "finalize") {
          const bot = db.query("SELECT id FROM bots WHERE id = ?").get(botId)
          if (bot) await performDeletionStep("TOURI-E2014", () => deleteBotData(kernel, botId))
          else updateJob(botId, { phase: "session" })
          continue
        }
        if (job.phase === "session") {
          await removeBotSessionFile(kernel, botId)
          await removeDeletedBrowserSessionKey(kernel, botId)
          updateJob(botId, { phase: "cleanup" })
          continue
        }
        if (job.phase === "cleanup") {
          const collected = await collectDeletedBotBlobs(kernel, botId, new Set<string>(), collectBlobs)
          if (!collected) {
            db.query("UPDATE bot_deletions SET error_code = 'TOURI-E2015', updated_at = ? WHERE bot_id = ?").run(
              Date.now(),
              botId,
            )
            kernel.services.use("storage.maintenance")?.start()
            scheduleRetry(botId, 5000)
            return
          }
          db.query("DELETE FROM bot_deletions WHERE bot_id = ?").run(botId)
          return
        }
        if (job.phase === "complete") {
          db.query("DELETE FROM bot_deletions WHERE bot_id = ?").run(botId)
          continue
        }
        return
      }
    } catch (error) {
      if (disposed) return
      if (error instanceof Error && error.message === "SQLITE_BUSY") {
        scheduleRetry(botId, 250)
        return
      }
      setJobError(botId, error)
      scheduleRetry(botId, 1000)
    } finally {
      running.delete(botId)
      if (!disposed) schedulePending()
    }
  }

  const scheduleRetry = (botId: string, delay: number) => {
    if (disposed || retryTimers.has(botId)) return
    const timer = setTimeout(() => {
      retryTimers.delete(botId)
      start(botId)
    }, delay)
    timer.unref()
    retryTimers.set(botId, timer)
  }

  const start = (botId: string) => {
    if (disposed || running.has(botId) || immediate.has(botId)) return
    const timer = setImmediate(() => {
      immediate.delete(botId)
      void runJob(botId)
    })
    immediate.set(botId, timer)
  }

  const schedulePending = () => {
    const pending = db.query("SELECT bot_id FROM bot_deletions ORDER BY created_at LIMIT 100").all() as Array<{
      bot_id: string
    }>
    pending.forEach(({ bot_id }) => {
      if (!retryTimers.has(bot_id)) start(bot_id)
    })
  }

  const resume = () => schedulePending()

  const dispose = () => {
    disposed = true
    immediate.forEach((timer) => {
      clearImmediate(timer)
    })
    retryTimers.forEach((timer) => {
      clearTimeout(timer)
    })
    immediate.clear()
    retryTimers.clear()
    rejectWorkerReady?.(new Error("Bot deletion worker stopped"))
    clearWorker()
  }

  return { start, resume, dispose }
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

const publishBotDeletion = (kernel: Kernel, botId: string) => {
  kernel.publish({ type: "transcript.resync" })
  kernel.publish({ type: "bot.deleted", botId })
}

const removeDeletedBrowserSessionKey = async (kernel: Kernel, botId: string) => {
  const db = kernel.db as Database
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
      if (!deferred && !db.query("SELECT 1 FROM settings WHERE key >= ? AND key < ? LIMIT 1").get(marker, `${marker};`))
        return true
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

const deleteBotData = async (kernel: Kernel, botId: string): Promise<void> => {
  const db = kernel.db as Database
  db.transaction(() => {
    db.query(
      "INSERT INTO settings(key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
    ).run(`storage.deleted-attachments:${botId}`, "[]", Date.now())
    db.query("DELETE FROM settings WHERE key = ?").run(`approval-grants:${botId}`)
    db.query(
      "UPDATE bot_deletions SET phase = 'session', cursor = 0, error_code = NULL, updated_at = ? WHERE bot_id = ?",
    ).run(Date.now(), botId)
    // Historical dependents have already been purged in committed worker batches.
    db.query("DELETE FROM bots WHERE id = ?").run(botId)
  })()
}

const saveRemovedGroupMembers = (kernel: Kernel, botId: string) => {
  const db = kernel.db as Database
  const store = kernel.services.use("store.api")
  const bot = db.query("SELECT id, name FROM bots WHERE id = ?").get(botId) as { id: string; name: string } | null
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

const getBotConfigurationPaths = async (runDir: string, threads: { id: string }[]): Promise<string[]> => {
  const directory = await opendir(join(runDir, "claude")).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    throw error
  })
  if (!directory) return []

  const names = new Set(
    threads.flatMap((thread) => ["mcp.json", "settings.json", "system.md"].map((suffix) => `${thread.id}.${suffix}`)),
  )
  const paths: string[] = []
  for await (const entry of directory) {
    if (names.has(entry.name)) paths.push(join(runDir, "claude", entry.name))
  }
  return paths
}

const getBotSessionBatch = (db: Database, threads: { id: string }[]) => {
  for (const thread of threads) {
    const sessions = db
      .query(`SELECT id, rollout_path FROM provider_sessions
      WHERE thread_id = ? AND rollout_path IS NOT NULL ORDER BY id LIMIT ?`)
      .all(thread.id, BOT_FILE_BATCH_SIZE) as Array<{ id: string; rollout_path: string }>
    if (sessions.length) return sessions
  }
  return []
}

const getProviderHomePaths = async (appData: string): Promise<string[]> => {
  const root = "provider-homes"
  const directory = await opendir(join(appData, root)).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    throw error
  })
  if (!directory) return []

  const paths: string[] = []
  let scanned = 0
  // Provider roots are few; cap malformed entries to keep background cleanup bounded.
  for await (const entry of directory) {
    scanned += 1
    if (scanned > 32) throw new TouriError("TOURI-E2013")
    if (!entry.isDirectory() || !/^[a-z][a-z0-9-]{0,63}$/.test(entry.name)) continue
    paths.push(join(root, entry.name))
  }
  return paths
}
