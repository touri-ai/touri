import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { basename, isAbsolute, join, relative, resolve } from "node:path"
import type {
  ImportCounts,
  ImportReport,
  Kernel,
  LegacyBot,
  LegacyImportOptions,
  LegacyMessageJson,
  LegacyRoutine,
  LegacyRoutineRun,
  LegacySource,
  MessagePart,
  Provider,
  ThreadUsage,
} from "@touri/contracts"
import { getMeasuredStage } from "../../kernel/background-task"
import { atomicWriteFile, attachmentMime } from "../../kernel/files"
import { refreshMessageSearch } from "../../kernel/message-search"
import type { PerformanceStageRunner } from "../../kernel/performance"
import { DEPRECATED_IMPORT_ALIAS } from "../deprecatedAliases"
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "./fs"
import { assertImportOwner, importIdentity, legacySourceOrigin, sourceOrigin } from "./identity"
import { type LegacySnapshot, openLegacySnapshot } from "./snapshot"
import { readStagedJson, type StagedSource, stageLegacySource } from "./transport"

type SourceMessage = {
  threadId: string
  id: string
  at: number
  role: "user" | "bot"
  kind: string
  text: string
  json: LegacyMessageJson
  sourceTurnId?: string
}

type SourceRow = Record<string, unknown>

type SelectedBot = {
  source: LegacyBot
  sourceBotId: string
  soul: string
  soulHash: string
  provider: Provider
  access: "read-only" | "workspace-write" | "full"
  approvals: "never" | "on-request"
  cwd: string | null
  projectId: string | null
  homeDir: string
  sourceHash: string
}

type ThreadPlan = {
  id: string
  botId: string
  kind: "main" | "chat" | "routine"
  title: string
  parentThreadId: string | null
  routineRunId: string | null
  cwdOverride: string | null
  createdAt: number
  updatedAt: number
  activeLeafId: string | null
  usage: ThreadUsage
  sourceHash: string
}

type KeptMessage = {
  source: SourceMessage
  parentId: string | null
  parts: Array<MessagePart>
  role: "user" | "assistant" | "system" | "tool"
  kind: "text" | "tool" | "notice"
  status: "complete" | "failed"
  text: string
  sender: { name: string; id: string } | null
  sourceHash: string
  attachmentIds: Array<string>
}

type ImportResult = {
  report: ImportReport
  perBot: Record<string, PerBotReport>
}

type StagingMetadata = {
  path: string
  expiresAt: number
}

type StoredImportReport = ImportReport & { staging?: StagingMetadata }

export type PerBotReport = {
  bots: number
  threads: number
  messages: number
  routines: number
  attachments: number
  droppedDigests: number
  droppedOptions: number
}

type ImportArgs = { kernel: Kernel; importId: string; options: LegacyImportOptions }

const emptyCounts = (): ImportCounts => ({ created: 0, updated: 0, unchanged: 0, skipped: 0 })

const increment = (counts: ImportCounts, key: keyof ImportCounts): void => {
  counts[key] += 1
}

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex")

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, nested) => {
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return Object.fromEntries(
        Object.entries(nested as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)),
      )
    }
    return nested
  })

const asRecord = (value: unknown): SourceRow => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  return value as SourceRow
}

const asString = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback)
const asOptionalString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null
const asNumber = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback
const asBoolean = (value: unknown): boolean => value === true || value === "on" || value === "true"
const safePathSegment = (value: string): boolean =>
  value.length > 0 && value !== "." && value !== ".." && !/[\\/]/.test(value)

const safeLegacyBot = (value: unknown): LegacyBot | null => {
  const row = asRecord(value)
  const modelSelection = asRecord(row.modelSelection)
  const tasks = Array.isArray(row.tasks) ? row.tasks : []
  if (!asString(row.id) || !asString(row.threadId) || !asString(row.name)) return null
  if (
    !safePathSegment(asString(row.id)) ||
    !safePathSegment(asString(row.threadId)) ||
    !safePathSegment(asString(row.name))
  )
    return null
  const selected: LegacyBot = {
    id: asString(row.id),
    threadId: asString(row.threadId),
    name: asString(row.name),
    createdAt: asNumber(row.createdAt, Date.now()),
  }
  if (asOptionalString(row.title)) selected.title = asString(row.title)
  if (asOptionalString(row.description)) selected.description = asString(row.description)
  if (asOptionalString(row.soul)) selected.soul = asString(row.soul)
  if (asOptionalString(row.color)) selected.color = asString(row.color)
  if (asOptionalString(row.section)) selected.section = asString(row.section)
  if (modelSelection && asString(modelSelection.instanceId)) {
    selected.modelSelection = { instanceId: asString(modelSelection.instanceId) }
    if (asOptionalString(modelSelection.model)) selected.modelSelection.model = asString(modelSelection.model)
  }
  if (asOptionalString(row.cwd)) selected.cwd = asString(row.cwd)
  if (asOptionalString(row.approvalMode)) selected.approvalMode = asString(row.approvalMode)
  if (typeof row.browser === "boolean" || typeof row.browser === "string") selected.browser = row.browser
  if (typeof row.computer === "boolean" || typeof row.computer === "string") selected.computer = row.computer
  const cursors = asRecord(row.resumeCursors)
  if (
    cursors &&
    (asOptionalString(cursors.codex) || asOptionalString(cursors.claude) || asOptionalString(cursors.opencode))
  ) {
    selected.resumeCursors = {}
    if (asOptionalString(cursors.codex)) selected.resumeCursors.codex = asString(cursors.codex)
    if (asOptionalString(cursors.claude)) selected.resumeCursors.claude = asString(cursors.claude)
    if (asOptionalString(cursors.opencode)) selected.resumeCursors.opencode = asString(cursors.opencode)
  }
  selected.tasks = []
  for (const task of tasks) {
    const taskRow = asRecord(task)
    if (!asString(taskRow.threadId) || !asString(taskRow.title) || !safePathSegment(asString(taskRow.threadId)))
      continue
    const selectedTask: NonNullable<LegacyBot["tasks"]>[number] = {
      threadId: asString(taskRow.threadId),
      title: asString(taskRow.title),
      createdAt: asNumber(taskRow.createdAt, selected.createdAt),
    }
    if (asNumber(taskRow.updatedAt) > 0) selectedTask.updatedAt = asNumber(taskRow.updatedAt)
    if (asOptionalString(taskRow.routineRunId)) selectedTask.routineRunId = asString(taskRow.routineRunId)
    if (asOptionalString(taskRow.cwd)) selectedTask.cwd = asString(taskRow.cwd)
    const taskCursors = asRecord(taskRow.resumeCursors)
    if (
      taskCursors &&
      (asOptionalString(taskCursors.codex) ||
        asOptionalString(taskCursors.claude) ||
        asOptionalString(taskCursors.opencode))
    ) {
      selectedTask.resumeCursors = {}
      if (asOptionalString(taskCursors.codex)) selectedTask.resumeCursors.codex = asString(taskCursors.codex)
      if (asOptionalString(taskCursors.claude)) selectedTask.resumeCursors.claude = asString(taskCursors.claude)
      if (asOptionalString(taskCursors.opencode)) selectedTask.resumeCursors.opencode = asString(taskCursors.opencode)
    }
    const usage = asRecord(taskRow.usage)
    if (usage) {
      selectedTask.usage = {
        input: asNumber(usage.input),
        output: asNumber(usage.output),
        cachedInput: asNumber(usage.cachedInput),
        costUsd: asNumber(usage.costUsd),
        turns: asNumber(usage.turns),
      }
    }
    selected.tasks.push(selectedTask)
  }
  return selected
}

const safeRoutine = (value: unknown): LegacyRoutine | null => {
  const row = asRecord(value)
  const schedule = asRecord(row.schedule)
  if (!asString(row.id) || !asString(row.name) || !asString(row.botId) || !asString(row.prompt)) return null
  if (asString(schedule.type, "cron") !== "cron" || !asString(schedule.expression) || !asString(schedule.timeZone))
    return null
  const routine: LegacyRoutine = {
    id: asString(row.id),
    name: asString(row.name),
    prompt: asString(row.prompt),
    botId: asString(row.botId),
    enabled: row.enabled === true,
    schedule: { type: "cron", expression: asString(schedule.expression), timeZone: asString(schedule.timeZone) },
  }
  if (asNumber(row.timeoutMinutes) > 0) routine.timeoutMinutes = asNumber(row.timeoutMinutes)
  if (asOptionalString(row.continuity)) routine.continuity = asString(row.continuity)
  if (asOptionalString(row.resultsThreadId)) routine.resultsThreadId = asString(row.resultsThreadId)
  return routine
}

const safeRoutineRun = (value: unknown): LegacyRoutineRun | null => {
  const row = asRecord(value)
  if (!asString(row.id) || !asString(row.routineId)) return null
  const run: LegacyRoutineRun = {
    id: asString(row.id),
    routineId: asString(row.routineId),
    status: asString(row.status),
  }
  if (asOptionalString(row.threadId)) run.threadId = asString(row.threadId)
  if (asNumber(row.scheduledFor) > 0) run.scheduledFor = asNumber(row.scheduledFor)
  if (asNumber(row.startedAt) > 0) run.startedAt = asNumber(row.startedAt)
  if (asNumber(row.finishedAt) > 0) run.finishedAt = asNumber(row.finishedAt)
  if (asOptionalString(row.output)) run.output = asString(row.output)
  run.manual = row.manual === true
  return run
}

const safeMessage = (row: SourceRow): SourceMessage | null => {
  const parsed = (() => {
    try {
      return JSON.parse(asString(row.json)) as unknown
    } catch {
      return {}
    }
  })()
  const json = asRecord(parsed)
  const role = asString(row.role) === "bot" ? "bot" : "user"
  const kind = asString(row.kind)
  const candidate: LegacyMessageJson = {
    id: asString(row.id),
    at: asNumber(row.at),
    parentId: typeof json.parentId === "string" ? json.parentId : null,
    role,
    kind: ["text", "activity", "digest", "routine.run", "compaction", "options"].includes(kind)
      ? (kind as LegacyMessageJson["kind"])
      : "text",
  }
  candidate.text = asString(json.text, asString(row.text))
  if (asOptionalString(json.turnId)) candidate.turnId = asString(json.turnId)
  if (asOptionalString(json.requestMessageId)) candidate.requestMessageId = asString(json.requestMessageId)
  if (typeof json.turnTerminal === "boolean") candidate.turnTerminal = json.turnTerminal
  if (typeof json.turnSucceeded === "boolean") candidate.turnSucceeded = json.turnSucceeded
  const sender = asRecord(json.sender)
  if (sender && asString(sender.name) && asString(sender.id))
    candidate.sender = { name: asString(sender.name), id: asString(sender.id) }
  const attachments = Array.isArray(json.attachments) ? json.attachments : []
  candidate.attachments = attachments.flatMap((item): Array<NonNullable<LegacyMessageJson["attachments"]>[number]> => {
    const attachment = asRecord(item)
    if (attachment.kind !== "image" || !asString(attachment.path) || !asString(attachment.mime)) return []
    return [{ kind: "image", path: asString(attachment.path), mime: asString(attachment.mime) }]
  })
  const tool = asRecord(json.tool)
  if (tool && asString(tool.name)) {
    const safeTool: NonNullable<LegacyMessageJson["tool"]> = {
      name: asString(tool.name),
      summary: asString(tool.summary),
      input: asString(tool.input, "{}"),
    }
    const itemId = asOptionalString(tool.itemId)
    const output = asOptionalString(tool.output)
    if (itemId) safeTool.itemId = itemId
    if (typeof tool.ok === "boolean") safeTool.ok = tool.ok
    if (output) safeTool.output = output
    candidate.tool = safeTool
  }
  const digest = asRecord(json.digest)
  if (digest && asString(digest.turnId)) {
    const usage = asRecord(digest.usage)
    const safeDigest: NonNullable<LegacyMessageJson["digest"]> = {
      turnId: asString(digest.turnId),
      durationMs: asNumber(digest.durationMs),
      toolCalls: asNumber(digest.toolCalls),
    }
    const reply = asOptionalString(digest.reply)
    if (reply) safeDigest.reply = reply
    if (usage)
      safeDigest.usage = {
        input: asNumber(usage.input),
        output: asNumber(usage.output),
        cachedInput: asNumber(usage.cachedInput),
        costUsd: asNumber(usage.costUsd),
      }
    candidate.digest = safeDigest
  }
  const routineRun = asRecord(json.routineRun)
  if (routineRun && asString(routineRun.runId) && asString(routineRun.routineId)) {
    const safeRoutineRun: NonNullable<LegacyMessageJson["routineRun"]> = {
      runId: asString(routineRun.runId),
      routineId: asString(routineRun.routineId),
      routineName: asString(routineRun.routineName),
      scheduledFor: asNumber(routineRun.scheduledFor),
      status: asString(routineRun.status),
    }
    const executionThreadId = asOptionalString(routineRun.executionThreadId)
    const summary = asOptionalString(routineRun.summary)
    if (executionThreadId) safeRoutineRun.executionThreadId = executionThreadId
    if (summary) safeRoutineRun.summary = summary
    candidate.routineRun = safeRoutineRun
  }
  const compaction = asRecord(json.compaction)
  if (compaction && asString(compaction.summary))
    candidate.compaction = { summary: asString(compaction.summary), by: asString(compaction.by) }
  if (!candidate.id || !candidate.at) return null
  return {
    threadId: asString(row.thread_id),
    id: candidate.id,
    at: candidate.at,
    role,
    kind,
    text: candidate.text ?? "",
    json: candidate,
  }
}

const readMessages = (database: LegacySnapshot): Array<SourceMessage> => {
  const rows = database
    .query("SELECT thread_id, id, at, role, kind, text, json FROM messages ORDER BY at, id")
    .all() as Array<SourceRow>
  return rows.flatMap((row) => {
    const message = safeMessage(row)
    return message ? [message] : []
  })
}

const mapCwd = ({
  bot,
  mappings,
  warnings,
}: {
  bot: LegacyBot
  mappings: LegacyImportOptions["cwdMap"]
  warnings: Array<string>
}): { cwd: string | null; projectId: string | null } => {
  const sourceCwd = bot.cwd
  if (!sourceCwd) return { cwd: null, projectId: null }
  const matching = mappings
    .filter(({ from }) => sourceCwd === from || sourceCwd.startsWith(`${from.replace(/\/$/, "")}/`))
    .sort((left, right) => right.from.length - left.from.length)[0]
  if (matching) {
    const suffix = sourceCwd === matching.from ? "" : sourceCwd.slice(matching.from.replace(/\/$/, "").length)
    return { cwd: resolve(matching.to, `.${suffix}`), projectId: matching.projectId ?? null }
  }
  const defaultPath = join(homedir(), "touri", "workspaces", bot.name)
  warnings.push(`No cwd mapping for ${bot.name}; using ${defaultPath}`)
  return { cwd: defaultPath, projectId: null }
}

const readSoul = ({ staged, bot }: { staged: StagedSource; bot: LegacyBot }): string => {
  const path = join(staged.dir, "bots", bot.id, "SOUL.md")
  if (existsSync(path) && statSync(path).isFile()) return readFileSync(path, "utf8")
  return bot.soul ?? ""
}

const selectBots = ({
  staged,
  options,
  warnings,
  kernel,
}: {
  staged: StagedSource
  options: LegacyImportOptions
  warnings: Array<string>
  kernel: Kernel
}): Array<SelectedBot> => {
  const raw = readStagedJson({ dir: staged.dir, relativePath: "bots.json" })
  const sourceBots = (Array.isArray(raw) ? raw : []).flatMap((item) => {
    const bot = safeLegacyBot(item)
    return bot ? [bot] : []
  })
  const requested = new Set(options.botIds)
  const selected = sourceBots.filter((bot) => requested.size === 0 || requested.has(bot.id) || requested.has(bot.name))
  const ids = new Set(selected.map((bot) => bot.id))
  for (const botId of options.botIds)
    if (!ids.has(botId) && !selected.some((bot) => bot.name === botId))
      warnings.push(`Selected bot not found: ${botId}`)
  return selected.map((bot) => {
    const soul = readSoul({ staged, bot })
    const soulHash = sha256(soul)
    const modelInstance = bot.modelSelection?.instanceId
    const provider: Provider =
      modelInstance === "claude" || modelInstance === "codex" || modelInstance === "opencode" ? modelInstance : "codex"
    if (modelInstance && modelInstance !== "codex" && modelInstance !== "claude" && modelInstance !== "opencode")
      warnings.push(`${bot.name}: unsupported provider ${modelInstance}; using codex`)
    const access = bot.approvalMode === "full" ? "full" : "workspace-write"
    const approvals = bot.approvalMode === "full" ? "never" : "on-request"
    const mapping = mapCwd({ bot, mappings: options.cwdMap, warnings })
    const homeDir = join(kernel.paths.botsDir, bot.id)
    const sourceHash = sha256(canonical({ bot, soul }))
    return {
      source: bot,
      sourceBotId: bot.id,
      soul,
      soulHash,
      provider,
      access,
      approvals,
      cwd: mapping.cwd,
      projectId: mapping.projectId,
      homeDir,
      sourceHash,
    }
  })
}

const buildCursorList = (bots: Array<SelectedBot>): Array<{ cursor: string; threadId: string }> => {
  const result: Array<{ cursor: string; threadId: string }> = []
  for (const bot of bots) {
    if (bot.source.resumeCursors?.codex)
      result.push({ cursor: bot.source.resumeCursors.codex, threadId: bot.source.threadId })
    for (const task of bot.source.tasks ?? [])
      if (task.resumeCursors?.codex) result.push({ cursor: task.resumeCursors.codex, threadId: task.threadId })
  }
  return result
}

const sourceRootName = (source: LegacySource): string => basename(source.root.replace(/\/+$/, ""))

const attachmentBasenames = ({
  messages,
  rootName,
}: {
  messages: Array<SourceMessage>
  rootName: string
}): Array<string> =>
  messages.flatMap((message) =>
    (message.json.attachments ?? []).flatMap((attachment) => {
      const filename = validAttachmentBasename({ path: attachment.path, rootName })
      return filename ? [filename] : []
    }),
  )

const isCredentialLikeAttachment = (filename: string): boolean =>
  /^(config\.json|sessions\.json|hook-tokens|.*(?:token|credential|auth).*)$/i.test(filename)

const validAttachmentBasename = ({ path, rootName }: { path: string; rootName: string }): string | null => {
  if (path.includes("\\")) return null
  const parts = path.split("/")
  if (parts.includes("..") || parts.includes(".")) return null
  const relativeOk = !isAbsolute(path) && parts.length === 2 && parts[0] === "attachments"
  const absoluteOk =
    isAbsolute(path) && parts.length >= 4 && parts.at(-2) === "attachments" && parts.at(-3) === rootName
  if (!relativeOk && !absoluteOk) return null
  const filename = parts.at(-1) ?? ""
  if (
    !filename ||
    filename === "." ||
    filename === ".." ||
    filename.includes("\0") ||
    isCredentialLikeAttachment(filename)
  )
    return null
  return filename
}

const attachmentTarget = ({ kernel, hash, mime }: { kernel: Kernel; hash: string; mime: string }): string => {
  const extension = mime === "image/jpeg" ? ".jpg" : mime === "image/png" ? ".png" : ".bin"
  return join(kernel.paths.attachmentsDir, hash.slice(0, 2), `${hash}${extension}`)
}

const readImportRecord = (
  database: Database,
  kind: string,
  sourceId: string,
): { content_hash: string; local_id: string } | null =>
  (database
    .query(
      "SELECT content_hash, local_id FROM import_records WHERE source = 'legacy' AND source_kind = ? AND source_id = ?",
    )
    .get(kind, sourceId) as { content_hash: string; local_id: string } | null) ?? null

const countFromRecord = ({
  database,
  kind,
  sourceId,
  sourceHash,
}: {
  database: Database
  kind: string
  sourceId: string
  sourceHash: string
}): keyof ImportCounts => {
  const previous = readImportRecord(database, kind, sourceId)
  if (!previous) return "created"
  return previous.content_hash === sourceHash ? "unchanged" : "updated"
}

const recordImport = ({
  database,
  kind,
  sourceId,
  localId,
  hash,
  importId,
}: {
  database: Database
  kind: string
  sourceId: string
  localId: string
  hash: string
  importId: string
}): void => {
  database
    .query(
      "INSERT INTO import_records (source, source_kind, source_id, local_id, content_hash, import_id, imported_at) VALUES ('legacy', ?, ?, ?, ?, ?, ?) ON CONFLICT(source, source_kind, source_id) DO UPDATE SET local_id = excluded.local_id, content_hash = excluded.content_hash, import_id = excluded.import_id, imported_at = excluded.imported_at",
    )
    .run(kind, sourceId, localId, hash, importId, Date.now())
}

const threadUsage = (task: NonNullable<LegacyBot["tasks"]>[number] | null): ThreadUsage => ({
  inputTokens: task?.usage?.input ?? 0,
  outputTokens: task?.usage?.output ?? 0,
  cachedInputTokens: task?.usage?.cachedInput ?? 0,
  costUsd: task?.usage?.costUsd ?? null,
  turns: task?.usage?.turns ?? 0,
  contextTokens: null,
  contextWindow: null,
})

const mapContinuity = (value: string | undefined): "new-thread" | "results-thread" | "main-thread" => {
  if (value === "thread" || value === "results" || value === "results-thread") return "results-thread"
  if (value === "main") return "main-thread"
  return "new-thread"
}

const safeState = (database: LegacySnapshot): Map<string, string> => {
  const rows = database.query("SELECT thread_id, active_leaf_id FROM thread_state").all() as Array<{
    thread_id: string
    active_leaf_id: string
  }>
  return new Map(rows.map((row) => [row.thread_id, row.active_leaf_id]))
}

type ForeignKeyViolation = {
  table: string
  rowid: number
  parent: string
  fkid: number
}

type ForeignKeyDefinition = {
  id: number
  seq: number
  table: string
  from: string
  to: string
}

const quoteSqlIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`

const foreignKeyFailureDetails = (database: Database): Array<string> => {
  const violations = database.query("PRAGMA foreign_key_check").all() as Array<ForeignKeyViolation>
  return violations.map((violation) => {
    const quotedTable = quoteSqlIdentifier(violation.table)
    const foreignKey = (
      database.query(`PRAGMA foreign_key_list(${quotedTable})`).all() as Array<ForeignKeyDefinition>
    ).find((candidate) => candidate.id === violation.fkid)
    const child =
      violation.rowid >= 0
        ? (database.query(`SELECT * FROM ${quotedTable} WHERE rowid = ?`).get(violation.rowid) as Record<
            string,
            unknown
          > | null)
        : null
    if (!foreignKey) return `${violation.table}[rowid=${violation.rowid}] references ${violation.parent}`
    const value = child?.[foreignKey.from]
    return `${violation.table}[rowid=${violation.rowid}].${foreignKey.from}=${JSON.stringify(value)} references ${
      foreignKey.table
    }.${foreignKey.to}=${JSON.stringify(value)}`
  })
}

const annotateForeignKeyFailure = ({ database, error }: { database: Database; error: unknown }): unknown => {
  const message = error instanceof Error ? error.message : String(error)
  if (!message.includes("FOREIGN KEY constraint failed")) return error
  const details = foreignKeyFailureDetails(database)
  if (details.length === 0) return error
  const suffix = details.length > 8 ? `; ${details.length - 8} more` : ""
  return new Error(`${message}; ${details.slice(0, 8).join("; ")}${suffix}`)
}

const readRoutineFiles = (staged: StagedSource): { routines: Array<LegacyRoutine>; runs: Array<LegacyRoutineRun> } => {
  const raw = asRecord(readStagedJson({ dir: staged.dir, relativePath: "routines.json" }))
  const routines = (Array.isArray(raw.routines) ? raw.routines : []).flatMap((item) => {
    const routine = safeRoutine(item)
    return routine ? [routine] : []
  })
  const runs = (Array.isArray(raw.runs) ? raw.runs : []).flatMap((item) => {
    const run = safeRoutineRun(item)
    return run ? [run] : []
  })
  return { routines, runs }
}

const buildThreadPlans = ({
  selected,
  messages,
  states,
  routines,
  routineRuns,
  options,
  warnings,
}: {
  selected: Array<SelectedBot>
  messages: Array<SourceMessage>
  states: Map<string, string>
  routines: Array<LegacyRoutine>
  routineRuns: Array<LegacyRoutineRun>
  options: LegacyImportOptions
  warnings: Array<string>
}): Array<ThreadPlan> => {
  const plans: Array<ThreadPlan> = []
  const selectedIds = new Set(selected.map((bot) => bot.source.id))
  const routineByRun = new Map(routineRuns.map((run) => [run.id, run]))
  const routineById = new Map(routines.map((routine) => [routine.id, routine]))
  for (const bot of selected) {
    plans.push({
      id: bot.source.threadId,
      botId: bot.source.id,
      kind: "main",
      title: bot.source.name,
      parentThreadId: null,
      routineRunId: null,
      cwdOverride: null,
      createdAt: bot.source.createdAt,
      updatedAt: bot.source.createdAt,
      activeLeafId: states.get(bot.source.threadId) ?? null,
      usage: threadUsage(null),
      sourceHash: sha256(canonical({ id: bot.source.threadId, kind: "main", bot: bot.source.id })),
    })
    for (const task of bot.source.tasks ?? []) {
      if (task.threadId === bot.source.threadId) continue
      const routineRun = task.routineRunId ? routineByRun.get(task.routineRunId) : null
      const kind = routineRun ? "routine" : "chat"
      const mappedCwd = task.cwd
        ? mapCwd({ bot: { ...bot.source, cwd: task.cwd }, mappings: options.cwdMap, warnings }).cwd
        : null
      plans.push({
        id: task.threadId,
        botId: bot.source.id,
        kind,
        title: task.title,
        parentThreadId: kind === "routine" ? bot.source.threadId : null,
        routineRunId: task.routineRunId ?? null,
        cwdOverride: mappedCwd,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt ?? task.createdAt,
        activeLeafId: states.get(task.threadId) ?? null,
        usage: threadUsage(task),
        sourceHash: sha256(canonical(task)),
      })
    }
  }
  const known = new Set(plans.map((plan) => plan.id))
  const routineMessages = messages.filter(
    (message) => message.json.kind === "routine.run" && message.json.routineRun?.runId,
  )
  for (const message of routineMessages) {
    if (known.has(message.threadId)) continue
    const runId = message.json.routineRun?.runId ?? ""
    const run = routineByRun.get(runId)
    const routine = run ? routineById.get(run.routineId) : null
    if (!run || !routine || !selectedIds.has(routine.botId)) continue
    const bot = selected.find((candidate) => candidate.source.id === routine.botId)
    if (!bot) continue
    plans.push({
      id: message.threadId,
      botId: bot.source.id,
      kind: "routine",
      title: routine.name,
      parentThreadId: bot.source.threadId,
      routineRunId: run.id,
      cwdOverride: null,
      createdAt: message.at,
      updatedAt: message.at,
      activeLeafId: states.get(message.threadId) ?? null,
      usage: threadUsage(null),
      sourceHash: sha256(canonical({ id: message.threadId, routine: routine.id, run: run.id })),
    })
    known.add(message.threadId)
  }
  return plans
}

const threadForMessage = (plans: Array<ThreadPlan>): Map<string, ThreadPlan> =>
  new Map(plans.map((plan) => [plan.id, plan]))

const attachmentSourcePath = (staged: StagedSource, filename: string): string =>
  join(staged.dir, "attachments", filename)

const validatedAttachmentSourcePath = (staged: StagedSource, filename: string): string | null => {
  const attachmentsRoot = join(staged.dir, "attachments")
  const sourcePath = attachmentSourcePath(staged, filename)
  try {
    const linkStat = lstatSync(sourcePath)
    const sourceStat = statSync(sourcePath)
    if (!sourceStat.isFile() || linkStat.isSymbolicLink()) return null
    const realRoot = realpathSync(attachmentsRoot)
    const realSource = realpathSync(sourcePath)
    const suffix = relative(realRoot, realSource)
    if (suffix === "" || suffix.startsWith("..") || suffix.includes("/")) return null
    return sourcePath
  } catch {
    return null
  }
}

const prepareAttachments = ({
  kernel,
  staged,
  messages,
  options,
  counts,
  warnings,
  dryRun,
}: {
  kernel: Kernel
  staged: StagedSource
  messages: Array<SourceMessage>
  options: LegacyImportOptions
  counts: ImportCounts
  warnings: Array<string>
  dryRun: boolean
}): Map<string, { id: string; path: string; mime: string; bytes: number; originPath: string; sourceHash: string }> => {
  const result = new Map<
    string,
    { id: string; path: string; mime: string; bytes: number; originPath: string; sourceHash: string }
  >()
  if (!options.includeAttachments) return result
  for (const message of messages) {
    for (const attachment of message.json.attachments ?? []) {
      const filename = validAttachmentBasename({ path: attachment.path, rootName: sourceRootName(options.source) })
      if (!filename) {
        increment(counts, "skipped")
        warnings.push(`Rejected attachment path outside attachments/: ${attachment.path}`)
        continue
      }
      const sourcePath = validatedAttachmentSourcePath(staged, filename)
      if (!sourcePath) {
        increment(counts, "skipped")
        warnings.push(`Attachment not found in allowlisted attachments/: ${filename}`)
        continue
      }
      const content = readFileSync(sourcePath)
      const id = sha256(content)
      const mime = attachmentMime(content)
      const existing = (kernel.db as Database).query("SELECT path,mime,bytes FROM attachments WHERE id=?").get(id) as {
        path: string
        mime: string
        bytes: number
      } | null
      if (existing && (existing.mime !== mime || existing.bytes !== content.length))
        throw new Error("Import attachment collision")
      const target = existing?.path ?? attachmentTarget({ kernel, hash: id, mime })
      if (!dryRun && !existsSync(target)) {
        atomicWriteFile({ root: kernel.paths.appData, path: target, content: content })
      }
      const sourceHash = sha256(canonical({ path: filename, mime: attachment.mime, contentHash: id }))
      result.set(`${message.id}:${attachment.path}`, {
        id,
        path: target,
        mime,
        bytes: content.byteLength,
        originPath: attachment.path,
        sourceHash,
      })
    }
  }
  return result
}

const repairParent = ({
  id,
  byId,
  kept,
  cache,
}: {
  id: string | null | undefined
  byId: Map<string, SourceMessage>
  kept: Set<string>
  cache: Map<string, string | null>
}): string | null => {
  if (!id) return null
  const cached = cache.get(id)
  if (cached !== undefined) return cached
  if (kept.has(id)) {
    cache.set(id, id)
    return id
  }
  const current = byId.get(id)
  const repaired = repairParent({ id: current?.json.parentId ?? null, byId, kept, cache })
  cache.set(id, repaired)
  return repaired
}

const prepareMessages = ({
  messages,
  plans,
  routines,
  routineRuns,
  attachments,
  dropped,
  warnings,
}: {
  messages: Array<SourceMessage>
  plans: Array<ThreadPlan>
  routines: Array<LegacyRoutine>
  routineRuns: Array<LegacyRoutineRun>
  attachments: Map<
    string,
    { id: string; path: string; mime: string; bytes: number; originPath: string; sourceHash: string }
  >
  dropped: Record<string, number>
  warnings: Array<string>
}): Map<string, Array<KeptMessage>> => {
  const byThread = new Map<string, Array<SourceMessage>>()
  for (const message of messages) byThread.set(message.threadId, [...(byThread.get(message.threadId) ?? []), message])
  const planById = threadForMessage(plans)
  const routineById = new Map(routines.map((routine) => [routine.id, routine]))
  const routineRunById = new Map(routineRuns.map((run) => [run.id, run]))
  const result = new Map<string, Array<KeptMessage>>()
  for (const plan of plans) {
    const threadMessages = byThread.get(plan.id) ?? []
    const keepable = threadMessages.filter((message) =>
      ["text", "activity", "routine.run", "compaction"].includes(message.kind),
    )
    const keptIds = new Set(keepable.map((message) => message.id))
    const byId = new Map(threadMessages.map((message) => [message.id, message]))
    const cache = new Map<string, string | null>()
    const prepared: Array<KeptMessage> = []
    for (const message of threadMessages) {
      if (message.json.parentId && !byId.has(message.json.parentId))
        warnings.push(`Message ${message.id} references a missing parent; parent reset to root`)
      if (!keptIds.has(message.id)) {
        dropped[message.kind] = (dropped[message.kind] ?? 0) + 1
        continue
      }
      const json = message.json
      const parentId = repairParent({ id: json.parentId, byId, kept: keptIds, cache })
      const messageAttachments = (json.attachments ?? []).flatMap((attachment) => {
        const preparedAttachment = attachments.get(`${message.id}:${attachment.path}`)
        return preparedAttachment ? [preparedAttachment] : []
      })
      const imageParts: Array<MessagePart> = messageAttachments.map((attachment) => ({
        type: "image",
        attachmentId: attachment.id,
        mime: attachment.mime,
      }))
      let role: KeptMessage["role"] = message.role === "user" ? "user" : "assistant"
      let kind: KeptMessage["kind"] = "text"
      let text = message.text
      let parts: Array<MessagePart> = [{ type: "text", text }, ...imageParts]
      let sender: { name: string; id: string } | null = json.sender ?? null
      const status: KeptMessage["status"] =
        json.turnTerminal === true && json.turnSucceeded === false ? "failed" : "complete"
      if (message.kind === "activity") {
        role = "tool"
        kind = "tool"
        const tool = json.tool
        const output = (tool?.output ?? "").slice(0, 20_000)
        const inputJson = tool?.input ?? "{}"
        text = tool?.summary ?? ""
        parts = [
          {
            type: "tool_call",
            callId: tool?.itemId ?? message.id,
            tool: tool?.name ?? "unknown",
            summary: text,
            inputJson,
            outputJson: output || null,
            ok: tool?.ok ?? null,
          },
        ]
      } else if (message.kind === "routine.run") {
        role = "system"
        kind = "notice"
        const routineRun = json.routineRun
        const run = routineRun ? routineRunById.get(routineRun.runId) : undefined
        const routine = routineRun ? routineById.get(routineRun.routineId) : undefined
        const name = routine?.name ?? routineRun?.routineName ?? "routine"
        const routineStatus = routineRun?.status ?? run?.status ?? "unknown"
        text = `Routine ${name}: ${routineStatus} — ${routineRun?.summary ?? run?.output ?? ""}`.trim()
        parts = [{ type: "notice", level: "info", code: "routine_run", text }]
        sender = { name, id: routineRun?.routineId ?? "routine" }
      } else if (message.kind === "compaction") {
        role = "system"
        kind = "notice"
        text = json.compaction?.summary ?? message.text
        parts = [{ type: "notice", level: "info", code: "compaction", text }]
      } else if (message.role === "bot") {
        const bot = planById.get(plan.id)
        sender = sender ?? (bot ? { name: bot.title, id: bot.botId } : null)
      }
      prepared.push({
        source: message,
        parentId,
        parts,
        role,
        kind,
        status,
        text,
        sender,
        sourceHash: sha256(canonical({ message: json, parentId, parts })),
        attachmentIds: messageAttachments.map((attachment) => attachment.id),
      })
    }
    result.set(plan.id, prepared)
    const active = plan.activeLeafId
    if (active && !keptIds.has(active)) plan.activeLeafId = repairParent({ id: active, byId, kept: keptIds, cache })
    for (const message of threadMessages)
      if (message.kind === "unknown") warnings.push(`Dropped unknown message kind in ${plan.id}: ${message.id}`)
  }
  return result
}

const upsertBots = ({
  kernel,
  database,
  selected,
  importId,
  counts,
  warnings,
  dryRun,
}: {
  kernel: Kernel
  database: Database
  selected: Array<SelectedBot>
  importId: string
  counts: ImportCounts
  warnings: Array<string>
  dryRun: boolean
}): void => {
  for (const bot of selected) {
    const key = countFromRecord({ database, kind: "bot", sourceId: bot.source.id, sourceHash: bot.soulHash })
    increment(counts, key)
    const previous = readImportRecord(database, "bot", bot.source.id)
    const localSoulPath = join(bot.homeDir, "SOUL.md")
    const localSoulHash = existsSync(localSoulPath) ? sha256(readFileSync(localSoulPath)) : null
    const localSoulEdited =
      localSoulHash !== null &&
      (previous === null ? localSoulHash !== bot.soulHash : localSoulHash !== previous.content_hash)
    const instructions = localSoulEdited ? readFileSync(localSoulPath, "utf8") : bot.soul
    const instructionsHash = localSoulEdited ? sha256(instructions) : bot.soulHash
    if (!dryRun && !localSoulEdited) {
      atomicWriteFile({ root: kernel.paths.appData, path: localSoulPath, content: bot.soul })
    }
    database
      .query(
        "INSERT INTO bots (id, name, title, description, color, instructions, instructions_hash, provider, model, reasoning_effort, access, approvals, project_id, cwd, home_dir, main_thread_id, browser_enabled, computer_use, notifications, section, sort_order, paused, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'failures', ?, ?, 0, 'legacy', ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, title=excluded.title, description=excluded.description, color=excluded.color, instructions=excluded.instructions, instructions_hash=excluded.instructions_hash, provider=excluded.provider, model=excluded.model, access=excluded.access, approvals=excluded.approvals, project_id=excluded.project_id, cwd=excluded.cwd, home_dir=excluded.home_dir, main_thread_id=excluded.main_thread_id, browser_enabled=excluded.browser_enabled, computer_use=0, section=excluded.section, sort_order=excluded.sort_order, source='legacy', updated_at=excluded.updated_at",
      )
      .run(
        bot.source.id,
        bot.source.name,
        bot.source.title ?? null,
        bot.source.description ?? null,
        bot.source.color ?? null,
        instructions,
        instructionsHash,
        bot.provider,
        bot.source.modelSelection?.model ?? null,
        null,
        bot.access,
        bot.approvals,
        bot.projectId,
        bot.cwd,
        bot.homeDir,
        bot.source.threadId,
        asBoolean(bot.source.browser) ? 1 : 0,
        bot.source.section ?? null,
        selected.indexOf(bot),
        bot.source.createdAt,
        Date.now(),
      )
    recordImport({
      database,
      kind: "bot",
      sourceId: bot.source.id,
      localId: bot.source.id,
      hash: bot.soulHash,
      importId,
    })
    if (!dryRun && localSoulEdited)
      warnings.push(`${bot.source.name}: local SOUL.md edit kept; source SOUL was not written`)
  }
}

const upsertThreads = ({
  database,
  plans,
  importId,
  counts,
}: {
  database: Database
  plans: Array<ThreadPlan>
  importId: string
  counts: ImportCounts
}): void => {
  for (const plan of plans) {
    const key = countFromRecord({ database, kind: "thread", sourceId: plan.id, sourceHash: plan.sourceHash })
    increment(counts, key)
    database
      .query(
        "INSERT INTO threads (id, bot_id, parent_thread_id, kind, title, active_leaf_id, routine_run_id, cwd_override, unread, carryover_note, usage_json, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, 'legacy', ?, ?) ON CONFLICT(id) DO UPDATE SET parent_thread_id=excluded.parent_thread_id, kind=excluded.kind, title=excluded.title, active_leaf_id=excluded.active_leaf_id, routine_run_id=excluded.routine_run_id, cwd_override=excluded.cwd_override, usage_json=excluded.usage_json, source='legacy', updated_at=excluded.updated_at",
      )
      .run(
        plan.id,
        plan.botId,
        plan.parentThreadId,
        plan.kind,
        plan.title,
        plan.activeLeafId,
        plan.routineRunId,
        plan.cwdOverride,
        JSON.stringify(plan.usage),
        plan.createdAt,
        plan.updatedAt,
      )
    recordImport({ database, kind: "thread", sourceId: plan.id, localId: plan.id, hash: plan.sourceHash, importId })
  }
}

const upsertRoutines = ({
  database,
  routines,
  selectedIds,
  plans,
  importId,
  counts,
}: {
  database: Database
  routines: Array<LegacyRoutine>
  selectedIds: Set<string>
  plans: Array<ThreadPlan>
  importId: string
  counts: ImportCounts
}): void => {
  const knownThreads = new Set(plans.map((plan) => plan.id))
  for (const routine of routines) {
    if (!selectedIds.has(routine.botId)) {
      increment(counts, "skipped")
      continue
    }
    const sourceHash = sha256(canonical(routine))
    increment(counts, countFromRecord({ database, kind: "routine", sourceId: routine.id, sourceHash }))
    const continuity = mapContinuity(routine.continuity)
    const resultsThreadId =
      routine.resultsThreadId && knownThreads.has(routine.resultsThreadId) ? routine.resultsThreadId : null
    database
      .query(
        "INSERT INTO routines (id, bot_id, name, prompt, cron, timezone, enabled, continuity, results_thread_id, timeout_minutes, overlap, catch_up_minutes, next_run_at, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'skip', 30, NULL, 'legacy', ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, prompt=excluded.prompt, cron=excluded.cron, timezone=excluded.timezone, continuity=excluded.continuity, results_thread_id=excluded.results_thread_id, timeout_minutes=excluded.timeout_minutes, source='legacy', updated_at=excluded.updated_at",
      )
      .run(
        routine.id,
        routine.botId,
        routine.name,
        routine.prompt,
        routine.schedule.expression,
        routine.schedule.timeZone,
        continuity,
        resultsThreadId,
        routine.timeoutMinutes ?? 30,
        Date.now(),
        Date.now(),
      )
    recordImport({ database, kind: "routine", sourceId: routine.id, localId: routine.id, hash: sourceHash, importId })
  }
}

const upsertRoutineRuns = ({
  database,
  runs,
  routines,
  selectedIds,
  plans,
  importId,
}: {
  database: Database
  runs: Array<LegacyRoutineRun>
  routines: Array<LegacyRoutine>
  selectedIds: Set<string>
  plans: Array<ThreadPlan>
  importId: string
}): void => {
  const knownRoutines = new Set(
    routines.filter((routine) => selectedIds.has(routine.botId)).map((routine) => routine.id),
  )
  const knownThreads = new Set(plans.map((plan) => plan.id))
  for (const run of runs) {
    if (!knownRoutines.has(run.routineId)) continue
    const status =
      run.status === "ok" || run.status === "succeeded" || run.status === "completed"
        ? "succeeded"
        : run.status === "error" || run.status === "failed"
          ? "failed"
          : run.status === "skipped"
            ? "skipped"
            : "canceled"
    const trigger = "import"
    const sourceHash = sha256(canonical(run))
    database
      .query(
        "INSERT INTO routine_runs (id, routine_id, scheduled_for, status, thread_id, run_id, trigger_source, summary, started_at, finished_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET scheduled_for=excluded.scheduled_for, status=excluded.status, thread_id=excluded.thread_id, trigger_source=excluded.trigger_source, summary=excluded.summary, started_at=excluded.started_at, finished_at=excluded.finished_at",
      )
      .run(
        run.id,
        run.routineId,
        run.scheduledFor ?? run.startedAt ?? Date.now(),
        status,
        run.threadId && knownThreads.has(run.threadId) ? run.threadId : null,
        trigger,
        (run.output ?? "").slice(0, 500) || null,
        run.startedAt ?? null,
        run.finishedAt ?? null,
      )
    recordImport({ database, kind: "routine_run", sourceId: run.id, localId: run.id, hash: sourceHash, importId })
  }
}

const upsertRunForDigest = ({
  database,
  message,
  plan,
  requestMessageId,
}: {
  database: Database
  message: SourceMessage
  plan: ThreadPlan
  requestMessageId: string | null
}): string | null => {
  const digest = message.json.digest
  if (!digest?.turnId) return null
  const runId = digest.turnId
  assertImportOwner(database, "runs", runId, "thread_id", plan.id)
  const status = digest.reply ? "succeeded" : "failed"
  const usage = digest.usage
    ? {
        inputTokens: digest.usage.input ?? 0,
        outputTokens: digest.usage.output ?? 0,
        cachedInputTokens: digest.usage.cachedInput ?? 0,
        costUsd: digest.usage.costUsd ?? null,
        durationMs: digest.durationMs ?? 0,
        toolCalls: digest.toolCalls ?? 0,
      }
    : null
  database
    .query(
      "INSERT INTO runs (id, thread_id, bot_id, provider, trigger, request_message_id, reply_message_id, external_turn_id, status, error_class, error_message, usage_json, routine_run_id, queued_at, started_at, finished_at) VALUES (?, ?, ?, 'codex', 'import', ?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, error_class=excluded.error_class, error_message=excluded.error_message, usage_json=excluded.usage_json, request_message_id=excluded.request_message_id, finished_at=excluded.finished_at",
    )
    .run(
      runId,
      plan.id,
      plan.botId,
      requestMessageId,
      message.sourceTurnId ?? digest.turnId,
      status,
      status === "failed" ? "unknown" : null,
      status === "failed" ? "Imported digest did not include a reply" : null,
      JSON.stringify(usage),
      message.at,
      message.at,
      message.at + (digest.durationMs ?? 0),
    )
  return runId
}

const upsertMessages = ({
  database,
  messageMap,
  plans,
  importId,
  counts,
}: {
  database: Database
  messageMap: Map<string, Array<KeptMessage>>
  plans: Array<ThreadPlan>
  importId: string
  counts: ImportCounts
}): void => {
  const planById = threadForMessage(plans)
  for (const plan of plans) {
    for (const message of messageMap.get(plan.id) ?? []) {
      const key = countFromRecord({
        database,
        kind: "message",
        sourceId: `${plan.id}:${message.source.id}`,
        sourceHash: message.sourceHash,
      })
      increment(counts, key)
      const runId = message.source.json.turnId ?? null
      database
        .query(
          "INSERT INTO messages (id, thread_id, parent_id, role, kind, status, run_id, text, parts_json, sender_json, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'legacy', ?, ?) ON CONFLICT(thread_id, id) DO UPDATE SET parent_id=excluded.parent_id, role=excluded.role, kind=excluded.kind, status=excluded.status, run_id=excluded.run_id, text=excluded.text, parts_json=excluded.parts_json, sender_json=excluded.sender_json, source='legacy', updated_at=excluded.updated_at",
        )
        .run(
          message.source.id,
          plan.id,
          message.parentId,
          message.role,
          message.kind,
          message.status,
          runId,
          message.text,
          JSON.stringify(message.parts),
          message.sender ? JSON.stringify(message.sender) : null,
          message.source.at,
          message.source.at,
        )
      refreshMessageSearch(
        database,
        { threadId: plan.id, id: message.source.id, text: message.text },
        { indexEmpty: false },
      )
      recordImport({
        database,
        kind: "message",
        sourceId: `${plan.id}:${message.source.id}`,
        localId: message.source.id,
        hash: message.sourceHash,
        importId,
      })
      void planById
    }
  }
}

const importSessions = ({
  kernel,
  database,
  selected,
  staged,
  importId,
  counts,
  dryRun,
  identity,
}: {
  kernel: Kernel
  database: Database
  selected: Array<SelectedBot>
  staged: StagedSource
  importId: string
  counts: ImportCounts
  dryRun: boolean
  identity: ReturnType<typeof importIdentity>
}): void => {
  for (const bot of selected) {
    const cursors = [
      { cursor: bot.source.resumeCursors?.codex, threadId: bot.source.threadId },
      ...(bot.source.tasks ?? []).map((task) => ({ cursor: task.resumeCursors?.codex, threadId: task.threadId })),
    ]
    for (const cursor of cursors) {
      if (!cursor.cursor) continue
      const rollout = staged.sessionPaths.get(cursor.threadId)
      if (!rollout || !existsSync(rollout)) {
        increment(counts, "skipped")
        continue
      }
      const content = readFileSync(rollout)
      const sourceHash = sha256(content)
      const sourceId = `${cursor.threadId}:${cursor.cursor}`
      increment(counts, countFromRecord({ database, kind: "codex_session", sourceId, sourceHash }))
      const target = join(staged.dir, "..", "..", "..", "sessions", "codex", `${cursor.threadId}-${basename(rollout)}`)
      const finalTarget = resolve(target)
      if (!dryRun && !existsSync(finalTarget)) {
        atomicWriteFile({ root: kernel.paths.appData, path: finalTarget, content: content })
      }
      const sessionId = identity.id("codex_session", JSON.stringify([cursor.threadId, cursor.cursor]))
      assertImportOwner(database, "provider_sessions", sessionId, "thread_id", cursor.threadId)
      database
        .query(
          "INSERT INTO provider_sessions (id, thread_id, provider, external_session_id, rollout_path, fingerprint, state, model, created_at, last_used_at) VALUES (?, ?, 'codex', ?, ?, 'imported', 'active', ?, ?, ?) ON CONFLICT(id) DO UPDATE SET external_session_id=excluded.external_session_id, rollout_path=excluded.rollout_path, fingerprint='imported', state='active', model=excluded.model, last_used_at=excluded.last_used_at",
        )
        .run(
          sessionId,
          cursor.threadId,
          cursor.cursor,
          finalTarget,
          bot.source.modelSelection?.model ?? null,
          Date.now(),
          Date.now(),
        )
      recordImport({ database, kind: "codex_session", sourceId, localId: sessionId, hash: sourceHash, importId })
    }
  }
}

const writeMemoryFiles = ({
  kernel,
  staged,
  selected,
  database,
  importId,
  counts,
  warnings,
  dryRun,
}: {
  kernel: Kernel
  staged: StagedSource
  selected: Array<SelectedBot>
  database: Database
  importId: string
  counts: ImportCounts
  warnings: Array<string>
  dryRun: boolean
}): void => {
  for (const bot of selected) {
    const workspace = join(staged.dir, "workspaces", bot.sourceBotId)
    if (!existsSync(workspace)) continue
    const files: Array<string> = []
    const gather = (directory: string): void => {
      if (!existsSync(directory)) return
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue
        const path = join(directory, entry.name)
        if (entry.isDirectory()) gather(path)
        else if (entry.isFile()) files.push(relative(workspace, path).split("\\").join("/"))
      }
    }
    gather(workspace)
    for (const relativePath of files) {
      const sourcePath = join(workspace, relativePath)
      const content = readFileSync(sourcePath)
      const sourceHash = sha256(content)
      const targetRelative = relativePath
      const target = join(bot.homeDir, targetRelative)
      const previous = readImportRecord(database, "memory_file", `${bot.source.id}:${targetRelative}`)
      const localEdited =
        previous !== null && existsSync(target) && sha256(readFileSync(target)) !== previous.content_hash
      increment(
        counts,
        countFromRecord({
          database,
          kind: "memory_file",
          sourceId: `${bot.source.id}:${targetRelative}`,
          sourceHash,
        }),
      )
      if (localEdited) {
        warnings.push(`${bot.source.name}: local memory edit kept for ${targetRelative}`)
        if (!dryRun)
          atomicWriteFile({ root: kernel.paths.appData, path: `${target}.legacy-${importId}`, content: content })
      } else if (!dryRun) {
        atomicWriteFile({ root: kernel.paths.appData, path: target, content: content })
      }
      recordImport({
        database,
        kind: "memory_file",
        sourceId: `${bot.source.id}:${targetRelative}`,
        localId: target,
        hash: sourceHash,
        importId,
      })
    }
  }
}

const collectAttachmentCounts = ({
  messageMap,
  perBot,
  plans,
  selected,
  routines,
}: {
  messageMap: Map<string, Array<KeptMessage>>
  perBot: Record<string, PerBotReport>
  plans: Array<ThreadPlan>
  selected: Array<SelectedBot>
  routines: Array<LegacyRoutine>
}): void => {
  const planById = new Map(plans.map((plan) => [plan.id, plan]))
  for (const [threadId, messages] of messageMap) {
    const plan = planById.get(threadId)
    if (!plan) continue
    const report = perBot[plan.botId] ?? {
      bots: 0,
      threads: 0,
      messages: 0,
      routines: 0,
      attachments: 0,
      droppedDigests: 0,
      droppedOptions: 0,
    }
    report.messages += messages.length
    report.attachments += messages.reduce((total, message) => total + message.attachmentIds.length, 0)
    perBot[plan.botId] = report
  }
  for (const bot of selected) {
    const report = perBot[bot.source.id] ?? {
      bots: 0,
      threads: 0,
      messages: 0,
      routines: 0,
      attachments: 0,
      droppedDigests: 0,
      droppedOptions: 0,
    }
    report.bots = 1
    report.threads = plans.filter((plan) => plan.botId === bot.source.id).length
    report.routines = routines.filter((routine) => routine.botId === bot.source.id).length
    perBot[bot.source.id] = report
  }
}

const makeReport = ({
  importId,
  staged,
  options,
  counts,
  dropped,
  warnings,
}: {
  importId: string
  staged: StagedSource
  options: LegacyImportOptions
  counts: {
    bots: ImportCounts
    threads: ImportCounts
    messages: ImportCounts
    routines: ImportCounts
    attachments: ImportCounts
    codexSessions: ImportCounts
    memoryFiles: ImportCounts
  }
  dropped: Record<string, number>
  warnings: Array<string>
}): ImportReport => ({
  importId,
  origin: staged.origin,
  dryRun: options.dryRun,
  bots: counts.bots,
  threads: counts.threads,
  messages: counts.messages,
  routines: counts.routines,
  attachments: counts.attachments,
  codexSessions: counts.codexSessions,
  memoryFiles: counts.memoryFiles,
  droppedMessageKinds: dropped,
  warnings: [...new Set([...staged.warnings, ...warnings])],
})

const emptyReport = ({
  importId,
  origin,
  dryRun,
  error,
}: {
  importId: string
  origin: string
  dryRun: boolean
  error?: string
}): ImportReport => {
  const counts = emptyCounts()
  return {
    importId,
    origin,
    dryRun,
    bots: { ...counts },
    threads: { ...counts },
    messages: { ...counts },
    routines: { ...counts },
    attachments: { ...counts },
    codexSessions: { ...counts },
    memoryFiles: { ...counts },
    droppedMessageKinds: {},
    warnings: error ? [error] : [],
  }
}

const stagingPaths = ({ stagingRoot, importId }: { stagingRoot: string; importId: string }): Array<string> =>
  ["", "-attachments", "-sessions"].map((suffix) => join(stagingRoot, `${importId}${suffix}`))

const safeStagingPath = ({ stagingRoot, path }: { stagingRoot: string; path: string }): boolean => {
  const root = resolve(stagingRoot)
  const candidate = resolve(path)
  const suffix = relative(root, candidate)
  return suffix.length > 0 && !suffix.startsWith("..") && !suffix.startsWith("/")
}

export const cleanupExpiredLegacyStaging = async ({
  kernel,
  now = Date.now(),
  maxEntries = 32,
  runStage,
}: {
  kernel: Kernel
  now?: number
  maxEntries?: number
  runStage?: PerformanceStageRunner | undefined
}): Promise<number> => {
  const measure = getMeasuredStage("import_staging_expiry", runStage)
  const stagingRoots = [join(kernel.paths.importsDir, "legacy"), join(kernel.paths.importsDir, DEPRECATED_IMPORT_ALIAS)]
  const database = kernel.db as Database
  const cursorKey = "imports.legacy.expiry.cursor"
  const stored = database.query("SELECT value_json FROM settings WHERE key = ?").get(cursorKey) as {
    value_json: string
  } | null
  let cursor = 0
  try {
    cursor = Number(JSON.parse(stored?.value_json ?? "0"))
  } catch {
    /* restart an invalid cursor */
  }
  if (!Number.isSafeInteger(cursor) || cursor < 0) cursor = 0
  const rows = measure(() =>
    database
      .query("SELECT rowid AS cursor,id,status FROM imports WHERE rowid > ? ORDER BY rowid LIMIT ?")
      .all(cursor, maxEntries),
  ) as Array<{ cursor: number; id: string; status: string }>
  let removed = 0
  for (const row of rows) {
    await Bun.sleep(0)
    cursor = row.cursor
    if (row.status !== "failed") continue

    const storedReport = measure(() =>
      database.query("SELECT report_json FROM imports WHERE id=? AND status='failed'").get(row.id),
    ) as { report_json: string | null } | null
    if (!storedReport?.report_json) continue

    let report: StoredImportReport
    try {
      const parsed: unknown = measure(() => JSON.parse(storedReport.report_json ?? "null"))
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue

      report = parsed as StoredImportReport
    } catch {
      continue
    }
    const staging = report.staging
    if (
      !staging ||
      typeof staging.path !== "string" ||
      !Number.isFinite(staging.expiresAt) ||
      staging.expiresAt > now ||
      !safePathSegment(row.id)
    )
      continue
    const stagingRoot = stagingRoots.find((root) => safeStagingPath({ stagingRoot: root, path: staging.path }))
    if (!stagingRoot) continue
    try {
      for (const path of stagingPaths({ stagingRoot, importId: row.id }))
        await rm(path, { recursive: true, force: true })
    } catch {
      continue
    } // Retry next traversal; never claim removal on a filesystem failure.
    const { staging: _staging, ...retained } = report
    // A concurrent retry owns its fresh report and staging; do not overwrite it.
    measure(() =>
      database
        .query("UPDATE imports SET report_json = ? WHERE id = ? AND status='failed' AND report_json=?")
        .run(JSON.stringify(retained), row.id, storedReport.report_json),
    )
    removed += 1
  }
  database
    .query(
      "INSERT INTO settings(key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
    )
    .run(cursorKey, JSON.stringify(rows.length < maxEntries ? 0 : cursor), now)
  return removed
}

const persistFailedImport = ({
  kernel,
  importId,
  origin,
  dryRun,
  stagingPath,
  error,
}: {
  kernel: Kernel
  importId: string
  origin: string
  dryRun: boolean
  stagingPath: string
  error: unknown
}): void => {
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000
  const message = error instanceof Error ? error.message : String(error)
  const report: StoredImportReport = {
    ...emptyReport({ importId, origin, dryRun, error: message }),
    staging: { path: stagingPath, expiresAt },
  }
  report.warnings.push(`Failed import staging retained at ${stagingPath} until ${new Date(expiresAt).toISOString()}`)
  const database = kernel.db as Database
  database
    .query("UPDATE imports SET status = 'failed', report_json = ?, finished_at = ? WHERE id = ?")
    .run(JSON.stringify(report), Date.now(), importId)
}

export const runLegacyImport = async (args: ImportArgs): Promise<ImportResult> => {
  if (!args.options.dryRun) return executeLegacyImport(args)
  // Even failed previews must leave the live DB, expiry queue and bot files alone.
  const root = mkdtempSync(join(tmpdir(), "touri-import-preview-"))
  const bytes = (args.kernel.db as Database).serialize()
  bytes[18] = 1
  bytes[19] = 1
  const database = Database.deserialize(bytes)
  database.exec("PRAGMA foreign_keys = ON")
  try {
    return await executeLegacyImport({
      ...args,
      kernel: {
        ...args.kernel,
        db: database,
        paths: { ...args.kernel.paths, appData: root, importsDir: join(root, "imports") },
      },
    })
  } finally {
    database.close()
    rmSync(root, { recursive: true, force: true })
  }
}

const executeLegacyImport = async ({ kernel, importId, options }: ImportArgs): Promise<ImportResult> => {
  const initialWarnings: Array<string> = []
  const stagingRoot = join(kernel.paths.importsDir, "legacy")
  const stagingPath = join(stagingRoot, importId)
  const database = kernel.db as Database
  const origin = sourceOrigin(options.source)
  const cleanupStaging = (): void => {
    for (const path of stagingPaths({ stagingRoot, importId })) rmSync(path, { recursive: true, force: true })
  }
  let staged!: StagedSource
  let succeeded = false
  if (!options.dryRun) await cleanupExpiredLegacyStaging({ kernel })
  database
    .query(
      "INSERT INTO imports (id, source, origin, status, report_json, started_at, finished_at) VALUES (?, 'legacy', ?, 'running', NULL, ?, NULL)",
    )
    .run(importId, origin, Date.now())
  try {
    staged = await stageLegacySource({
      kernel,
      importId,
      source: options.source,
      botNames: [],
      attachmentBasenames: [],
      importCodexSessions: false,
      resumeCursors: [],
    })
    let selected = selectBots({ staged, options, warnings: initialWarnings, kernel })
    const refreshed = await stageLegacySource({
      kernel,
      importId,
      source: options.source,
      botNames: selected.map((bot) => ({ id: bot.source.id, name: bot.source.name })),
      attachmentBasenames: [],
      importCodexSessions: options.importCodexSessions,
      resumeCursors: buildCursorList(selected),
    })
    staged.warnings.push(...refreshed.warnings)
    for (const [threadId, path] of refreshed.sessionPaths) staged.sessionPaths.set(threadId, path)
    selected = selectBots({ staged, options, warnings: initialWarnings, kernel })
    const snapshot = openLegacySnapshot(staged.snapshotPath)
    let messages: Array<SourceMessage> = []
    try {
      messages = readMessages(snapshot)
    } finally {
      snapshot.close()
    }
    const routinesFile = readRoutineFiles(staged)
    const sourceState = openLegacySnapshot(staged.snapshotPath)
    let states: Map<string, string>
    try {
      states = safeState(sourceState)
    } finally {
      sourceState.close()
    }
    const identity = importIdentity(kernel, origin, importId, legacySourceOrigin(options.source))
    const messageId = (thread: string, id: string) => identity.id("message", JSON.stringify([thread, id]))
    const threadClaims = new Map<string, string>()
    selected = selected.map((bot) => {
      const source = structuredClone(bot.source)
      const claim = (threadId: string) => {
        const previous = threadClaims.get(threadId)
        if (previous && previous !== source.id) throw new Error("Source thread has conflicting bot owners")
        threadClaims.set(threadId, source.id)
        return identity.id("thread", threadId)
      }
      source.threadId = claim(source.threadId)
      source.tasks =
        source.tasks?.map((task) => ({
          ...task,
          threadId: claim(task.threadId),
          ...(task.routineRunId ? { routineRunId: identity.id("routine_run", task.routineRunId) } : {}),
        })) ?? []
      source.id = identity.id("bot", source.id)
      assertImportOwner(database, "bots", source.id, "source", "legacy")
      return { ...bot, source, homeDir: join(kernel.paths.botsDir, source.id) }
    })
    for (const routine of routinesFile.routines) {
      routine.id = identity.id("routine", routine.id)
      routine.botId = identity.id("bot", routine.botId)
      if (routine.resultsThreadId) routine.resultsThreadId = identity.id("thread", routine.resultsThreadId)
      assertImportOwner(database, "routines", routine.id, "bot_id", routine.botId)
    }
    for (const run of routinesFile.runs) {
      run.id = identity.id("routine_run", run.id)
      run.routineId = identity.id("routine", run.routineId)
      if (run.threadId) run.threadId = identity.id("thread", run.threadId)
      assertImportOwner(database, "routine_runs", run.id, "routine_id", run.routineId)
    }
    states = new Map([...states].map(([thread, leaf]) => [identity.id("thread", thread), messageId(thread, leaf)]))
    staged.sessionPaths = new Map(
      [...staged.sessionPaths].map(([thread, path]) => [identity.id("thread", thread), path]),
    )
    const senderKinds = new Map<string, string>([
      ...selected.map((bot) => [bot.sourceBotId, "bot"] as [string, string]),
    ])
    messages = messages.map((message) => {
      const json = structuredClone(message.json)
      const sourceTurnId = message.json.digest?.turnId ?? message.json.turnId
      json.id = messageId(message.threadId, message.id)
      if (json.parentId) json.parentId = messageId(message.threadId, json.parentId)
      if (json.requestMessageId) json.requestMessageId = messageId(message.threadId, json.requestMessageId)
      if (json.turnId) json.turnId = identity.id("run", json.turnId)
      if (json.digest) json.digest.turnId = identity.id("run", json.digest.turnId)
      if (json.sender) json.sender.id = identity.id(senderKinds.get(json.sender.id) ?? "sender", json.sender.id)
      if (json.routineRun) {
        json.routineRun.runId = identity.id("routine_run", json.routineRun.runId)
        json.routineRun.routineId = identity.id("routine", json.routineRun.routineId)
        if (json.routineRun.executionThreadId)
          json.routineRun.executionThreadId = identity.id("thread", json.routineRun.executionThreadId)
      }
      return {
        ...message,
        ...(sourceTurnId ? { sourceTurnId } : {}),
        threadId: identity.id("thread", message.threadId),
        id: json.id,
        json,
      }
    })
    const plans = buildThreadPlans({
      selected,
      messages,
      states,
      routines: routinesFile.routines,
      routineRuns: routinesFile.runs,
      options,
      warnings: initialWarnings,
    })
    const owners = new Map<string, string>()
    for (const plan of plans) {
      const owner = owners.get(plan.id)
      if (owner && owner !== plan.botId) throw new Error("Source thread has conflicting bot owners")
      owners.set(plan.id, plan.botId)
      assertImportOwner(database, "threads", plan.id, "bot_id", plan.botId)
    }
    const plannedThreadIds = new Set(plans.map((plan) => plan.id))
    const importableMessages = messages.filter(
      (message) =>
        plannedThreadIds.has(message.threadId) &&
        ["text", "activity", "routine.run", "compaction"].includes(message.kind),
    )
    const attachmentNames = attachmentBasenames({
      messages: importableMessages,
      rootName: sourceRootName(options.source),
    })
    if (attachmentNames.length > 0) {
      const extra = await stageLegacySource({
        kernel,
        importId: `${importId}-attachments`,
        source: options.source,
        botNames: [],
        attachmentBasenames: attachmentNames,
        importCodexSessions: false,
        resumeCursors: [],
      })
      for (const filename of new Set(attachmentNames)) {
        const sourcePath = validatedAttachmentSourcePath(extra, filename)
        const target = join(staged.dir, "attachments", filename)
        if (sourcePath) {
          atomicWriteFile({ root: kernel.paths.appData, path: target, content: readFileSync(sourcePath) })
        }
      }
      rmSync(extra.dir, { recursive: true, force: true })
    }
    const resumeCursors = buildCursorList(selected)
    if (options.importCodexSessions && resumeCursors.length > 0 && staged.sessionPaths.size === 0) {
      const restaged = await stageLegacySource({
        kernel,
        importId: `${importId}-sessions`,
        source: options.source,
        botNames: selected.map((bot) => ({ id: bot.source.id, name: bot.source.name })),
        attachmentBasenames: [],
        importCodexSessions: true,
        resumeCursors,
      })
      for (const [threadId, path] of restaged.sessionPaths) staged.sessionPaths.set(threadId, path)
      staged.warnings.push(...restaged.warnings)
      rmSync(restaged.dir, { recursive: true, force: true })
    }
    const dropped: Record<string, number> = {}
    const counts = {
      bots: emptyCounts(),
      threads: emptyCounts(),
      messages: emptyCounts(),
      routines: emptyCounts(),
      attachments: emptyCounts(),
      codexSessions: emptyCounts(),
      memoryFiles: emptyCounts(),
    }
    const perBot: Record<string, PerBotReport> = {}
    const runMessages = messages.filter((message) => message.kind === "digest")
    const warnings = [...initialWarnings]
    const execute = (): void => {
      database.exec("BEGIN IMMEDIATE")
      database.exec("PRAGMA defer_foreign_keys = ON")
      try {
        identity.persist()
        upsertBots({ kernel, database, selected, importId, counts: counts.bots, warnings, dryRun: options.dryRun })
        upsertRoutines({
          database,
          routines: routinesFile.routines,
          selectedIds: new Set(selected.map((bot) => bot.source.id)),
          plans,
          importId,
          counts: counts.routines,
        })
        upsertThreads({ database, plans, importId, counts: counts.threads })
        upsertRoutineRuns({
          database,
          runs: routinesFile.runs,
          routines: routinesFile.routines,
          selectedIds: new Set(selected.map((bot) => bot.source.id)),
          plans,
          importId,
        })
        const attachments = prepareAttachments({
          kernel,
          staged,
          messages: importableMessages,
          options,
          counts: counts.attachments,
          warnings,
          dryRun: options.dryRun,
        })
        const seenAttachments = new Set<string>()
        for (const attachment of attachments.values()) {
          const sourceId = `${attachment.id}:${attachment.mime}`
          const duplicate = seenAttachments.has(sourceId)
          if (duplicate) increment(counts.attachments, "unchanged")
          else {
            seenAttachments.add(sourceId)
            const key = countFromRecord({ database, kind: "attachment", sourceId, sourceHash: attachment.sourceHash })
            increment(counts.attachments, key)
          }
          if (duplicate) continue
          database
            .query(
              "INSERT OR IGNORE INTO attachments (id, path, mime, bytes, origin_path, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .run(attachment.id, attachment.path, attachment.mime, attachment.bytes, attachment.originPath, Date.now())
          recordImport({
            database,
            kind: "attachment",
            sourceId,
            localId: attachment.id,
            hash: attachment.sourceHash,
            importId,
          })
        }
        const messageMap = prepareMessages({
          messages,
          plans,
          routines: routinesFile.routines,
          routineRuns: routinesFile.runs,
          attachments,
          dropped,
          warnings,
        })
        for (const message of runMessages) {
          const plan = plans.find((candidate) => candidate.id === message.threadId)
          const requestMessageId =
            message.json.requestMessageId ??
            messages
              .filter(
                (candidate) =>
                  candidate.threadId === message.threadId && candidate.role === "user" && candidate.at < message.at,
              )
              .at(-1)?.id ??
            null
          if (plan) upsertRunForDigest({ database, message, plan, requestMessageId })
        }
        upsertMessages({ database, messageMap, plans, importId, counts: counts.messages })
        for (const plan of plans)
          database.query("UPDATE threads SET active_leaf_id = ? WHERE id = ?").run(plan.activeLeafId, plan.id)
        writeMemoryFiles({
          kernel,
          staged,
          selected,
          database,
          importId,
          counts: counts.memoryFiles,
          warnings,
          dryRun: options.dryRun,
        })
        importSessions({
          kernel,
          database,
          selected,
          staged,
          importId,
          counts: counts.codexSessions,
          dryRun: options.dryRun,
          identity,
        })
        identity.persist()
        for (const bot of selected) {
          const report = perBot[bot.source.id] ?? {
            bots: 1,
            threads: 0,
            messages: 0,
            routines: 0,
            attachments: 0,
            droppedDigests: 0,
            droppedOptions: 0,
          }
          perBot[bot.source.id] = report
        }
        collectAttachmentCounts({ messageMap, perBot, plans, selected, routines: routinesFile.routines })
        for (const [threadId, threadMessages] of new Map(
          plans.map((plan) => [plan.id, messages.filter((message) => message.threadId === plan.id)]),
        )) {
          const plan = plans.find((candidate) => candidate.id === threadId)
          if (!plan) continue
          const report = perBot[plan.botId]
          if (!report) continue
          report.droppedDigests += threadMessages.filter((message) => message.kind === "digest").length
          report.droppedOptions += threadMessages.filter((message) => message.kind === "options").length
        }
        if (options.dryRun) database.exec("ROLLBACK")
        else {
          database.exec("COMMIT")
          const completedReport = makeReport({ importId, staged, options, counts, dropped, warnings })
          database
            .query("UPDATE imports SET status = 'succeeded', report_json = ?, finished_at = ? WHERE id = ?")
            .run(JSON.stringify(completedReport), Date.now(), importId)
        }
      } catch (error) {
        const annotatedError = annotateForeignKeyFailure({ database, error })
        try {
          database.exec("ROLLBACK")
        } catch {
          // Preserve the original import failure.
        }
        throw annotatedError
      }
    }
    execute()
    if (options.dryRun) database.query("DELETE FROM imports WHERE id = ?").run(importId)
    succeeded = true
    const report = makeReport({ importId, staged, options, counts, dropped, warnings })
    return {
      report,
      perBot: Object.fromEntries(selected.map((bot) => [bot.sourceBotId, perBot[bot.source.id]])) as Record<
        string,
        PerBotReport
      >,
    }
  } catch (error) {
    try {
      persistFailedImport({ kernel, importId, origin, dryRun: options.dryRun, stagingPath, error })
    } catch {
      // Preserve the original import failure when failure metadata cannot be stored.
    }
    throw error
  } finally {
    if (succeeded) cleanupStaging()
  }
}
