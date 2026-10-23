import { Database } from "bun:sqlite"
import { type Id, type MessagePart, type RunErrorClass, toolCatalog } from "@touri/contracts"
import { CRASH_ERROR_CLASSES } from "./continuations"

export type AutomaticResumeJob = {
  runId: Id
  originalRunId: Id
  reason: "app_restart" | "provider_crash"
  dueAt: number
  state: "pending" | "started" | "abandoned"
}

type JobRow = {
  run_id: string
  original_run_id: string
  reason: AutomaticResumeJob["reason"]
  due_at: number
  state: AutomaticResumeJob["state"]
}

export const createAutomaticResumeStore = (database: unknown) => {
  const db = database instanceof Database ? database : null
  const jobs = new Map<Id, AutomaticResumeJob>()
  const getJob = (runId: Id): AutomaticResumeJob | null => {
    if (!db) return jobs.get(runId) ?? null
    const row = db.query("SELECT * FROM automatic_resume_jobs WHERE run_id = ?").get(runId) as JobRow | null
    return row ? getJobFromRow(row) : null
  }
  const saveJob = (job: AutomaticResumeJob): void => {
    if (!db) {
      jobs.set(job.runId, job)
      return
    }
    db.query(
      `INSERT INTO automatic_resume_jobs(run_id, original_run_id, reason, due_at, state) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET state = excluded.state`,
    ).run(job.runId, job.originalRunId, job.reason, job.dueAt, job.state)
  }
  const getPending = (afterRunId = ""): AutomaticResumeJob[] => {
    if (!db) {
      // Sort a disposable page, never the shared job map.
      return [...jobs.values()]
        .filter((job) => job.state === "pending" && job.runId > afterRunId)
        .sort((first, second) => first.runId.localeCompare(second.runId))
        .slice(0, 100)
    }
    return (
      db
        .query("SELECT * FROM automatic_resume_jobs WHERE state = 'pending' AND run_id > ? ORDER BY run_id LIMIT 100")
        .all(afterRunId) as JobRow[]
    ).map(getJobFromRow)
  }

  return { getJob, saveJob, getPending }
}

const getJobFromRow = (row: JobRow): AutomaticResumeJob => ({
  runId: row.run_id,
  originalRunId: row.original_run_id,
  reason: row.reason,
  dueAt: row.due_at,
  state: row.state,
})

export const canAutomaticallyResumeFailure = (errorClass: RunErrorClass, diagnostic: string): boolean => {
  const detail = diagnostic.slice(0, 2_000)
  if (
    /permission denied|operation not permitted|EACCES|EPERM|unauthorized|invalid (?:api key|credential)|authentication|login required/i.test(
      detail,
    )
  )
    return false
  if (CRASH_ERROR_CLASSES.includes(errorClass)) return true
  if (errorClass !== "cli_protocol" && errorClass !== "unknown") return false
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|network (?:error|unavailable)|connection (?:reset|lost|closed)|socket hang up|fetch failed/i.test(
    detail,
  )
}

// Only trusted read definitions qualify; provider output cannot declare a write safe to repeat.
const safeReadTools = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "WebFetch",
  "WebSearch",
  ...toolCatalog.tools
    .filter((tool) => tool["x-touri"].mutates === false)
    .flatMap((tool) => [tool.name, `mcp__touri__${tool.name}`]),
])

export const hasUnsafeResumeActions = (parts: ReadonlyArray<MessagePart>): boolean =>
  parts.some((part) => {
    if (part.type === "command" || part.type === "file_change") return true
    if (part.type !== "tool_call") return false

    return part.ok !== true || !safeReadTools.has(part.tool)
  })
