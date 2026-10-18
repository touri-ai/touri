import type { Database } from "bun:sqlite"
import type { ImportReport, Kernel, LegacyImportOptions, RouteResponse } from "@touri/contracts"
import { createBackgroundTask } from "../kernel/background-task"
import type { PerformanceStageRunner } from "../kernel/performance"
import { DEPRECATED_IMPORT_ALIAS } from "./deprecatedAliases"
import { cleanupExpiredLegacyStaging, runLegacyImport } from "./legacy/import"

type Job = { status: "running" | "succeeded" | "failed"; report: ImportReport | null }

const jobs = new Map<string, Job>()

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null)
const asBoolean = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback)

const parseOptions = (value: unknown): LegacyImportOptions | null => {
  const row = asRecord(value)
  const source = asRecord(row?.source)
  if (!row || !source) return null
  const kind = asString(source.kind)
  if (kind === "local") {
    const root = asString(source.root)
    if (!root) return null
    return {
      source: { kind: "local", root },
      botIds: Array.isArray(row.botIds) ? row.botIds.filter((item): item is string => typeof item === "string") : [],
      importCodexSessions: asBoolean(row.importCodexSessions, false),
      cwdMap: parseCwdMap(row.cwdMap),
      includeAttachments: asBoolean(row.includeAttachments, true),
      dryRun: asBoolean(row.dryRun, false),
    }
  }
  if (kind !== "ssh") return null
  const host = asString(source.host)
  const user = asString(source.user)
  const root = asString(source.root)
  if (!host || !user || !root) return null
  const port = typeof source.port === "number" && Number.isInteger(source.port) ? source.port : undefined
  return {
    source: port === undefined ? { kind: "ssh", host, user, root } : { kind: "ssh", host, user, port, root },
    botIds: Array.isArray(row.botIds) ? row.botIds.filter((item): item is string => typeof item === "string") : [],
    importCodexSessions: asBoolean(row.importCodexSessions, false),
    cwdMap: parseCwdMap(row.cwdMap),
    includeAttachments: asBoolean(row.includeAttachments, true),
    dryRun: asBoolean(row.dryRun, false),
  }
}

const parseCwdMap = (value: unknown): LegacyImportOptions["cwdMap"] => {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const row = asRecord(item)
    const from = asString(row?.from)
    const to = asString(row?.to)
    if (!from || !to) return []
    const projectId = asString(row?.projectId)
    return projectId ? [{ from, to, projectId }] : [{ from, to }]
  })
}

const failureReport = ({ importId, error }: { importId: string; error: string }): ImportReport => ({
  importId,
  origin: "",
  dryRun: false,
  bots: { created: 0, updated: 0, unchanged: 0, skipped: 0 },
  threads: { created: 0, updated: 0, unchanged: 0, skipped: 0 },
  messages: { created: 0, updated: 0, unchanged: 0, skipped: 0 },
  routines: { created: 0, updated: 0, unchanged: 0, skipped: 0 },
  attachments: { created: 0, updated: 0, unchanged: 0, skipped: 0 },
  codexSessions: { created: 0, updated: 0, unchanged: 0, skipped: 0 },
  memoryFiles: { created: 0, updated: 0, unchanged: 0, skipped: 0 },
  droppedMessageKinds: {},
  warnings: [error],
})

const startJob = ({
  kernel,
  importId,
  options,
}: {
  kernel: Kernel
  importId: string
  options: LegacyImportOptions
}): void => {
  void runLegacyImport({ kernel, importId, options })
    .then(({ report }) => {
      jobs.set(importId, { status: "succeeded", report })
      kernel.publish({ type: "import.progress", importId, phase: "complete", done: 1, total: 1 })
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      let report = failureReport({ importId, error: message })
      try {
        const database = kernel.db as Database
        const stored = database.query("SELECT report_json FROM imports WHERE id = ?").get(importId) as {
          report_json: string | null
        } | null
        if (stored?.report_json) report = JSON.parse(stored.report_json) as ImportReport
        database
          .query("UPDATE imports SET status = 'failed', report_json = ?, finished_at = ? WHERE id = ?")
          .run(JSON.stringify(report), Date.now(), importId)
      } catch {
        // The in-memory job remains authoritative when the database is unavailable.
      }
      jobs.set(importId, { status: "failed", report })
      kernel.log({ level: "error", module: "importer", msg: "legacy app import failed", data: { error: message } })
      kernel.publish({ type: "import.progress", importId, phase: "failed", done: 1, total: 1 })
    })
}

const readStoredJob = ({ kernel, importId }: { kernel: Kernel; importId: string }): Job | null => {
  const row = (kernel.db as Database).query("SELECT status, report_json FROM imports WHERE id = ?").get(importId) as {
    status: Job["status"]
    report_json: string | null
  } | null
  if (!row) return null
  return { status: row.status, report: row.report_json ? (JSON.parse(row.report_json) as ImportReport) : null }
}

export const scheduleLegacyExpiry = (
  kernel: Kernel,
  intervalMs = 60_000,
  runStage?: PerformanceStageRunner,
): (() => void) => {
  const task = createBackgroundTask(
    "import_staging_expiry",
    async () => {
      await cleanupExpiredLegacyStaging({ kernel, runStage })
    },
    runStage,
  )
  const timer = setInterval(() => {
    void task.run().catch(() => {
      const database = kernel.db as Database
      try {
        database.query("SELECT 1").get()
      } catch {
        clearInterval(timer)
        task.dispose()
        return
      }
      kernel.log({ level: "error", module: "importer", msg: "Failed to expire import snapshots; cleanup will retry" })
    })
  }, intervalMs)
  timer.unref()
  return () => {
    clearInterval(timer)
    task.dispose()
  }
}

export const init = async (kernel: Kernel, runStage?: PerformanceStageRunner): Promise<void> => {
  const startImport = async ({ body }: { body: unknown }): Promise<RouteResponse> => {
    const options = parseOptions(body)
    if (!options)
      return { status: 400, json: { errorCode: "INVALID_ARGS", error: "Invalid legacy app import options" } }
    const importId = kernel.newId()
    jobs.set(importId, { status: "running", report: null })
    kernel.publish({ type: "import.progress", importId, phase: "starting", done: 0, total: 1 })
    startJob({ kernel, importId, options })
    return { status: 202, json: { importId } }
  }
  await cleanupExpiredLegacyStaging({ kernel, runStage })
  const stopExpiry = scheduleLegacyExpiry(kernel, 60_000, runStage)
  kernel.onHostNotification((notification) => {
    if (notification.method === "app.willQuit") stopExpiry()
  })
  kernel.registerRoutes({
    name: "importer",
    routes: [
      { method: "POST", path: "/imports/legacy", handler: startImport },
      { method: "POST", path: `/imports/${DEPRECATED_IMPORT_ALIAS}`, handler: startImport },
      {
        method: "GET",
        path: "/imports/:id",
        handler: async ({ params }): Promise<RouteResponse> => {
          const importId = params.id
          if (!importId) return { status: 400, json: { errorCode: "INVALID_ARGS", error: "Missing import id" } }
          const job = jobs.get(importId) ?? readStoredJob({ kernel, importId })
          if (!job) return { status: 404, json: { errorCode: "NOT_FOUND", error: "Import not found" } }
          return { status: 200, json: job }
        },
      },
    ],
  })
}

export { parseOptions }
