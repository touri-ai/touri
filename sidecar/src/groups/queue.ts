import type { Database } from "bun:sqlite"
import type { Run } from "@touri/contracts"

/** Indexed by turn ID; each roster has at most twenty members. */
export const getPendingGroupBotIds = (db: Database, run: Pick<Run, "id" | "kind" | "status">): string[] | undefined => {
  if (run.kind !== "coordination") return undefined
  if (!["queued", "starting", "running"].includes(run.status)) return []

  const turn = db.query("SELECT recipients_json FROM group_turns WHERE run_id = ?").get(run.id) as {
    recipients_json: string
  } | null
  if (!turn) return []

  const dispatched = db
    .query("SELECT r.bot_id FROM group_run_links l JOIN runs r ON r.id = l.run_id WHERE l.turn_id = ? AND l.depth = 0")
    .all(run.id) as { bot_id: string }[]
  const botIds = new Set(dispatched.map((member) => member.bot_id).concat(getRecoveredGroupBotIds(db, run.id)))

  return (JSON.parse(turn.recipients_json) as string[]).filter((botId) => !botIds.has(botId))
}

const getRecoveredGroupBotIds = (db: Database, runId: string): string[] => {
  const continuation = db.query("SELECT original_run_id FROM run_continuations WHERE run_id = ?").get(runId) as {
    original_run_id: string
  } | null
  if (!continuation) return []

  // A continuation chain is capped by MAX_AUTO_CONTINUATIONS; completed peers are never re-enqueued.
  const completed = db
    .query(`SELECT r.bot_id FROM group_run_links l JOIN runs r ON r.id = l.run_id
    WHERE l.depth = 0 AND r.status = 'succeeded' AND l.turn_id IN (
      SELECT ? UNION SELECT run_id FROM run_continuations WHERE original_run_id = ?
    )`)
    .all(continuation.original_run_id, continuation.original_run_id) as { bot_id: string }[]

  return completed.map((member) => member.bot_id)
}
