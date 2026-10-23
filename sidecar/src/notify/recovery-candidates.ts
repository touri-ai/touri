import type { Database } from "bun:sqlite"
import type { MessagePart, RecoveryTask, RunErrorClass } from "@touri/contracts"
import { hasRecordedActions, sanitizeDiagnostic } from "@touri/contracts/run-failure"
import { createWorkState } from "../runtime/work-state"

export type Candidate = Omit<RecoveryTask, "notification"> & {
  members?: Array<{ id: string; turnId: string }>
  botId: string
  threadId: string | null
  turnId: string | null
  reason: string
  journalOnly: boolean
  journal: ReturnType<ReturnType<typeof createWorkState>["rebuild"]>
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

export const RECENT_TASK_LIMIT = 100

export type RecoveryCursor = { runRowid: number; routineRowid: number; runIds: string[]; routineIds: string[] }

export const RUN_PARTS_SQL = "SELECT parts_json FROM messages WHERE run_id = ? ORDER BY created_at"

export const JOURNAL_RECOVERY_SQL = `SELECT DISTINCT j.turn_id FROM work_journal j WHERE j.kind = 'uncertain'
      AND NOT EXISTS (SELECT 1 FROM work_journal later WHERE later.turn_id = j.turn_id
        AND later.effect_id = j.effect_id AND later.seq > j.seq
        AND later.kind IN ('result', 'acknowledged', 'uncertain'))
      UNION SELECT rt.turn_id FROM recovery_tasks rt JOIN notifications n ON n.id = rt.notification_id
        WHERE rt.id LIKE 'journal:%' AND rt.turn_id IS NOT NULL
        AND (n.resolved_at IS NULL OR rt.notification_id IN (
          SELECT notification_id FROM recovery_tasks ORDER BY notification_id DESC LIMIT ?))`

/** Read-only discovery runs in the owned helper process, including historical JSON and journal replay. */
export const getRecoveryCandidates = (database: Database, cursor: RecoveryCursor): Candidate[] => {
  const runs = getRunCandidates(database, cursor.runIds, cursor.runRowid)
  const journal = getJournalCandidates(database, runs)
  const routines = getRoutineCandidates(database, runs, cursor.routineRowid, cursor.routineIds)

  return getLogicalCandidates(database, [...runs, ...journal, ...routines])
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
        journal,
        occurredAt: row.occurred_at,
        effects: getPartEffects(parts),
      },
    ]
  })
}

const getRunParts = (database: Database, runId: string): MessagePart[] => {
  const rows = database.query(RUN_PARTS_SQL).all(runId) as Array<{ parts_json: string }>
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

const getJournalCandidates = (database: Database, runs: Candidate[]): Candidate[] => {
  const work = createWorkState({ database })
  const turns = database.query(JOURNAL_RECOVERY_SQL).all(RECENT_TASK_LIMIT) as Array<{ turn_id: string }>

  return turns.flatMap(({ turn_id: turnId }) => {
    if (runs.some((run) => run.turnId === turnId)) return []
    const effects = work.rebuild({ turnId })
    const first = effects.find((effect) => effect.state === "uncertain")
    const thread = first?.threadId
      ? (database
          .query(`SELECT id, bot_id AS botId FROM threads WHERE id=? AND archived_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM bot_deletions WHERE bot_id=threads.bot_id AND phase <> 'stopping')`)
          .get(first.threadId) as {
          id: string
          botId: string
        } | null)
      : null
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
        journal: effects,
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
      journal: row.run_id ? createWorkState({ database }).rebuild({ turnId: row.run_id }) : [],
      occurredAt: row.occurred_at,
      effects: [],
    }))
}

// Group identity comes only from persisted execution links, never presentation or timestamps.
const getLogicalCandidates = (database: Database, candidates: Candidate[]): Candidate[] => {
  const groups = new Map<string, Candidate[]>()
  candidates.forEach((candidate) => {
    const link = candidate.runId
      ? (database.query("SELECT turn_id FROM group_run_links WHERE run_id = ?").get(candidate.runId) as {
          turn_id: string
        } | null)
      : null
    const key = link ? `run:${link.turn_id}` : candidate.id
    groups.set(key, [...(groups.get(key) ?? []), candidate])
  })

  return [...groups.entries()].flatMap(([key, members]) => {
    const root = getGroupCandidate(database, key, members)
    if (!root) return members
    const linked = database.query("SELECT run_id FROM group_run_links WHERE turn_id=?").all(root.runId) as Array<{
      run_id: string
    }>
    const turnIds = [...new Set([root.runId, ...linked.map((link) => link.run_id)])].filter(
      (id): id is string => id !== null,
    )
    const hasPersonNotice = turnIds.some(
      (turnId) =>
        database
          .query(`SELECT 1 FROM recovery_tasks rt
      JOIN notifications n ON n.id=rt.notification_id WHERE rt.id=? AND n.target_person_id IS NOT NULL LIMIT 1`)
          .get(`run:${turnId}`) !== null,
    )
    if (hasPersonNotice) return members

    const work = createWorkState({ database })
    return [
      {
        ...root,
        members: turnIds.map((turnId) => ({ id: `run:${turnId}`, turnId })),
        journal: turnIds.flatMap((turnId) => work.rebuild({ turnId })),
        effects: turnIds.flatMap((turnId) => getPartEffects(getRunParts(database, turnId))),
      },
    ]
  })
}

const getGroupCandidate = (database: Database, key: string, members: Candidate[]): Candidate | undefined => {
  const first = members[0]
  if (!first || !key.startsWith("run:")) return undefined
  const row = database
    .query(`SELECT r.id, r.bot_id, r.thread_id FROM group_turns g
    JOIN runs r ON r.id=g.run_id JOIN threads t ON t.id=r.thread_id JOIN bots b ON b.id=r.bot_id
    WHERE g.run_id=? AND t.archived_at IS NULL AND b.archived_at IS NULL`)
    .get(key.slice(4)) as { id: string; bot_id: string; thread_id: string } | null
  if (!row) return undefined

  return (
    members.find((member) => member.id === key) ?? {
      ...first,
      id: key,
      runId: row.id,
      turnId: row.id,
      botId: row.bot_id,
      threadId: row.thread_id,
    }
  )
}
