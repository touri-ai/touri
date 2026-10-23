import { Database } from "bun:sqlite"
import type { Id, RunErrorClass } from "@touri/contracts"

/**
 * Automatic continuation of interrupted turns and approved configuration changes. Each continuation
 * is linked to the turn it continues and uses a visible system marker as its request.
 */

export type ContinuationReason = "app_restart" | "provider_crash" | "permission_granted" | "browser_takeover"

/** At most this many interrupted-turn continuations per original turn. */
export const MAX_AUTO_CONTINUATIONS = 2
/** A provider or bot computer that dies mid-turn is resumed at most twice per original turn. */
export const MAX_CRASH_CONTINUATIONS = 2
/** Only turns that were still active this recently are continued after a restart. */
export const CONTINUATION_WINDOW_MS = 6 * 60 * 60_000
/** Delay before resuming after the provider process or the bot computer died. */
export const CRASH_RESUME_BACKOFF_MS = 60_000
/** Provider failures that mean the process ended without a result, not that the request failed. */
export const CRASH_ERROR_CLASSES: ReadonlyArray<RunErrorClass> = [
  "cli_crash",
  "oom",
  "machine_service_unavailable",
  "timeout",
]

export const continuationMarkers: Record<ContinuationReason, string> = {
  app_restart: "Retomado após reinício do touri",
  provider_crash: "Retomado após falha do provedor",
  permission_granted: "Retomado após aprovação de acesso",
  browser_takeover: "Retomado após a devolução do navegador",
}

const reasonDetails: Record<ContinuationReason, string> = {
  app_restart: "touri restarted",
  provider_crash: "the provider process or the bot computer stopped unexpectedly",
  permission_granted: "approved access requires a new provider turn",
  browser_takeover: "the person returned control of the browser",
}

/** Reads the continuation reason back from a marker's text; null for any other message. */
export const continuationReasonOf = (text: string): ContinuationReason | null => {
  const entry = Object.entries(continuationMarkers).find(([, marker]) => marker === text)
  return entry ? (entry[0] as ContinuationReason) : null
}

/** The instruction sent to the provider in place of the marker's text. */
const getContinuationIntro = (reason: ContinuationReason): string => {
  if (reason === "permission_granted")
    return "[touri: the user approved access during the previous turn. The approved configuration is now applied."
  if (reason === "browser_takeover")
    return "[touri: the person returned control of the browser after a private handoff."

  return `[touri: your previous turn was cut off before it finished (${reasonDetails[reason]}).`
}

export const continuationPrompt = (reason: ContinuationReason): string =>
  [
    getContinuationIntro(reason),
    "This is an automatic continuation of the same task, not a new request.",
    "Before repeating any action, check the current state (files, running processes, recorded work and tool results) and do not redo steps that already took effect.",
    "Then continue the user's original request from where it stopped.]",
    ...(reason === "permission_granted"
      ? [
          "Use only the approved scope; do not request the same access again or ask the user to send a continuation message.",
        ]
      : []),
    ...(reason === "browser_takeover"
      ? ["Check the current page and tool results, then continue the same request without repeating completed actions."]
      : []),
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
  hasPrevious: (args: { previousRunId: Id; reason: ContinuationReason }) => boolean
  isGroupRun: (runId: Id) => boolean
  recentlyInterrupted: (since: number) => Array<Id>
}

type PointRow = { external_session_id: string; rollout_path: string | null; fingerprint: string }
type LinkRow = { run_id: string; original_run_id: string; previous_run_id: string; reason: string; created_at: number }
type BrowserLinkRow = Omit<LinkRow, "reason">

const toLink = (row: LinkRow | null): ContinuationLink | null => {
  if (!row) return null
  if (
    row.reason !== "app_restart" &&
    row.reason !== "provider_crash" &&
    row.reason !== "permission_granted" &&
    row.reason !== "browser_takeover"
  )
    return null

  return {
    runId: row.run_id,
    originalRunId: row.original_run_id,
    previousRunId: row.previous_run_id,
    reason: row.reason,
    createdAt: row.created_at,
  }
}

const toBrowserLink = (row: BrowserLinkRow | null): ContinuationLink | null => {
  if (!row) return null

  return {
    runId: row.run_id,
    originalRunId: row.original_run_id,
    previousRunId: row.previous_run_id,
    reason: "browser_takeover",
    createdAt: row.created_at,
  }
}

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
      (db) => {
        if (link.reason === "browser_takeover")
          db.query(
            "INSERT OR IGNORE INTO browser_takeover_continuations (run_id, original_run_id, previous_run_id, created_at) VALUES (?, ?, ?, ?)",
          ).run(link.runId, link.originalRunId, link.previousRunId, link.createdAt)
        else
          db.query(
            "INSERT OR IGNORE INTO run_continuations (run_id, original_run_id, previous_run_id, reason, created_at) VALUES (?, ?, ?, ?, ?)",
          ).run(link.runId, link.originalRunId, link.previousRunId, link.reason, link.createdAt)
      },
      () => undefined,
    )
  }

  const link: RunContinuations["link"] = (runId) =>
    attempt(
      (db) => {
        const row = db.query("SELECT * FROM run_continuations WHERE run_id = ?").get(runId) as LinkRow | null
        if (row) return toLink(row)
        return toBrowserLink(
          db
            .query(
              "SELECT run_id, original_run_id, previous_run_id, created_at FROM browser_takeover_continuations WHERE run_id = ?",
            )
            .get(runId) as BrowserLinkRow | null,
        )
      },
      () => links.get(runId) ?? null,
    )

  const count: RunContinuations["count"] = ({ originalRunId, reason }) =>
    attempt(
      (db) => {
        if (reason === "browser_takeover")
          return (
            db
              .query("SELECT COUNT(*) AS n FROM browser_takeover_continuations WHERE original_run_id = ?")
              .get(originalRunId) as { n: number }
          ).n
        const regular = (
          db
            .query(
              "SELECT COUNT(*) AS n FROM run_continuations WHERE original_run_id = ? AND (? IS NULL OR reason = ?)",
            )
            .get(originalRunId, reason ?? null, reason ?? null) as { n: number }
        ).n
        if (reason) return regular
        const browser = (
          db
            .query("SELECT COUNT(*) AS n FROM browser_takeover_continuations WHERE original_run_id = ?")
            .get(originalRunId) as { n: number }
        ).n
        return regular + browser
      },
      () =>
        [...links.values()].filter(
          (item) => item.originalRunId === originalRunId && (reason === undefined || item.reason === reason),
        ).length,
    )

  const hasPrevious: RunContinuations["hasPrevious"] = ({ previousRunId, reason }) =>
    attempt(
      (db) =>
        reason === "browser_takeover"
          ? db
              .query("SELECT 1 FROM browser_takeover_continuations WHERE previous_run_id = ? LIMIT 1")
              .get(previousRunId) !== null
          : db
              .query("SELECT 1 FROM run_continuations WHERE previous_run_id = ? AND reason = ? LIMIT 1")
              .get(previousRunId, reason) !== null,
      () => [...links.values()].some((item) => item.previousRunId === previousRunId && item.reason === reason),
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
               AND id NOT IN (SELECT previous_run_id FROM run_continuations UNION SELECT previous_run_id FROM browser_takeover_continuations)
               ORDER BY finished_at`,
            )
            .all(since) as Array<{ id: string }>
        ).map((row) => row.id),
      () => [],
    )

  return { saveResumePoint, resumePoint, record, link, count, hasPrevious, isGroupRun, recentlyInterrupted }
}
