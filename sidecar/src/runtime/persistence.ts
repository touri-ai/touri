import { Database } from "bun:sqlite"
import type {
  Id,
  ProviderSession,
  ProviderSessionState,
  Result,
  Routine,
  RoutineRun,
  Run,
  RunErrorClass,
  RunStatus,
  RunTrigger,
  RunUsage,
} from "@touri/contracts"
import { publicError } from "@touri/contracts"
import { jsonText } from "./utils"

type DbRow = Record<string, unknown>

const asRow = (value: unknown): DbRow | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  return value as DbRow
}

const text = (row: DbRow, key: string, fallback = ""): string => (typeof row[key] === "string" ? row[key] : fallback)
const nullableText = (row: DbRow, key: string): string | null => (typeof row[key] === "string" ? row[key] : null)
const integer = (row: DbRow, key: string, fallback = 0): number => (typeof row[key] === "number" ? row[key] : fallback)
const nullableInteger = (row: DbRow, key: string): number | null => (typeof row[key] === "number" ? row[key] : null)

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string") return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

// The shipped runs.error_class CHECK predates machine errors. Keep their public
// code and original detail in the existing text column without changing schema.
const persistedRunError = (run: Pick<Run, "errorClass" | "errorMessage">) =>
  run.errorClass === "machine_service_unavailable" || run.errorClass === "machine_service_start_failed"
    ? {
        errorClass: "unknown",
        errorMessage: jsonText({ code: publicError(run.errorClass).code, message: run.errorMessage }),
      }
    : { errorClass: run.errorClass, errorMessage: run.errorMessage }

const readRunError = (row: DbRow): Pick<Run, "errorClass" | "errorMessage"> => {
  const errorClass = nullableText(row, "error_class") as RunErrorClass | null
  const errorMessage = nullableText(row, "error_message")
  if (errorClass === "unknown") {
    const error = asRow(parseJson<unknown>(errorMessage, null))
    const machineClass =
      error?.code === "TOURI-E8001"
        ? "machine_service_unavailable"
        : error?.code === "TOURI-E8002"
          ? "machine_service_start_failed"
          : null
    if (machineClass && error && (error.message === null || typeof error.message === "string"))
      return { errorClass: machineClass, errorMessage: error.message }
  }
  return { errorClass, errorMessage }
}

export const toRun = (value: unknown): Run | null => {
  const row = asRow(value)
  if (!row) return null
  return {
    id: text(row, "id"),
    threadId: text(row, "thread_id"),
    botId: text(row, "bot_id"),
    provider: text(row, "provider") as Run["provider"],
    trigger: text(row, "trigger") as RunTrigger,
    requestMessageId: nullableText(row, "request_message_id"),
    replyMessageId: nullableText(row, "reply_message_id"),
    externalTurnId: nullableText(row, "external_turn_id"),
    status: text(row, "status") as RunStatus,
    ...readRunError(row),
    usage: parseJson<RunUsage | null>(row.usage_json, null),
    routineRunId: nullableText(row, "routine_run_id"),
    queuedAt: integer(row, "queued_at"),
    startedAt: nullableInteger(row, "started_at"),
    ...(row.provider_started_at == null ? {} : { providerStartedAt: integer(row, "provider_started_at") }),
    finishedAt: nullableInteger(row, "finished_at"),
    ...("group_thread_id" in row ? { groupThreadId: nullableText(row, "group_thread_id") } : {}),
    ...("origin" in row ? { origin: text(row, "origin") as NonNullable<Run["origin"]> } : {}),
  }
}

const toSession = (value: unknown): ProviderSession | null => {
  const row = asRow(value)
  if (!row) return null
  return {
    id: text(row, "id"),
    threadId: text(row, "thread_id"),
    provider: text(row, "provider") as ProviderSession["provider"],
    externalSessionId: text(row, "external_session_id"),
    rolloutPath: nullableText(row, "rollout_path"),
    fingerprint: text(row, "fingerprint"),
    state: text(row, "state") as ProviderSessionState,
    model: nullableText(row, "model"),
    createdAt: integer(row, "created_at"),
    lastUsedAt: integer(row, "last_used_at"),
  }
}

const toRoutine = (value: unknown): Routine | null => {
  const row = asRow(value)
  if (!row) return null
  return {
    id: text(row, "id"),
    botId: text(row, "bot_id"),
    name: text(row, "name"),
    prompt: text(row, "prompt"),
    cron: text(row, "cron"),
    timezone: text(row, "timezone"),
    enabled: integer(row, "enabled") === 1,
    continuity: text(row, "continuity") as Routine["continuity"],
    resultsThreadId: nullableText(row, "results_thread_id"),
    groupId: nullableText(row, "group_id"),
    timeoutMinutes: integer(row, "timeout_minutes", 30),
    overlap: text(row, "overlap", "skip") as Routine["overlap"],
    catchUpMinutes: integer(row, "catch_up_minutes", 30),
    nextRunAt: nullableInteger(row, "next_run_at"),
    source: text(row, "source", "local") as Routine["source"],
    createdAt: integer(row, "created_at"),
    updatedAt: integer(row, "updated_at"),
  }
}

const toRoutineRun = (value: unknown): RoutineRun | null => {
  const row = asRow(value)
  if (!row) return null
  return {
    id: text(row, "id"),
    routineId: text(row, "routine_id"),
    scheduledFor: integer(row, "scheduled_for"),
    status: text(row, "status") as RoutineRun["status"],
    threadId: nullableText(row, "thread_id"),
    runId: nullableText(row, "run_id"),
    triggerSource: text(row, "trigger_source") as RoutineRun["triggerSource"],
    summary: nullableText(row, "summary"),
    startedAt: nullableInteger(row, "started_at"),
    finishedAt: nullableInteger(row, "finished_at"),
  }
}

export type RuntimePersistence = {
  runs: Map<Id, Run>
  sessions: Map<Id, ProviderSession>
  routines: Map<Id, Routine>
  routineRuns: Map<Id, RoutineRun>
  getRun: (id: Id) => Run | null
  findActiveRunForRequest: (args: { threadId: Id; requestMessageId: Id }) => Run | null
  getRunSnapshots: (ids: ReadonlyArray<Id>) => Array<Run>
  listWorkRuns: () => Array<Run>
  listActiveRuns: () => Array<Run>
  listQueuedRuns: () => Array<Run>
  listRuns: (threadId: Id, options?: { all?: boolean }) => Array<Run>
  saveRun: (run: Run) => boolean
  getActiveSession: (args: { threadId: Id; provider: ProviderSession["provider"] }) => ProviderSession | null
  saveSession: (session: ProviderSession) => void
  markSession: (args: { id: Id; state: ProviderSessionState }) => void
  listRoutines: (botId?: Id) => Array<Routine>
  getRoutine: (id: Id) => Routine | null
  saveRoutine: (routine: Routine) => void
  updateRoutine: (routine: Routine) => void
  deleteRoutine: (id: Id) => void
  insertRoutineRun: (routineRun: RoutineRun) => Result<{ routineRun: RoutineRun }, "DUPLICATE_SLOT">
  getRoutineRun: (id: Id) => RoutineRun | null
  updateRoutineRun: (routineRun: RoutineRun) => void
  listRoutineRuns: (routineId: Id) => Array<RoutineRun>
}

const canUseDatabase = (value: unknown): value is Database => {
  if (!(value instanceof Database)) return false
  try {
    value.query("SELECT 1").get()
    return true
  } catch {
    return false
  }
}

const RUN_SNAPSHOT_SELECT = `SELECT r.*, COALESCE(root.thread_id, t.group_thread_id) AS group_thread_id,
  CASE
    WHEN continuation.run_id IS NOT NULL THEN 'resume'
    WHEN EXISTS(SELECT 1 FROM json_each(request.parts_json)
      WHERE json_extract(value, '$.type') = 'notice' AND json_extract(value, '$.code') = 'run_resumed') THEN 'resume'
    WHEN request.sender_json IS NOT NULL THEN 'delegation'
    WHEN r.trigger = 'routine' THEN 'routine'
    ELSE 'message'
  END AS origin
  FROM runs r
  LEFT JOIN threads t ON t.id = r.thread_id
  LEFT JOIN group_run_links link ON link.run_id = r.id
  LEFT JOIN runs root ON root.id = link.turn_id
  LEFT JOIN run_continuations continuation ON continuation.run_id = r.id
  LEFT JOIN messages request ON request.id = r.request_message_id AND request.thread_id = r.thread_id`

export const createRuntimePersistence = ({ database }: { database: unknown }): RuntimePersistence => {
  const db = canUseDatabase(database) ? database : null
  const runs = new Map<Id, Run>()
  const sessions = new Map<Id, ProviderSession>()
  const routines = new Map<Id, Routine>()
  const routineRuns = new Map<Id, RoutineRun>()

  const getRun = (id: Id): Run | null => {
    if (!db) return runs.get(id) ?? null
    try {
      const found = toRun(db.query("SELECT * FROM runs WHERE id = ?").get(id))
      if (!found) {
        runs.delete(id)
        return null
      }
      const current = runs.get(id)
      const run = current ? Object.assign(current, found) : found
      runs.set(id, run)
      return run
    } catch {
      return null
    }
  }

  const findActiveRunForRequest = ({
    threadId,
    requestMessageId,
  }: {
    threadId: Id
    requestMessageId: Id
  }): Run | null => {
    if (!db)
      return (
        [...runs.values()].find(
          (run) =>
            run.threadId === threadId &&
            run.requestMessageId === requestMessageId &&
            ["queued", "starting", "running"].includes(run.status),
        ) ?? null
      )

    try {
      const found = toRun(
        db
          .query(
            "SELECT * FROM runs WHERE thread_id = ? AND request_message_id = ? AND status IN ('queued', 'starting', 'running') ORDER BY queued_at DESC, rowid DESC LIMIT 1",
          )
          .get(threadId, requestMessageId),
      )
      if (!found) return null
      const current = runs.get(found.id)
      const run = current ? Object.assign(current, found) : found
      runs.set(run.id, run)
      return run
    } catch {
      return null
    }
  }

  const getRunSnapshots = (ids: ReadonlyArray<Id>): Array<Run> => {
    if (ids.length === 0) return []
    if (!db)
      return ids.flatMap((id) => {
        const run = runs.get(id)
        return run ? [run] : []
      })

    return db
      .query(`${RUN_SNAPSHOT_SELECT} WHERE r.id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(ids))
      .flatMap((row) => {
        const run = toRun(row)
        return run ? [run] : []
      })
  }

  const listRuns = (threadId: Id, options?: { all?: boolean }): Array<Run> => {
    if (db) {
      const rows = db
        .query(
          `SELECT * FROM runs WHERE thread_id = ? ORDER BY queued_at DESC, rowid DESC${options?.all ? "" : " LIMIT 50"}`,
        )
        .all(threadId)
      return rows.map(toRun).filter((run): run is Run => run !== null)
    }
    return [...runs.values()]
      .filter((run) => run.threadId === threadId)
      .sort((a, b) => b.queuedAt - a.queuedAt)
      .slice(0, options?.all ? undefined : 50)
  }

  const listQueuedRuns = (): Array<Run> => {
    if (!db) return [...runs.values()].filter((run) => run.status === "queued")
    return db
      .query(
        "SELECT * FROM runs WHERE status = 'queued' AND id NOT IN (SELECT run_id FROM group_turns) AND id NOT IN (SELECT run_id FROM group_run_links) ORDER BY queued_at, rowid",
      )
      .all()
      .map(toRun)
      .filter((run): run is Run => run !== null)
  }

  const listWorkRuns = (): Array<Run> => {
    if (!db) return [...runs.values()].filter((run) => ["queued", "starting", "running"].includes(run.status))

    return db
      .query(`${RUN_SNAPSHOT_SELECT}
      JOIN bots b ON b.id = r.bot_id
      JOIN threads visible_thread ON visible_thread.id = COALESCE(root.thread_id, t.group_thread_id, r.thread_id)
      WHERE r.status IN ('queued', 'starting', 'running')
        AND r.id NOT IN (SELECT run_id FROM group_turns)
        AND b.archived_at IS NULL AND visible_thread.archived_at IS NULL
      ORDER BY r.queued_at, r.rowid`)
      .all()
      .flatMap((row) => {
        const run = toRun(row)
        return run ? [run] : []
      })
  }

  const listActiveRuns = (): Array<Run> => {
    if (!db) return [...runs.values()].filter((run) => run.status === "starting" || run.status === "running")
    try {
      const rows = db
        .query(
          "SELECT * FROM runs WHERE status IN ('starting', 'running') AND id NOT IN (SELECT run_id FROM group_turns)",
        )
        .all()
      return rows.map(toRun).filter((run): run is Run => run !== null)
    } catch {
      return []
    }
  }

  const saveRun = (run: Run): boolean => {
    if (!db) {
      const current = runs.get(run.id)
      if (current && !["queued", "starting", "running"].includes(current.status)) return false
      if (current) Object.assign(current, run)
      else runs.set(run.id, run)
      return true
    }
    const error = persistedRunError(run)
    const result = db
      .query(
        `INSERT INTO runs (id, thread_id, bot_id, provider, trigger, request_message_id, reply_message_id, external_turn_id, status, error_class, error_message, usage_json, routine_run_id, queued_at, started_at, finished_at, provider_started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET request_message_id=excluded.request_message_id, reply_message_id=excluded.reply_message_id,
         external_turn_id=excluded.external_turn_id, status=excluded.status, error_class=excluded.error_class,
         error_message=excluded.error_message, usage_json=excluded.usage_json, routine_run_id=excluded.routine_run_id,
         queued_at=excluded.queued_at, started_at=excluded.started_at, finished_at=excluded.finished_at, provider_started_at=excluded.provider_started_at
         WHERE runs.status IN ('queued', 'starting', 'running')`,
      )
      .run(
        run.id,
        run.threadId,
        run.botId,
        run.provider,
        run.trigger,
        run.requestMessageId,
        run.replyMessageId,
        run.externalTurnId,
        run.status,
        error.errorClass,
        error.errorMessage,
        run.usage ? jsonText(run.usage) : null,
        run.routineRunId,
        run.queuedAt,
        run.startedAt,
        run.finishedAt,
        run.providerStartedAt ?? null,
      )
    if (result.changes === 0) return false
    const current = runs.get(run.id)
    if (current) Object.assign(current, run)
    else runs.set(run.id, run)
    return true
  }

  const getActiveSession = ({
    threadId,
    provider,
  }: {
    threadId: Id
    provider: ProviderSession["provider"]
  }): ProviderSession | null => {
    const memory = [...sessions.values()].find(
      (session) => session.threadId === threadId && session.provider === provider && session.state === "active",
    )
    if (memory) return memory
    if (!db) return null
    try {
      const found = toSession(
        db
          .query("SELECT * FROM provider_sessions WHERE thread_id = ? AND provider = ? AND state = 'active' LIMIT 1")
          .get(threadId, provider),
      )
      if (found) sessions.set(found.id, found)
      return found
    } catch {
      return null
    }
  }

  const saveSession = (session: ProviderSession): void => {
    sessions.set(session.id, session)
    if (!db) return
    try {
      db.query(
        `INSERT INTO provider_sessions (id, thread_id, provider, external_session_id, rollout_path, fingerprint, state, model, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET external_session_id=excluded.external_session_id, rollout_path=excluded.rollout_path,
         fingerprint=excluded.fingerprint, state=excluded.state, model=excluded.model, last_used_at=excluded.last_used_at`,
      ).run(
        session.id,
        session.threadId,
        session.provider,
        session.externalSessionId,
        session.rolloutPath,
        session.fingerprint,
        session.state,
        session.model,
        session.createdAt,
        session.lastUsedAt,
      )
    } catch {
      return
    }
  }

  const markSession = ({ id, state }: { id: Id; state: ProviderSessionState }): void => {
    const session = sessions.get(id)
    if (session) {
      session.state = state
      saveSession(session)
    }
    if (db) {
      try {
        db.query("UPDATE provider_sessions SET state = ? WHERE id = ?").run(state, id)
      } catch {
        return
      }
    }
  }

  const listRoutines = (botId?: Id): Array<Routine> => {
    const result = [...routines.values()].filter((routine) => botId === undefined || routine.botId === botId)
    if (!db) return result.sort((left, right) => left.name.localeCompare(right.name))
    try {
      const rows = db
        .query(
          botId === undefined
            ? "SELECT * FROM routines ORDER BY name"
            : "SELECT * FROM routines WHERE bot_id = ? ORDER BY name",
        )
        .all(...(botId === undefined ? [] : [botId]))
      return rows.flatMap((row) => {
        const routine = toRoutine(row)
        if (routine) routines.set(routine.id, routine)
        return routine ? [routine] : []
      })
    } catch {
      return []
    }
  }

  const getRoutine = (id: Id): Routine | null => {
    const memory = routines.get(id)
    if (!db) return memory ?? null
    try {
      const found = toRoutine(db.query("SELECT * FROM routines WHERE id = ?").get(id))
      if (found) routines.set(found.id, found)
      return found
    } catch {
      return null
    }
  }

  const saveRoutine = (routine: Routine): void => {
    routines.set(routine.id, routine)
    if (!db) return
    try {
      db.query(
        `INSERT INTO routines (id, bot_id, name, prompt, cron, timezone, enabled, continuity, results_thread_id, group_id, timeout_minutes, overlap, catch_up_minutes, next_run_at, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET bot_id=excluded.bot_id, name=excluded.name, prompt=excluded.prompt, cron=excluded.cron,
         timezone=excluded.timezone, enabled=excluded.enabled, continuity=excluded.continuity, results_thread_id=excluded.results_thread_id,
         group_id=excluded.group_id,
         timeout_minutes=excluded.timeout_minutes, overlap=excluded.overlap, catch_up_minutes=excluded.catch_up_minutes,
         next_run_at=excluded.next_run_at, source=excluded.source, updated_at=excluded.updated_at`,
      ).run(
        routine.id,
        routine.botId,
        routine.name,
        routine.prompt,
        routine.cron,
        routine.timezone,
        routine.enabled ? 1 : 0,
        routine.continuity,
        routine.resultsThreadId,
        routine.groupId,
        routine.timeoutMinutes,
        routine.overlap,
        routine.catchUpMinutes,
        routine.nextRunAt,
        routine.source,
        routine.createdAt,
        routine.updatedAt,
      )
    } catch {
      return
    }
  }

  const updateRoutine = (routine: Routine): void => saveRoutine(routine)

  const deleteRoutine = (id: Id): void => {
    // The database cascades scheduling records only. Conversations, messages and
    // provider runs remain available, including any turn already in progress.
    if (db) db.query("DELETE FROM routines WHERE id = ?").run(id)
    routines.delete(id)
    for (const [runId, run] of routineRuns) {
      if (run.routineId === id) routineRuns.delete(runId)
    }
  }

  const insertRoutineRun = (routineRun: RoutineRun): Result<{ routineRun: RoutineRun }, "DUPLICATE_SLOT"> => {
    if (
      [...routineRuns.values()].some(
        (row) => row.routineId === routineRun.routineId && row.scheduledFor === routineRun.scheduledFor,
      )
    )
      return { success: false, errorCode: "DUPLICATE_SLOT", error: "Routine slot already exists" }
    if (db) {
      try {
        db.query(
          "INSERT INTO routine_runs (id, routine_id, scheduled_for, status, thread_id, run_id, trigger_source, summary, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          routineRun.id,
          routineRun.routineId,
          routineRun.scheduledFor,
          routineRun.status,
          routineRun.threadId,
          routineRun.runId,
          routineRun.triggerSource,
          routineRun.summary,
          routineRun.startedAt,
          routineRun.finishedAt,
        )
      } catch {
        return { success: false, errorCode: "DUPLICATE_SLOT", error: "Routine slot already exists" }
      }
    }
    routineRuns.set(routineRun.id, routineRun)
    return { success: true, routineRun }
  }

  const getRoutineRun = (id: Id): RoutineRun | null => {
    const memory = routineRuns.get(id)
    if (memory) return memory
    if (!db) return null
    try {
      const found = toRoutineRun(db.query("SELECT * FROM routine_runs WHERE id = ?").get(id))
      if (found) routineRuns.set(found.id, found)
      return found
    } catch {
      return null
    }
  }

  const updateRoutineRun = (routineRun: RoutineRun): void => {
    routineRuns.set(routineRun.id, routineRun)
    if (!db) return
    try {
      db.query(
        "UPDATE routine_runs SET status = ?, thread_id = ?, run_id = ?, summary = ?, started_at = ?, finished_at = ? WHERE id = ?",
      ).run(
        routineRun.status,
        routineRun.threadId,
        routineRun.runId,
        routineRun.summary,
        routineRun.startedAt,
        routineRun.finishedAt,
        routineRun.id,
      )
    } catch {
      return
    }
  }

  const listRoutineRuns = (routineId: Id): Array<RoutineRun> => {
    const result = [...routineRuns.values()].filter((row) => row.routineId === routineId)
    if (result.length > 0 || !db) return result.sort((left, right) => right.scheduledFor - left.scheduledFor)
    try {
      const rows = db
        .query("SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY scheduled_for DESC")
        .all(routineId)
      for (const row of rows) {
        const routineRun = toRoutineRun(row)
        if (routineRun) routineRuns.set(routineRun.id, routineRun)
      }
    } catch {
      return []
    }
    return [...routineRuns.values()]
      .filter((row) => row.routineId === routineId)
      .sort((left, right) => right.scheduledFor - left.scheduledFor)
  }

  return {
    runs,
    sessions,
    routines,
    routineRuns,
    getRun,
    findActiveRunForRequest,
    getRunSnapshots,
    listActiveRuns,
    listWorkRuns,
    listQueuedRuns,
    listRuns,
    saveRun,
    getActiveSession,
    saveSession,
    markSession,
    listRoutines,
    getRoutine,
    saveRoutine,
    updateRoutine,
    deleteRoutine,
    insertRoutineRun,
    getRoutineRun,
    updateRoutineRun,
    listRoutineRuns,
  }
}
