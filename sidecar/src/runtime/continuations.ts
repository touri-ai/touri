import { Database } from "bun:sqlite"
import type { Id, RunErrorClass } from "@touri/contracts"

/**
 * Automatic continuation of interrupted turns. A turn cut off by a restart, a provider crash or a
 * stopped bot computer is continued in the same provider session by a new run whose request is a
 * visible marker in the thread. Every continuation is linked to the turn it continues, which bounds
 * how many times one original turn is continued.
 */

export type ContinuationReason = "app_restart" | "provider_crash"

/** At most this many automatic continuations per original turn. */
export const MAX_AUTO_CONTINUATIONS = 2
/** A provider or bot computer that dies mid-turn is resumed once per original turn. */
export const MAX_CRASH_CONTINUATIONS = 1
/** Only turns that were still active this recently are continued after a restart. */
export const CONTINUATION_WINDOW_MS = 6 * 60 * 60_000
/** Delay before resuming after the provider process or the bot computer died. */
export const CRASH_RESUME_BACKOFF_MS = 3_000
/** Provider failures that mean the process ended without a result, not that the request failed. */
export const CRASH_ERROR_CLASSES: ReadonlyArray<RunErrorClass> = ["cli_crash", "oom", "machine_service_unavailable"]

export const continuationMarkers: Record<ContinuationReason, string> = {
  app_restart: "Retomado após reinício do touri",
  provider_crash: "Retomado após falha do provedor",
}

const reasonDetails: Record<ContinuationReason, string> = {
  app_restart: "touri restarted",
  provider_crash: "the provider process or the bot computer stopped unexpectedly",
}

/** Reads the continuation reason back from a marker's text; null for any other message. */
export const continuationReasonOf = (text: string): ContinuationReason | null => {
  const entry = Object.entries(continuationMarkers).find(([, marker]) => marker === text)
  return entry ? (entry[0] as ContinuationReason) : null
}

/** The instruction sent to the provider in place of the marker's text. */
export const continuationPrompt = (reason: ContinuationReason): string =>
  [
    `[touri: your previous turn was cut off before it finished (${reasonDetails[reason]}).`,
    "This is an automatic continuation of the same task, not a new request.",
    "Before repeating any action, check the current state (files, running processes, recorded work and tool results) and do not redo steps that already took effect.",
    "Then continue the user's original request from where it stopped.]",
  ].join(" ")

export type ResumePoint = { externalSessionId: string; rolloutPath: string | null; fingerprint: string }

export type ContinuationLink = {
  runId: Id
  originalRunId: Id
  previousRunId: Id
  reason: ContinuationReason
  createdAt: number
}

export type RunContinuations = {
  saveResumePoint: (args: { runId: Id; point: ResumePoint }) => void
  resumePoint: (runId: Id) => ResumePoint | null
  record: (link: ContinuationLink) => void
  link: (runId: Id) => ContinuationLink | null
  count: (args: { originalRunId: Id; reason?: ContinuationReason }) => number
  isGroupRun: (runId: Id) => boolean
  recentlyInterrupted: (since: number) => Array<Id>
}

type PointRow = { external_session_id: string; rollout_path: string | null; fingerprint: string }
type LinkRow = { run_id: string; original_run_id: string; previous_run_id: string; reason: string; created_at: number }

const toLink = (row: LinkRow | null): ContinuationLink | null =>
  row && (row.reason === "app_restart" || row.reason === "provider_crash")
    ? {
        runId: row.run_id,
        originalRunId: row.original_run_id,
        previousRunId: row.previous_run_id,
        reason: row.reason,
        createdAt: row.created_at,
      }
    : null

/** Opens the continuation records over the migrated database, or in memory when there is none. */
export const createRunContinuations = ({ database }: { database: unknown }): RunContinuations => {
  const db = database instanceof Database ? database : null
  const points = new Map<Id, ResumePoint>()
  const links = new Map<Id, ContinuationLink>()

  const attempt = <T>(action: (db: Database) => T, fallback: () => T): T => {
    if (!db) return fallback()
    try {
      return action(db)
    } catch {
      return fallback()
    }
  }

  const saveResumePoint: RunContinuations["saveResumePoint"] = ({ runId, point }) => {
    points.set(runId, point)
    attempt(
      (db) =>
        db
          .query(
            `INSERT INTO run_resume_points (run_id, external_session_id, rollout_path, fingerprint, updated_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(run_id) DO UPDATE SET external_session_id = excluded.external_session_id,
             rollout_path = excluded.rollout_path, fingerprint = excluded.fingerprint, updated_at = excluded.updated_at`,
          )
          .run(runId, point.externalSessionId, point.rolloutPath, point.fingerprint, Date.now()),
      () => undefined,
    )
  }

  const resumePoint: RunContinuations["resumePoint"] = (runId) =>
    attempt(
      (db) => {
        const row = db
          .query("SELECT external_session_id, rollout_path, fingerprint FROM run_resume_points WHERE run_id = ?")
          .get(runId) as PointRow | null
        return row
          ? { externalSessionId: row.external_session_id, rolloutPath: row.rollout_path, fingerprint: row.fingerprint }
          : null
      },
      () => points.get(runId) ?? null,
    )

  const record: RunContinuations["record"] = (link) => {
    links.set(link.runId, link)
    attempt(
      (db) =>
        db
          .query(
            "INSERT OR IGNORE INTO run_continuations (run_id, original_run_id, previous_run_id, reason, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(link.runId, link.originalRunId, link.previousRunId, link.reason, link.createdAt),
      () => undefined,
    )
  }

  const link: RunContinuations["link"] = (runId) =>
    attempt(
      (db) => toLink(db.query("SELECT * FROM run_continuations WHERE run_id = ?").get(runId) as LinkRow | null),
      () => links.get(runId) ?? null,
    )

  const count: RunContinuations["count"] = ({ originalRunId, reason }) =>
    attempt(
      (db) =>
        (
          db
            .query(
              "SELECT COUNT(*) AS n FROM run_continuations WHERE original_run_id = ? AND (? IS NULL OR reason = ?)",
            )
            .get(originalRunId, reason ?? null, reason ?? null) as { n: number }
        ).n,
      () =>
        [...links.values()].filter(
          (item) => item.originalRunId === originalRunId && (reason === undefined || item.reason === reason),
        ).length,
    )

  const isGroupRun: RunContinuations["isGroupRun"] = (runId) =>
    attempt(
      (db) =>
        db
          .query(
            "SELECT 1 FROM group_turns WHERE run_id = ? UNION ALL SELECT 1 FROM group_run_links WHERE run_id = ? LIMIT 1",
          )
          .get(runId, runId) !== null,
      () => false,
    )

  // Turns a previous runtime interrupted while quitting, which nothing has continued yet.
  const recentlyInterrupted: RunContinuations["recentlyInterrupted"] = (since) =>
    attempt(
      (db) =>
        (
          db
            .query(
              `SELECT id FROM runs WHERE status = 'interrupted' AND error_class = 'app_restart' AND finished_at >= ?
               AND id NOT IN (SELECT previous_run_id FROM run_continuations) ORDER BY finished_at`,
            )
            .all(since) as Array<{ id: string }>
        ).map((row) => row.id),
      () => [],
    )

  return { saveResumePoint, resumePoint, record, link, count, isGroupRun, recentlyInterrupted }
}
