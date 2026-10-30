import type { Database } from "bun:sqlite"
import { isAbsolute, relative } from "node:path"
import type { Kernel, RouteModule, RouteResponse } from "@touri/contracts"
import { removePrivateFileAsync } from "../kernel/async-files"
import { collectUnusedOutputBlobs, isStorageUpgradePending } from "../kernel/data-maintenance"
import { writeDatabaseAsync } from "../kernel/database-write"
import { deviceSession } from "../kernel/device-session"
import { threadDeletionWorkerSource } from "./thread-deletion-worker"

type DeletionJob = {
  thread_id: string
  bot_id: string
  group_id: string | null
  owner_person_id: string | null
  responsible_person_id: string | null
  phase: string
  error_code: string | null
}

type BatchResult = { done: boolean; phase: string }

type PendingBatch = {
  id: string
  resolve: (result: BatchResult) => void
  reject: (error: Error) => void
}

type ThreadRow = {
  id: string
  bot_id: string
  kind: string
  group_id: string | null
  owner_person_id: string | null
  responsible_person_id: string | null
  main_thread_id: string | null
  machine: string
  title: string
}

type DeletionTarget = Pick<ThreadRow, "id" | "bot_id" | "group_id" | "owner_person_id" | "responsible_person_id">

const FILE_BATCH_SIZE = 16
const ATTACHMENT_BATCH_SIZE = 50
const PREVIEW_MESSAGE_LIMIT = 1000
const WORKER_START_TIMEOUT_MS = 15_000
const WORKER_STOP_TIMEOUT_MS = 1_000
const errorResponse = (status: number, errorCode: string, error: string): RouteResponse => ({
  status,
  json: { errorCode, error },
})

export const createThreadDeletionManager = (
  kernel: Kernel,
  collectBlobs: typeof collectUnusedOutputBlobs = collectUnusedOutputBlobs,
  drainThread: (threadId: string) => Promise<void> = async () => {},
  createWorker: (url: string) => Worker = (url) => new Worker(url, { smol: true, ref: false }),
) => {
  const database = kernel.db as Database
  let disposed = false
  // These handles belong to this manager; shutdown owns every asynchronous continuation.
  let activeJob: Promise<void> | undefined
  let disposePromise: Promise<void> | undefined
  const shutdown = new AbortController()
  let scheduled: ReturnType<typeof setImmediate> | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let worker: Worker | undefined
  let workerUrl: string | undefined
  let workerStartupTimer: ReturnType<typeof setTimeout> | undefined
  let workerReady: Promise<void> | undefined
  let resolveWorkerReady: (() => void) | undefined
  let rejectWorkerReady: ((error: Error) => void) | undefined
  let pendingBatch: PendingBatch | undefined
  let batchId = 0
  let workerExited: Promise<void> = Promise.resolve()
  const workerExits = new Set<Promise<void>>()

  const clearWorker = (): void => {
    if (workerStartupTimer) clearTimeout(workerStartupTimer)
    workerStartupTimer = undefined
    worker?.terminate()
    worker = undefined
    if (workerUrl) URL.revokeObjectURL(workerUrl)
    workerUrl = undefined
    workerReady = undefined
    rejectWorkerReady?.(new Error("Thread deletion worker stopped"))
    resolveWorkerReady = undefined
    rejectWorkerReady = undefined
    pendingBatch?.reject(new Error("Thread deletion worker stopped"))
    pendingBatch = undefined
  }

  const failWorker = (error: Error): void => {
    rejectWorkerReady?.(error)
    resolveWorkerReady = undefined
    rejectWorkerReady = undefined
    pendingBatch?.reject(error)
    pendingBatch = undefined
    clearWorker()
  }

  const ensureWorker = (): Promise<void> => {
    if (workerReady) return workerReady

    workerUrl = URL.createObjectURL(new Blob([threadDeletionWorkerSource], { type: "application/javascript" }))
    worker = createWorker(workerUrl)
    const current = worker
    const exited = Promise.withResolvers<void>()
    workerExited = exited.promise
    workerExits.add(workerExited)
    void workerExited.then(() => workerExits.delete(exited.promise))
    workerReady = new Promise<void>((resolve, reject) => {
      resolveWorkerReady = resolve
      rejectWorkerReady = reject
    })
    worker.onmessage = ({ data }: MessageEvent<Record<string, unknown>>) => {
      if (data.type === "ready") {
        if (workerStartupTimer) clearTimeout(workerStartupTimer)
        workerStartupTimer = undefined
        resolveWorkerReady?.()
        resolveWorkerReady = undefined
        rejectWorkerReady = undefined
        return
      }
      if (data.type === "startup-error") {
        failWorker(new Error("Thread deletion worker could not start"))
        return
      }
      if (data.type === "batch" && data.id === pendingBatch?.id) {
        const batch = pendingBatch
        if (!batch) return
        batch.resolve(data.result as BatchResult)
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
      failWorker(new Error("Thread deletion worker failed"))
    }
    worker.addEventListener("close", () => {
      exited.resolve()
      if (worker === current) failWorker(new Error("Thread deletion worker closed"))
    })
    workerStartupTimer = setTimeout(
      () => failWorker(new Error("Thread deletion worker did not start")),
      WORKER_START_TIMEOUT_MS,
    )
    worker.postMessage({ type: "start", filename: database.filename })
    return workerReady
  }

  const processBatch = async (threadId: string): Promise<BatchResult> => {
    await ensureWorker()
    if (disposed) return { done: false, phase: "stopped" }
    if (!worker) throw new Error("Thread deletion worker is unavailable")

    const id = String(++batchId)
    return new Promise<BatchResult>((resolve, reject) => {
      pendingBatch = { id, resolve, reject }
      worker?.postMessage({ type: "batch", id, threadId })
    })
  }

  const removeSessionFiles = async (threadId: string): Promise<boolean> => {
    const sessions = database
      .query(`SELECT id, rollout_path FROM provider_sessions
        WHERE thread_id = ? AND rollout_path IS NOT NULL ORDER BY id LIMIT ?`)
      .all(threadId, FILE_BATCH_SIZE) as Array<{ id: string; rollout_path: string }>
    if (!sessions.length) return false

    const paths = sessions.flatMap((session) => {
      const suffix = relative(kernel.paths.sessionsDir, session.rollout_path)
      if (!suffix || suffix.startsWith("..") || isAbsolute(suffix)) return []
      const shared = database
        .query("SELECT 1 FROM provider_sessions WHERE rollout_path = ? AND thread_id <> ? LIMIT 1")
        .get(session.rollout_path, threadId)
      return shared ? [] : [session.rollout_path]
    })
    await Promise.all(paths.map((path) => removePrivateFileAsync({ root: kernel.paths.appData, path })))
    if (disposed) return false
    database.transaction(() => {
      sessions.forEach(({ id }) => {
        database.query("UPDATE provider_sessions SET rollout_path = NULL WHERE id = ?").run(id)
      })
    })()

    return true
  }

  const removeThreadAttachments = async (threadId: string): Promise<boolean> => {
    if (isStorageUpgradePending(database)) return false

    while (!disposed) {
      const rows = database
        .query(`SELECT attachment_id FROM thread_deletion_attachments
          WHERE thread_id = ? ORDER BY attachment_id LIMIT ?`)
        .all(threadId, ATTACHMENT_BATCH_SIZE) as Array<{ attachment_id: string }>
      if (!rows.length) return true

      const attachments = new Set(rows.map(({ attachment_id }) => attachment_id))
      let deferred = false
      await collectBlobs(
        database,
        kernel.paths.appData,
        Date.now(),
        () => new Promise<void>((resolve) => setImmediate(resolve)),
        attachments,
        undefined,
        () => {
          deferred = true
        },
        AbortSignal.any([shutdown.signal, AbortSignal.timeout(10_000)]),
        10_000,
      )
      if (disposed || deferred) return false
      database.transaction(() => {
        rows.forEach(({ attachment_id }) => {
          database
            .query("DELETE FROM thread_deletion_attachments WHERE thread_id = ? AND attachment_id = ?")
            .run(threadId, attachment_id)
        })
      })()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    return false
  }

  const finishJob = async (job: DeletionJob): Promise<void> => {
    const collected = await removeThreadAttachments(job.thread_id)
    if (disposed) return
    if (!collected) {
      database
        .query("UPDATE thread_deletions SET error_code = 'ATTACHMENT_CLEANUP', updated_at = ? WHERE thread_id = ?")
        .run(Date.now(), job.thread_id)
      kernel.services.use("storage.maintenance")?.start()
      throw new Error("Attachment cleanup was deferred")
    }

    kernel.publish({
      type: "thread.deleted",
      threadId: job.thread_id,
      botId: job.bot_id,
      groupId: job.group_id,
      ownerPersonId: job.owner_person_id,
      responsiblePersonId: job.responsible_person_id,
    })
    database.query("DELETE FROM thread_deletions WHERE thread_id = ?").run(job.thread_id)
  }

  const saveJobFailure = (error: unknown): boolean => {
    try {
      const [job] = database
        .query("SELECT thread_id FROM thread_deletions ORDER BY created_at, thread_id LIMIT 1")
        .all() as Array<{ thread_id: string }>
      if (!job) return true

      const busy = error instanceof Error && error.message === "SQLITE_BUSY"
      database
        .query("UPDATE thread_deletions SET error_code = ?, updated_at = ? WHERE thread_id = ?")
        .run(busy ? "SQLITE_BUSY" : "THREAD_DELETE_FAILED", Date.now(), job.thread_id)
      return true
    } catch {
      // A closed connection or missing backing file can also reject the status write.
      kernel.log({ level: "warn", module: "store", msg: "Thread deletion status could not be saved" })
      return false
    }
  }

  const runJobs = async (): Promise<void> => {
    if (disposed) return
    try {
      while (!disposed) {
        // Exhaust the one-row cursor so its snapshot cannot hide the worker's committed phase changes.
        const [job] = database
          .query("SELECT * FROM thread_deletions ORDER BY created_at, thread_id LIMIT 1")
          .all() as Array<DeletionJob>
        if (!job) return
        if (job.phase === "stopping") {
          await kernel.services.use("runtime.cancelThreadTurns")?.({ threadId: job.thread_id })
          if (disposed) return
          const active = database
            .query("SELECT 1 FROM runs WHERE thread_id = ? AND status IN ('queued','starting','running') LIMIT 1")
            .get(job.thread_id)
          if (active || kernel.services.use("runtime.activeRun")?.({ threadId: job.thread_id }))
            throw new Error("Thread still has active work")
          await drainThread(job.thread_id)
          if (disposed) return
          database.transaction(() => {
            database
              .query("UPDATE threads SET archived_at = coalesce(archived_at, ?), updated_at = ? WHERE id = ?")
              .run(Date.now(), Date.now(), job.thread_id)
            database
              .query(
                "UPDATE thread_deletions SET phase = 'files', error_code = NULL, updated_at = ? WHERE thread_id = ?",
              )
              .run(Date.now(), job.thread_id)
          })()
          await new Promise<void>((resolve) => setImmediate(resolve))
          continue
        }
        if (job.phase === "cleanup") {
          await finishJob(job)
          await new Promise<void>((resolve) => setImmediate(resolve))
          continue
        }
        if (job.phase === "files") {
          const more = await removeSessionFiles(job.thread_id)
          if (disposed) return
          if (!more)
            database
              .query(
                "UPDATE thread_deletions SET phase = 'drain', error_code = NULL, updated_at = ? WHERE thread_id = ?",
              )
              .run(Date.now(), job.thread_id)
          await new Promise<void>((resolve) => setImmediate(resolve))
          continue
        }
        if (job.phase === "drain") {
          await drainThread(job.thread_id)
          if (disposed) return
          database
            .query(
              "UPDATE thread_deletions SET phase = 'events', error_code = NULL, updated_at = ? WHERE thread_id = ?",
            )
            .run(Date.now(), job.thread_id)
          await new Promise<void>((resolve) => setImmediate(resolve))
          continue
        }

        await processBatch(job.thread_id)
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    } catch (error) {
      if (disposed) return
      if (!saveJobFailure(error)) return
      kernel.log({ level: "warn", module: "store", msg: "Thread deletion deferred" })
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = setTimeout(() => {
        retryTimer = undefined
        schedule()
      }, 1000)
    }
  }

  const schedule = (): void => {
    if (disposed || activeJob || scheduled || retryTimer) return
    scheduled = setImmediate(() => {
      scheduled = undefined
      activeJob = runJobs()
        .catch(() => kernel.log({ level: "warn", module: "store", msg: "Thread deletion failed" }))
        .finally(() => {
          activeJob = undefined
        })
    })
  }

  const stopWorker = async (): Promise<void> => {
    const current = worker
    const stopTimer = current
      ? setTimeout(() => {
          kernel.log({ level: "warn", module: "store", msg: "Thread deletion worker shutdown required termination" })
          current.terminate()
        }, WORKER_STOP_TIMEOUT_MS)
      : undefined
    try {
      current?.postMessage({ type: "stop" })
    } catch {
      current?.terminate()
    }
    // Termination is asynchronous too: wait for the connection's owner to exit.
    await Promise.all(workerExits)
    clearTimeout(stopTimer)
    clearWorker()
  }

  const dispose = (): Promise<void> => {
    if (disposePromise) return disposePromise
    disposed = true
    shutdown.abort()
    if (scheduled) clearImmediate(scheduled)
    if (retryTimer) clearTimeout(retryTimer)
    scheduled = undefined
    retryTimer = undefined
    disposePromise = (async () => {
      // Start cancellation before waiting: a batch may need forced termination to settle.
      await Promise.all([activeJob, stopWorker()])
    })()
    return disposePromise
  }

  schedule()
  return { dispose, start: schedule }
}

const getThreadRow = (database: Database, threadId: string): ThreadRow | null =>
  (database
    .query(`SELECT t.id, t.bot_id, t.kind, t.group_id, t.owner_person_id, t.title,
      b.responsible_person_id, b.main_thread_id, CASE WHEN b.cloud_target = 1 THEN 'cloud' ELSE b.machine END AS machine
      FROM threads t JOIN bots b ON b.id = t.bot_id WHERE t.id = ?`)
    .get(threadId) as ThreadRow | null) ?? null

const getPermissionError = (
  kernel: Kernel,
  thread: ThreadRow,
  signal: AbortSignal,
): ReturnType<typeof errorResponse> | null => {
  const person = deviceSession(signal)?.person
  if (!person || person.role === "admin") return null
  if (
    thread.group_id &&
    !kernel.services.use("work.canAccessThread")?.({ personId: person.id, role: person.role, threadId: thread.id })
  )
    return errorResponse(403, "THREAD_DELETE_FORBIDDEN", "Você não tem permissão para excluir esta conversa.")
  if (thread.owner_person_id === person.id) return null
  const ownsBot = thread.responsible_person_id === person.id && thread.group_id === null
  if (ownsBot) return null

  return errorResponse(403, "THREAD_DELETE_FORBIDDEN", "Você não tem permissão para excluir esta conversa.")
}

const getDeleteError = (database: Database, thread: ThreadRow): ReturnType<typeof errorResponse> | null => {
  if (thread.kind === "main" || thread.main_thread_id === thread.id)
    return errorResponse(409, "THREAD_MAIN", "A conversa principal do bot não pode ser excluída.")
  if (thread.group_id) {
    const [main] = database
      .query(
        "SELECT id FROM threads WHERE group_id = ? AND group_thread_id IS NULL AND archived_at IS NULL ORDER BY created_at, id LIMIT 1",
      )
      .all(thread.group_id) as Array<{ id: string }>
    if (main?.id === thread.id)
      return errorResponse(409, "THREAD_MAIN", "A conversa principal do canal não pode ser excluída.")
  }
  if (thread.machine === "cloud")
    return errorResponse(409, "THREAD_REMOTE", "Esta conversa remota não pode ser excluída por este servidor.")

  return null
}

export const threadDeletionRoutes = (
  kernel: Kernel,
  collectBlobs: typeof collectUnusedOutputBlobs = collectUnusedOutputBlobs,
  drainThread: (threadId: string) => Promise<void> = async () => {},
): RouteModule["routes"] => {
  const database = kernel.db as Database
  const manager = createThreadDeletionManager(kernel, collectBlobs, drainThread)
  kernel.services.provide("storage.threadDeletion", { dispose: manager.dispose })

  const queueDeletion = async (threads: Array<DeletionTarget>): Promise<ReturnType<typeof errorResponse> | null> => {
    const at = Date.now()
    const error = await writeDatabaseAsync(database, () => {
      const placeholders = threads.map(() => "?").join(",")
      const linked = database
        .query(`SELECT t.id, t.bot_id, t.group_id, t.owner_person_id, b.responsible_person_id
        FROM threads t JOIN bots b ON b.id = t.bot_id WHERE t.group_thread_id IN (${placeholders}) LIMIT 201`)
        .all(...threads.map((thread) => thread.id)) as Array<DeletionTarget>
      const deleting = Array.from(new Map([...threads, ...linked].map((thread) => [thread.id, thread])).values())
      if (deleting.length > 200)
        return errorResponse(400, "TOO_MANY_THREADS", "Selecione menos conversas para excluir com seus participantes.")
      const insert = database.query(`INSERT OR IGNORE INTO thread_deletions(
        thread_id, bot_id, group_id, owner_person_id, responsible_person_id, phase, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'stopping', ?, ?)`)
      deleting.forEach((thread) => {
        insert.run(
          thread.id,
          thread.bot_id,
          thread.group_id,
          thread.owner_person_id,
          thread.responsible_person_id,
          at,
          at,
        )
      })
      database
        .query(`UPDATE schema_meta SET value = cast(max(cast(value AS INTEGER),
        (SELECT coalesce(max(seq), 0) FROM ui_event_log)) AS TEXT) WHERE key = 'ui_event_floor_seq'`)
        .run()
      return null
    })
    if (error) return error
    manager.start()
    return null
  }

  const validateDeletion = (thread: ThreadRow, signal: AbortSignal): ReturnType<typeof errorResponse> | null => {
    const permissionError = getPermissionError(kernel, thread, signal)
    if (permissionError) return permissionError
    const deletionError = getDeleteError(database, thread)
    if (deletionError) return deletionError
    if (database.query("SELECT 1 FROM thread_deletions WHERE thread_id = ?").get(thread.id))
      return errorResponse(409, "THREAD_DELETING", "Esta conversa já está sendo excluída.")
    return null
  }

  return [
    {
      method: "GET",
      path: "/threads/:id/delete-preview",
      handler: async ({ params, signal }) => {
        const thread = getThreadRow(database, params.id ?? "")
        if (!thread) return errorResponse(404, "NOT_FOUND", "Conversa não encontrada.")
        const permissionError = getPermissionError(kernel, thread, signal)
        if (permissionError) return permissionError
        const deletionError = getDeleteError(database, thread)
        if (deletionError) return deletionError
        if (database.query("SELECT 1 FROM thread_deletions WHERE thread_id = ?").get(thread.id))
          return errorResponse(409, "THREAD_DELETING", "Esta conversa já está sendo excluída.")
        const messageCount = Number(
          (
            database
              .query("SELECT count(*) AS count FROM (SELECT 1 FROM messages WHERE thread_id = ? LIMIT ?)")
              .get(thread.id, PREVIEW_MESSAGE_LIMIT + 1) as {
              count: number
            }
          ).count,
        )
        // Large histories use the generic confirmation rather than an unbounded exact count.
        return {
          status: 200,
          json: {
            thread: { id: thread.id, title: thread.title },
            messageCount: messageCount > PREVIEW_MESSAGE_LIMIT ? null : messageCount,
          },
        }
      },
    },
    {
      method: "DELETE",
      path: "/threads/:id",
      handler: async ({ params, signal }) => {
        const thread = getThreadRow(database, params.id ?? "")
        if (!thread) return errorResponse(404, "NOT_FOUND", "Conversa não encontrada.")
        const error = validateDeletion(thread, signal)
        if (error) return error
        const queueError = await queueDeletion([thread])
        if (queueError) return queueError
        return { status: 202, json: { threadId: thread.id, phase: "stopping" } }
      },
    },
    {
      method: "POST",
      path: "/threads/delete",
      handler: async ({ body, signal }) => {
        const record = body && typeof body === "object" && !Array.isArray(body) ? (body as { ids?: unknown }) : null
        if (!Array.isArray(record?.ids) || record.ids.length < 1 || record.ids.length > 200)
          return errorResponse(400, "INVALID_ARGS", "Informe de 1 a 200 conversas para excluir.")
        if (
          record.ids.some((id) => typeof id !== "string" || !id.trim()) ||
          new Set(record.ids).size !== record.ids.length
        )
          return errorResponse(400, "INVALID_ARGS", "A lista de conversas contém identificadores inválidos.")

        const ids = record.ids as string[]
        const placeholders = ids.map(() => "?").join(",")
        const threads = database
          .query(`SELECT t.id, t.bot_id, t.kind, t.group_id, t.owner_person_id, t.title,
            b.responsible_person_id, b.main_thread_id,
            CASE WHEN b.cloud_target = 1 THEN 'cloud' ELSE b.machine END AS machine
            FROM threads t JOIN bots b ON b.id = t.bot_id WHERE t.id IN (${placeholders})`)
          .all(...ids) as Array<ThreadRow>
        if (threads.length !== ids.length) return errorResponse(404, "NOT_FOUND", "Uma conversa não foi encontrada.")

        for (const thread of threads) {
          const error = validateDeletion(thread, signal)
          if (error) return error
        }

        const queueError = await queueDeletion(threads)
        if (queueError) return queueError
        return { status: 202, json: { threadIds: ids, phase: "stopping" } }
      },
    },
  ]
}
