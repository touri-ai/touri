import type { Database } from "bun:sqlite"
import type { Kernel, MessagePart, RecoveryTask, RunErrorClass } from "@touri/contracts"
import { hasRecordedActions, safeRunFailure, sanitizeDiagnostic } from "@touri/contracts/run-failure"
import type { PerformanceStageRunner } from "../kernel/performance"
import { createWorkState } from "../runtime/work-state"
import type { Notifier } from "./notifier"
import type { NotificationStore } from "./store"

type Candidate = Omit<RecoveryTask, "notification"> & {
  botId: string
  threadId: string | null
  turnId: string | null
  reason: string
  journalOnly: boolean
}
type RunRow = {
  id: string
  bot_id: string
  thread_id: string
  status: string
  error_message: string | null
  error_class: RunErrorClass | null
  routine_id: string | null
  occurred_at: number
}

const RECENT_TASK_LIMIT = 100

export const createRecoverySync = (
  kernel: Kernel,
  store: NotificationStore,
  notifier: Notifier,
  runStage?: PerformanceStageRunner,
) => {
  const database = kernel.db as Database
  // This connection owns writes; the counter also catches journal changes without a runtime event.
  let snapshot: { changes: number; tasks: RecoveryTask[]; runRowid: number; routineRowid: number } | null = null
  let changedRunIds: string[] = []
  let changedRoutineIds: string[] = []
  kernel.subscribe(({ event }) => {
    if (event.type === "routine.updated" && event.lastRun?.status === "failed")
      changedRoutineIds = [...new Set([...changedRoutineIds, event.lastRun.id])]
    if (event.type === "run.updated" && ["failed", "interrupted"].includes(event.run.status))
      changedRunIds = [...new Set([...changedRunIds, event.run.id])]
  })
  const getChanges = () => (database.query("SELECT total_changes() AS count").get() as { count: number }).count

  return (options: { silent?: boolean } = {}): RecoveryTask[] => {
    const changes = getChanges()
    if (snapshot?.changes === changes && changedRunIds.length === 0 && changedRoutineIds.length === 0)
      return snapshot.tasks

    const runRowid = getLastRowid(database, "runs")
    const routineRowid = getLastRowid(database, "routine_runs")
    const pending = (snapshot?.tasks ?? []).filter((task) => task.notification.resolvedAt === null)
    const pendingRunIds = pending.flatMap((task) => (task.runId ? [task.runId] : []))
    const pendingRoutineIds = pending.filter((task) => task.id.startsWith("routine:")).map((task) => task.id.slice(8))
    const current = syncRecoveryTasks(
      kernel,
      store,
      notifier,
      options.silent ?? false,
      {
        runIds: [...new Set([...changedRunIds, ...pendingRunIds])],
        routineIds: [...new Set([...changedRoutineIds, ...pendingRoutineIds])],
        runRowid: snapshot?.runRowid ?? Math.max(0, runRowid - RECENT_TASK_LIMIT),
        routineRowid: snapshot?.routineRowid ?? Math.max(0, routineRowid - RECENT_TASK_LIMIT),
      },
      runStage,
    )
    const currentIds = new Set(current.map((task) => task.id))
    const history = (snapshot?.tasks ?? [])
      .filter((task) => task.notification.resolvedAt !== null && !currentIds.has(task.id))
      .slice(0, RECENT_TASK_LIMIT)
    // Sort only the newly assembled snapshot; previously published arrays keep their order.
    const tasks = [...current, ...history].sort(
      (left, right) => right.occurredAt - left.occurredAt || left.id.localeCompare(right.id),
    )
    changedRunIds = []
    changedRoutineIds = []
    snapshot = { changes: getChanges(), tasks, runRowid, routineRowid }
    return tasks
  }
}

const getLastRowid = (database: Database, table: "runs" | "routine_runs"): number =>
  (database.query(`SELECT COALESCE(MAX(rowid), 0) AS rowid FROM ${table}`).get() as { rowid: number }).rowid

const syncRecoveryTasks = (
  kernel: Kernel,
  store: NotificationStore,
  notifier: Notifier,
  silent: boolean,
  cursor: { runRowid: number; routineRowid: number; runIds: string[]; routineIds: string[] },
  runStage?: PerformanceStageRunner,
): RecoveryTask[] => {
  const database = kernel.db as Database
  const work = createWorkState({ database })
  const measure = <Value>(stage: Parameters<PerformanceStageRunner>[0], action: () => Value): Value =>
    runStage ? runStage(stage, action) : action()
  const runs = measure("notification_run_recovery_scan", () =>
    getRunCandidates(database, cursor.runIds, cursor.runRowid),
  )
  const journal = measure("notification_journal_recovery_scan", () => getJournalCandidates(kernel, runs))
  const routines = measure("notification_routine_recovery_scan", () =>
    getRoutineCandidates(database, runs, cursor.routineRowid, cursor.routineIds),
  )
  const candidates = [...runs, ...journal, ...routines]

  const visible = measure("notification_recovery_reconcile", () =>
    candidates.filter((candidate) => {
      const isRecorded = database.query("SELECT 1 FROM recovery_tasks WHERE id = ?").get(candidate.id) !== null
      if (isRecorded) return true
      const effects = candidate.turnId ? work.rebuild({ turnId: candidate.turnId }) : []
      if (effects.some((effect) => effect.state === "uncertain" && !effect.acknowledged)) return true
      if (candidate.journalOnly) return false
      return !hasLaterRun(database, candidate)
    }),
  )

  return measure("notification_recovery_reconcile", () => {
    const retained = expireOrphanTasks(database, store, notifier, work, visible)

    const found = visible.map((candidate) => {
      const notification = saveTaskNotification(kernel, store, notifier, candidate, silent)
      const effects = candidate.turnId ? work.rebuild({ turnId: candidate.turnId }) : []
      const hasUncertain = getRecoveryAcknowledgementKeys(database, notification.id).length > 0
      const hasLater = hasLaterRun(database, candidate)
      const isAcknowledgedJournal = candidate.journalOnly && effects.some((effect) => effect.acknowledged)
      if (!hasUncertain && (hasLater || isAcknowledgedJournal) && notification.resolvedAt === null)
        notifier.finish({ id: notification.id, resolution: "expired" })

      return {
        id: candidate.id,
        notification: store.get(notification.id) ?? notification,
        runId: candidate.runId,
        routineId: candidate.routineId,
        cause: candidate.cause,
        occurredAt: candidate.occurredAt,
        effects: [...candidate.effects, ...getJournalEffects(effects)],
      }
    })

    return [...found, ...retained]
  })
}

// A task that no scan finds anymore (its run was resumed, archived or rewritten) can never be reviewed,
// so its notification must not keep asking the person for attention. The exception is a task with
// unacknowledged uncertain effects: the notifier refuses to resolve it, so it is returned for the panel instead,
// where the person can acknowledge it. The flag and the panel then always give the same answer.
const expireOrphanTasks = (
  database: Database,
  store: NotificationStore,
  notifier: Notifier,
  work: ReturnType<typeof createWorkState>,
  found: Candidate[],
): RecoveryTask[] => {
  const foundIds = new Set(found.map((candidate) => candidate.id))
  const rows = database
    .query(`SELECT rt.id, rt.notification_id, rt.turn_id FROM recovery_tasks rt JOIN notifications n ON n.id = rt.notification_id
      WHERE n.resolved_at IS NULL`)
    .all() as Array<{ id: string; notification_id: number; turn_id: string | null }>

  return rows
    .filter((row) => !foundIds.has(row.id))
    .flatMap((row) => {
      const notification = store.get(row.notification_id)
      const resolved = notifier.finish({ id: row.notification_id, resolution: "expired" })
      if (resolved || !notification) return []

      return [
        {
          id: row.id,
          notification,
          runId: row.id.startsWith("run:") ? row.turn_id : null,
          routineId: null,
          cause: "app_restart" as const,
          occurredAt: notification.createdAt,
          effects: row.turn_id ? getJournalEffects(work.rebuild({ turnId: row.turn_id })) : [],
        },
      ]
    })
}

export const getRecoveryAcknowledgementKeys = (database: Database, notificationId: number): string[] => {
  const rows = database
    .query("SELECT turn_id FROM recovery_tasks WHERE notification_id = ? AND turn_id IS NOT NULL")
    .all(notificationId) as Array<{ turn_id: string }>
  const work = createWorkState({ database })

  return rows.flatMap((row) =>
    work
      .rebuild({ turnId: row.turn_id })
      .filter((effect) => effect.state === "uncertain" && !effect.acknowledged)
      .map((effect) => effect.key),
  )
}

const getRunCandidates = (database: Database, changedRunIds: string[], sinceRowid: number): Candidate[] => {
  const rows = database
    .query(`SELECT r.id, r.bot_id, COALESCE(t.group_thread_id, r.thread_id) AS thread_id, r.status, r.error_class, r.error_message, rr.routine_id,
      COALESCE(r.finished_at, r.started_at, r.queued_at) AS occurred_at
      FROM runs r JOIN bots b ON b.id = r.bot_id JOIN threads t ON t.id = r.thread_id
      LEFT JOIN routine_runs rr ON rr.id = r.routine_run_id
      WHERE r.id IN (
        SELECT id FROM (SELECT id FROM runs WHERE rowid > ? ORDER BY rowid DESC LIMIT ?)
        UNION SELECT value FROM json_each(?)
        UNION SELECT rt.turn_id FROM recovery_tasks rt JOIN notifications n ON n.id = rt.notification_id
          WHERE n.resolved_at IS NULL AND rt.turn_id IS NOT NULL
      ) AND r.status IN ('failed', 'interrupted') AND b.archived_at IS NULL AND t.archived_at IS NULL
      ORDER BY occurred_at DESC, r.id`)
    .all(sinceRowid, RECENT_TASK_LIMIT, JSON.stringify(changedRunIds)) as RunRow[]
  const work = createWorkState({ database })

  return rows.flatMap((row) => {
    const parts = getRunParts(database, row.id)
    const journal = work.rebuild({ turnId: row.id })
    if (row.status !== "interrupted" && !row.routine_id && !hasRecordedActions(parts) && journal.length === 0) return []

    return [
      {
        id: `run:${row.id}`,
        runId: row.id,
        turnId: row.id,
        routineId: row.routine_id,
        botId: row.bot_id,
        threadId: row.thread_id,
        cause: row.error_class,
        reason: row.error_message ?? "",
        journalOnly: false,
        occurredAt: row.occurred_at,
        effects: getPartEffects(parts),
      },
    ]
  })
}

const getRunParts = (database: Database, runId: string): MessagePart[] => {
  const rows = database
    .query("SELECT parts_json FROM messages WHERE run_id = ? ORDER BY created_at")
    .all(runId) as Array<{ parts_json: string }>
  return rows.flatMap((row) => JSON.parse(row.parts_json) as MessagePart[])
}

const getPartEffects = (parts: MessagePart[]): RecoveryTask["effects"] =>
  parts.flatMap((part) => {
    if (part.type === "command")
      return [
        { description: sanitizeDiagnostic(part.command), uncertain: part.exitCode === null, acknowledgeKey: null },
      ]
    if (part.type === "file_change")
      return part.paths.map((path) => ({
        description: sanitizeDiagnostic(path),
        uncertain: part.completedOutcome === undefined,
        acknowledgeKey: null,
      }))
    if (part.type === "tool_call")
      return [{ description: sanitizeDiagnostic(part.summary), uncertain: part.ok === null, acknowledgeKey: null }]
    return []
  })

const getJournalEffects = (
  effects: ReturnType<ReturnType<typeof createWorkState>["rebuild"]>,
): RecoveryTask["effects"] =>
  effects.map((effect) => ({
    description: sanitizeDiagnostic(effect.description),
    uncertain: effect.state === "uncertain",
    acknowledgeKey: effect.state === "uncertain" && !effect.acknowledged ? effect.key : null,
  }))

const getJournalCandidates = (kernel: Kernel, runs: Candidate[]): Candidate[] => {
  const database = kernel.db as Database
  const work = createWorkState({ database })
  const turns = database
    .query(`SELECT DISTINCT j.turn_id FROM work_journal j WHERE j.kind = 'uncertain'
      AND NOT EXISTS (SELECT 1 FROM work_journal later WHERE later.turn_id = j.turn_id
        AND later.effect_id = j.effect_id AND later.seq > j.seq
        AND later.kind IN ('result', 'acknowledged', 'uncertain'))
      UNION SELECT rt.turn_id FROM recovery_tasks rt JOIN notifications n ON n.id = rt.notification_id
        WHERE rt.id LIKE 'journal:%' AND rt.turn_id IS NOT NULL
        AND (n.resolved_at IS NULL OR rt.notification_id IN (
          SELECT notification_id FROM recovery_tasks ORDER BY notification_id DESC LIMIT ?))`)
    .all(RECENT_TASK_LIMIT) as Array<{ turn_id: string }>

  return turns.flatMap(({ turn_id: turnId }) => {
    if (runs.some((run) => run.turnId === turnId)) return []
    const effects = work.rebuild({ turnId })
    const first = effects.find((effect) => effect.state === "uncertain")
    const thread = first?.threadId ? kernel.services.use("store.api")?.getThread({ threadId: first.threadId }) : null
    if (!first || !thread) return []
    const storedRun = database.query("SELECT id FROM runs WHERE id = ?").get(turnId) !== null

    return [
      {
        id: storedRun ? `run:${turnId}` : `journal:${turnId}`,
        runId: storedRun ? turnId : null,
        turnId,
        routineId: null,
        botId: thread.botId,
        threadId: thread.id,
        cause: "app_restart" as const,
        reason: "app_restart",
        journalOnly: true,
        occurredAt: first.startedAt,
        effects: [],
      },
    ]
  })
}

const getRoutineCandidates = (
  database: Database,
  runs: Candidate[],
  sinceRowid: number,
  pendingIds: string[],
): Candidate[] => {
  const rows = database
    .query(`SELECT rr.id, rr.run_id, rr.routine_id, rr.thread_id, rr.summary, r.bot_id,
    COALESCE(rr.finished_at, rr.started_at, rr.scheduled_for) AS occurred_at
    FROM routine_runs rr JOIN routines r ON r.id = rr.routine_id JOIN bots b ON b.id = r.bot_id
    WHERE rr.id IN (
      SELECT id FROM (SELECT id FROM routine_runs WHERE rowid > ? ORDER BY rowid DESC LIMIT ?)
      UNION SELECT value FROM json_each(?)
      UNION SELECT SUBSTR(rt.id, 9) FROM recovery_tasks rt JOIN notifications n ON n.id = rt.notification_id
        WHERE rt.id LIKE 'routine:%' AND n.resolved_at IS NULL
    ) AND rr.status = 'failed' AND b.archived_at IS NULL ORDER BY occurred_at DESC, rr.id`)
    .all(sinceRowid, RECENT_TASK_LIMIT, JSON.stringify(pendingIds)) as Array<{
    id: string
    run_id: string | null
    summary: string | null
    routine_id: string
    thread_id: string | null
    bot_id: string
    occurred_at: number
  }>

  return rows
    .filter((row) => !runs.some((run) => run.runId === row.run_id))
    .map((row) => ({
      id: `routine:${row.id}`,
      runId: row.run_id,
      turnId: row.run_id,
      routineId: row.routine_id,
      botId: row.bot_id,
      threadId: row.thread_id,
      cause: null,
      reason: row.summary ?? "",
      journalOnly: false,
      occurredAt: row.occurred_at,
      effects: [],
    }))
}

const saveTaskNotification = (
  kernel: Kernel,
  store: NotificationStore,
  notifier: Notifier,
  candidate: Candidate,
  silent: boolean,
) => {
  const database = kernel.db as Database
  const linked = database.query("SELECT notification_id FROM recovery_tasks WHERE id = ?").get(candidate.id) as {
    notification_id: number
  } | null
  const existing = linked ? store.get(linked.notification_id) : null
  const effects = candidate.turnId ? createWorkState({ database }).rebuild({ turnId: candidate.turnId }) : []
  const pendingEffects = effects.filter((effect) => effect.state === "uncertain" && !effect.acknowledged)
  const hasUncertain = pendingEffects.length > 0
  if (existing && (existing.resolvedAt === null || !hasUncertain)) return existing

  const matched = database
    .query(`SELECT id FROM notifications WHERE bot_id = ? AND thread_id IS ?
    AND kind IN ('turn-failed', 'routine-failed') AND ABS(created_at - ?) < 2000
    AND id NOT IN (SELECT notification_id FROM recovery_tasks) ORDER BY ABS(created_at - ?) LIMIT 1`)
    .get(candidate.botId, candidate.threadId, candidate.occurredAt, candidate.occurredAt) as { id: number } | null
  const previous = matched ? store.get(matched.id) : null
  const reusable = !existing && previous && (!hasUncertain || previous.resolvedAt === null) ? previous : null
  const requestId = existing
    ? `recovery:${candidate.id}:${pendingEffects.map((effect) => effect.effectId).join(":")}`
    : `recovery:${candidate.id}`
  const notification =
    reusable ??
    notifier.emit(
      {
        kind: candidate.routineId ? "routine-failed" : "turn-failed",
        botId: candidate.botId,
        threadId: candidate.threadId,
        requestId,
        title: "Tarefas interrompidas",
        body: safeRunFailure(candidate.cause, candidate.reason).detail,
      },
      { silent },
    )
  database
    .query(`INSERT INTO recovery_tasks (id, notification_id, turn_id) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET notification_id = excluded.notification_id, turn_id = excluded.turn_id`)
    .run(candidate.id, notification.id, candidate.turnId)
  database
    .query("UPDATE notifications SET request_id = ? WHERE id = ? AND request_id IS NULL")
    .run(`recovery:${candidate.id}`, notification.id)
  const saved = store.get(notification.id) ?? notification
  kernel.publish({ type: "notification.created", notification: saved })
  return saved
}

const hasLaterRun = (database: Database, candidate: Candidate): boolean => {
  const hasLaterRoutineRun =
    candidate.routineId !== null &&
    database
      .query(`SELECT 1 FROM routine_runs WHERE routine_id = ?
    AND status IN ('running', 'succeeded') AND COALESCE(started_at, scheduled_for) > ? LIMIT 1`)
      .get(candidate.routineId, candidate.occurredAt) !== null
  if (hasLaterRoutineRun) return true

  return (
    database
      .query(`SELECT 1 FROM runs WHERE bot_id = ?
    AND thread_id = COALESCE((SELECT thread_id FROM runs WHERE id = ?), ?)
    AND COALESCE(started_at, queued_at) > ? LIMIT 1`)
      .get(candidate.botId, candidate.runId, candidate.threadId, candidate.occurredAt) !== null
  )
}
