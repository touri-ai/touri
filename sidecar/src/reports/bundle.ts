import type { Database } from "bun:sqlite"
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs"
import { arch, cpus, freemem, homedir, platform, release, totalmem } from "node:os"
import { join } from "node:path"
import {
  githubReportUrl,
  type Kernel,
  type ReportInput,
  type ReportSnapshot,
  redactReportText,
  redactReportValue,
  reportSummary,
} from "@touri/contracts"
import packageInfo from "../../../package.json"
import { SCHEMA_VERSION } from "../kernel/db"

export type ReportProcess = { pid: number; parentPid: number; rssBytes: number; executable: string }

/** Only this OS user's touri tree; another macOS account's touri never enters a report. */
export const ownTouriProcesses = ({
  output,
  uid,
  rootPid,
}: {
  output: string
  uid: number
  rootPid: number
}): Array<ReportProcess> => {
  const rows = output.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)
    return match && Number(match[3]) === uid
      ? [
          {
            pid: Number(match[1]),
            parentPid: Number(match[2]),
            rssBytes: Number(match[4]) * 1024,
            executable: match[5] ?? "",
          },
        ]
      : []
  })
  const ids = new Set([rootPid])
  for (let pass = 0; pass < rows.length; pass++) {
    const before = ids.size
    for (const row of rows) if (ids.has(row.parentPid) || /(?:^|\/)touri(?:$|-)/i.test(row.executable)) ids.add(row.pid)
    if (before === ids.size) break
  }
  return rows.filter((row) => ids.has(row.pid))
}

export const logNames = ["sidecar.log", "sidecar-shell.log", "sidecar-stderr.log"] as const
/** Reads only regular files, without following symlinks, and bounds work even for a huge stderr file. */
export const tailLog = (path: string): string => {
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile()) return "Log indisponível"
    const start = Math.max(0, stat.size - 2 * 1024 * 1024)
    const bytes = Buffer.alloc(Math.min(stat.size, 2 * 1024 * 1024))
    const length = readSync(fd, bytes, 0, bytes.length, start)
    const lines = bytes.subarray(0, length).toString("utf8").split("\n")
    if (start) lines.shift()
    if (lines.at(-1) === "") lines.pop()
    return lines.slice(-500).join("\n")
  } catch {
    return "Log indisponível"
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export const reportRepository = (): string => {
  const repository = (packageInfo as { repository?: string | { url: string } }).repository
  return process.env.TOURI_REPORT_REPOSITORY ?? (typeof repository === "string" ? repository : (repository?.url ?? ""))
}

export const buildReport = async (kernel: Kernel, input: ReportInput): Promise<ReportSnapshot> => {
  const db = kernel.db as Database
  const has = (part: ReportInput["parts"][number]) => input.parts.includes(part)
  const diagnostics: Record<string, unknown> = {}
  const unavailable: Record<string, string> = {}
  const collect = async (name: string, fn: () => unknown | Promise<unknown>) => {
    try {
      diagnostics[name] = await fn()
    } catch {
      unavailable[name] = "Diagnóstico indisponível"
    }
  }
  const rawLogs =
    has("logs") || has("errors")
      ? Object.fromEntries(logNames.map((name) => [name, tailLog(join(kernel.paths.logsDir, name))]))
      : {}
  if (has("versions"))
    diagnostics.versions = {
      app: packageInfo.version,
      sidecar: packageInfo.version,
      schema: SCHEMA_VERSION,
      os: platform(),
      osRelease: release(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      cpuCount: cpus().length,
      ramBytes: totalmem(),
      freeRamBytes: freemem(),
    }
  if (has("doctor"))
    await collect("doctor", async () => {
      const doctor = kernel.services.use("doctor")
      if (!doctor) throw new Error("unavailable")
      doctor.snapshot(true)
      await doctor.settled()
      return doctor.snapshot()
    })
  if (has("errors")) {
    const counts: Record<string, number> = {}
    for (const code of Object.values(rawLogs)
      .join("\n")
      .match(/TOURI-E\d{4}/g) ?? [])
      counts[code] = (counts[code] ?? 0) + 1
    const requestCounts: Record<string, number> = {}
    for (const item of kernel.services.use("diagnostics.errors")?.() ?? [])
      requestCounts[item.code] = (requestCounts[item.code] ?? 0) + 1
    diagnostics.errors = { requestCounts, window: "Últimas 500 linhas de cada log", counts }
  }
  if (has("states"))
    await collect("states", () => ({
      bots: db.query("SELECT id, provider, machine, paused FROM bots WHERE archived_at IS NULL").all(),
      machines: kernel.services.use("vm.runtime")?.states() ?? [],
      activeRuns: db
        .query(`SELECT r.id, r.bot_id, r.thread_id, r.status, ${runIdentityColumns}
          FROM runs r WHERE r.status IN ('queued','starting','running')`)
        .all(),
    }))
  if (has("database"))
    await collect("database", () => {
      const tables = db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>
      return {
        sizeBytes: statSync(kernel.paths.db).size,
        tables: Object.fromEntries(
          tables.map(({ name }) => [
            name,
            (db.query(`SELECT count(*) AS count FROM "${name.replaceAll('"', '""')}"`).get() as { count: number })
              .count,
          ]),
        ),
      }
    })
  if (has("runs"))
    await collect("runs", () =>
      db
        .query(
          `WITH recent AS MATERIALIZED (
            SELECT id, bot_id, thread_id, status, error_class, queued_at, started_at, finished_at,
              provider_started_at,
              CASE WHEN finished_at IS NOT NULL AND started_at IS NOT NULL
                THEN finished_at - started_at END AS duration_ms
            FROM runs ORDER BY queued_at DESC LIMIT 20
          )
          SELECT r.*, ${runIdentityColumns} FROM recent r ORDER BY r.queued_at DESC`,
        )
        .all(),
    )
  if (has("memory"))
    await collect("memory", async () => {
      const samples = []
      for (let index = 0; index < 3; index++) {
        const proc = Bun.spawn(["ps", "-axo", "pid=,ppid=,uid=,rss=,comm="], { stdout: "pipe", stderr: "ignore" })
        const output = await new Response(proc.stdout).text()
        if ((await proc.exited) !== 0) throw new Error("ps unavailable")
        const processes = ownTouriProcesses({ output, uid: process.getuid?.() ?? -1, rootPid: process.pid })
        samples.push({ at: Date.now(), processes: processes.filter((row) => row.pid !== proc.pid) })
        if (index < 2) await Bun.sleep(100)
      }
      return samples
    })
  if (has("transcript"))
    await collect("transcript", async () => {
      if (!input.threadId) throw new Error("missing thread")
      const store = kernel.services.use("store.api")
      const thread = store?.getThread({ threadId: input.threadId })
      if (!thread || !input.botId || thread.botId !== input.botId) throw new Error("missing thread")
      const branch = input.transcriptBranch ?? "active"
      const selected = input.transcriptMessageIds ? new Set(input.transcriptMessageIds) : null
      diagnostics.transcriptSelection = {
        branches: branch,
        messageIds: input.transcriptMessageIds ?? "all-in-branch",
        bodiesRemainReadable: true,
      }
      if (store?.getBot({ botId: thread.botId })?.machine === "cloud") {
        const cloud = kernel.services.use("cloud.account")
        if (!cloud) throw new Error("cloud unavailable")
        const result = await cloud.request<{
          messages: Array<{ id: string; parentId: string | null; role: string; text: string }>
          activeLeafId?: string | null
        }>("GET", `/v1/threads/${encodeURIComponent(thread.id)}/messages?all=${branch === "all"}`)
        const active = new Set<string>()
        if (branch === "active") {
          const byId = new Map(result.messages.map((message) => [message.id, message]))
          let leaf = result.activeLeafId === undefined ? thread.activeLeafId : result.activeLeafId
          while (leaf && !active.has(leaf)) {
            const message = byId.get(leaf)
            if (!message || !Object.hasOwn(message, "parentId")) throw new Error("Cloud branch metadata unavailable")
            active.add(leaf)
            leaf = message.parentId
          }
        }
        return result.messages
          .filter((message) => (branch === "all" || active.has(message.id)) && (!selected || selected.has(message.id)))
          .map(({ role, text }) => ({ role, text }))
      }
      const rows = (
        branch === "all"
          ? db.query("SELECT id,role,text FROM messages WHERE thread_id=? ORDER BY created_at,id").all(input.threadId)
          : db
              .query(`WITH RECURSIVE branch(id,parent_id) AS (
          SELECT id,parent_id FROM messages WHERE thread_id=? AND id=?
          UNION SELECT m.id,m.parent_id FROM messages m JOIN branch b ON m.id=b.parent_id WHERE m.thread_id=?
        ) SELECT m.id,m.role,m.text FROM messages m JOIN branch b ON b.id=m.id WHERE m.thread_id=? ORDER BY m.created_at,m.id`)
              .all(input.threadId, thread.activeLeafId, input.threadId, input.threadId)
      ) as { id: string; role: string; text: string }[]
      return rows.filter((message) => !selected || selected.has(message.id)).map(({ role, text }) => ({ role, text }))
    })
  const redact = (value: string) => redactReportText(value, (text) => kernel.redact(text).replaceAll(homedir(), "~"))
  const id = kernel.newId()
  const createdAt = Date.now()
  const fields = {
    title: input.title,
    happened: input.happened,
    expected: input.expected,
    steps: input.steps,
    severity: input.severity,
    botId: input.botId,
    threadId: input.threadId,
    errorCode: input.errorCode,
    parts: input.parts,
  }
  const report = redactReportValue(
    { formatVersion: 1, id, createdAt, ...fields, diagnostics, unavailable },
    redact,
  ) as Record<string, unknown>
  const images = input.images.map((image, index) => ({
    mime: image.mime,
    dataBase64: image.dataBase64,
    name: `captura-${index + 1}.${image.mime === "image/jpeg" ? "jpg" : image.mime === "image/webp" ? "webp" : "png"}`,
  }))
  return {
    id,
    createdAt,
    report,
    logs: has("logs") ? Object.fromEntries(Object.entries(rawLogs).map(([name, value]) => [name, redact(value)])) : {},
    images,
    summary: reportSummary(report),
    githubUrl: githubReportUrl(input.repository || reportRepository(), report),
  }
}

// A channel's control record shares its bot with the execution but never starts a provider.
const runIdentityColumns = `
  CASE WHEN EXISTS(SELECT 1 FROM group_turns turn WHERE turn.run_id = r.id)
    THEN 'coordination' ELSE 'execution' END AS kind,
  (SELECT link.turn_id FROM group_run_links link WHERE link.run_id = r.id) AS group_turn_id,
  r.provider_started_at`
