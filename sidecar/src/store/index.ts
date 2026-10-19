import type { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { extname, isAbsolute, join } from "node:path"
import type {
  AppSettings,
  Attachment,
  Bot,
  CreateBotInput,
  EpochMs,
  Kernel,
  Message,
  MessagePart,
  Provider,
  ReasoningEffort,
  RouteModule,
  RouteResponse,
  SendMessageInput,
  StoreApi,
  Thread,
  ThreadKind,
  ThreadUsage,
} from "@touri/contracts"
import { apiModelErrors, isNotificationPreferences, normalizeBotName } from "@touri/contracts"
import { validAvatarColor, validAvatarShape } from "@touri/contracts/avatar"
import { getApiModel } from "../api-models/config"
import { installDoctor } from "../doctor"
import { parseBotFolders, protectedFolder } from "../kernel/bot-folders"
import { DEFAULT_DATA_RETENTION_DAYS, validDataRetentionDays } from "../kernel/data-maintenance"
import { SCHEMA_VERSION } from "../kernel/db"
import {
  assertPrivateFile,
  atomicWriteFile,
  attachmentMime,
  ensurePrivateDirectory,
  MAX_ATTACHMENT_BYTES,
  readBoundedFile,
} from "../kernel/files"
import { folderGrantProblem, refreshHostFolderAccess, specificFoldersRequired } from "../kernel/folder-capability"
import { historyThreadPending, hydrateHistoryEvent } from "../kernel/history-backfill"
import { getPathIds } from "../kernel/message-path"
import { refreshMessageSearch } from "../kernel/message-search"
import { externalizeMessageParts, OUTPUT_BLOB_ORIGIN, readOutputAttachment } from "../kernel/output-blobs"
import type { PerformanceStageRunner } from "../kernel/performance"
import { isProfileProvider, validProviderProfileName } from "../kernel/provider-profiles"
import { materializeTranscriptBatch } from "../kernel/transcript-storage"
import { getLocalNotificationPreferences } from "../notify/preferences"
import { hostComputerSupported } from "../platform"
import { getHostIdentity } from "../platform/host"
import { getDefaultMaxConcurrentRuns } from "../runtime/concurrency"
import { touriVersion } from "../version"
import { DEFAULT_BOT_VM_MEMORY_MB, DEFAULT_MACHINE_IDLE_MINUTES, validBotVmMemory } from "../vm/resources"
import { redeemFileGrant } from "./redeemFileGrant"
import { createSendJournal } from "./send-journal"
import { createStreamWriter } from "./stream-writer"
import { type RawMessage, readWorkspaceActivity } from "./workspace-activity"

export const name = "store"
export const BOTS_SQL = "SELECT * FROM bots WHERE archived_at IS NULL ORDER BY sort_order ASC, created_at ASC"

type RawBot = {
  id: string
  name: string
  title: string | null
  role_line: string | null
  description: string | null
  color: string | null
  avatar_path: string | null
  avatar_shape: Bot["avatarShape"]
  avatar_seed: string | null
  instructions: string
  instructions_hash: string
  provider: string
  model: string | null
  reasoning_effort: string | null
  access: string
  approvals: string
  project_id: string | null
  folders_json: string
  any_folder_access: number
  cwd: string | null
  home_dir: string
  main_thread_id: string | null
  browser_enabled: number
  browser: Bot["browser"]
  computer_use: number
  machine: Bot["machine"]
  cloud_target?: number
  machine_idle_minutes: number
  vm_provider_login: number
  host_computer_use: number
  provider_profile?: string | null
  claude_ai_connectors?: number
  notifications: string
  section: string | null
  sort_order: number
  paused: number
  source: string
  created_at: number
  updated_at: number
  archived_at: number | null
}

type RawThread = {
  group_id: string | null
  group_thread_id: string | null
  generation: number
  updated_seq: number
  id: string
  bot_id: string
  parent_thread_id: string | null
  kind: string
  title: string
  active_leaf_id: string | null
  routine_run_id: string | null
  cwd_override: string | null
  unread: number
  carryover_note: string | null
  usage_json: string
  source: string
  created_at: number
  updated_at: number
  archived_at: number | null
}

type RawAttachment = {
  id: string
  path: string
  mime: string
  bytes: number
  origin_path: string | null
  created_at: number
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

const asRecord = (value: unknown): Record<string, unknown> | null => (isRecord(value) ? value : null)

const isString = (value: unknown): value is string => typeof value === "string"

const asString = (value: unknown, fallback: string): string => (isString(value) ? value : fallback)

const asNumber = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback

const asBoolean = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback)

const asProvider = (value: unknown, fallback: Provider): Provider =>
  value === "opencode" ? "opencode" : value === "claude" ? "claude" : value === "codex" ? "codex" : fallback

const asReasoningEffort = (value: unknown): ReasoningEffort | null =>
  value === "low" || value === "medium" || value === "high" || value === "xhigh" ? value : null

const asThreadKind = (value: unknown): ThreadKind => (value === "main" || value === "routine" ? value : "chat")

const asUsage = (value: unknown): ThreadUsage => {
  const record = asRecord(value)
  return {
    inputTokens: asNumber(record?.inputTokens, 0),
    outputTokens: asNumber(record?.outputTokens, 0),
    cachedInputTokens: asNumber(record?.cachedInputTokens, 0),
    costUsd: typeof record?.costUsd === "number" ? record.costUsd : null,
    turns: asNumber(record?.turns, 0),
    contextTokens: typeof record?.contextTokens === "number" ? record.contextTokens : null,
    contextWindow: typeof record?.contextWindow === "number" ? record.contextWindow : null,
  }
}

const parseJson = <T>(value: string | null | undefined, fallback: T): T => {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

const parseParts = (value: string): Array<MessagePart> => {
  const parsed = parseJson<unknown>(value, [])
  return Array.isArray(parsed) ? (parsed as Array<MessagePart>) : []
}

const parseSender = (value: string | null): Message["sender"] => {
  const parsed = asRecord(parseJson<unknown>(value, null))
  if (!parsed || !isString(parsed.name) || !isString(parsed.id)) return null
  return { name: parsed.name, id: parsed.id }
}

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex")

const now = (): EpochMs => Date.now()

const asBot = (row: RawBot): Bot => ({
  id: row.id,
  name: row.name,
  title: row.title,
  roleLine: row.role_line ?? null,
  description: row.description,
  color: row.color,
  avatarPath: row.avatar_path,
  avatarShape: row.avatar_shape ?? null,
  avatarSeed: row.avatar_seed ?? null,
  instructions: row.instructions,
  instructionsHash: row.instructions_hash,
  provider: asProvider(row.provider, "codex"),
  model: row.model,
  reasoningEffort: asReasoningEffort(row.reasoning_effort),
  access:
    row.access === "read-only" || row.access === "full" || row.access === "workspace-write"
      ? row.access
      : "workspace-write",
  approvals: row.approvals === "never" ? "never" : "on-request",
  projectId: row.project_id,
  folders: parseJson<NonNullable<Bot["folders"]>>(row.folders_json, []),
  anyFolderAccess: row.any_folder_access === 1,
  cwd: row.cwd,
  homeDir: row.home_dir,
  mainThreadId: row.main_thread_id,
  browserEnabled: row.browser_enabled === 1,
  browser: row.browser,
  computerUse: row.computer_use === 1,
  machine: row.cloud_target === 1 ? "cloud" : row.machine,
  machineIdleMinutes: row.machine_idle_minutes,
  vmProviderLogin: row.vm_provider_login === 1,
  hostComputerUse: row.host_computer_use === 1,
  providerProfile: row.provider_profile ?? null,
  claudeAiConnectors: row.claude_ai_connectors === 1,
  notifications: row.notifications === "all" || row.notifications === "none" ? row.notifications : "failures",
  section: row.section,
  sortOrder: row.sort_order,
  paused: row.paused === 1,
  source: row.source === "legacy" ? "legacy" : "local",
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  archivedAt: row.archived_at,
})

const asThread = (row: RawThread): Thread => ({
  groupId: row.group_id,
  groupThreadId: row.group_thread_id,
  generation: row.generation,
  updatedSeq: row.updated_seq,
  id: row.id,
  botId: row.bot_id,
  parentThreadId: row.parent_thread_id,
  kind: asThreadKind(row.kind),
  title: row.title,
  activeLeafId: row.active_leaf_id,
  routineRunId: row.routine_run_id,
  cwdOverride: row.cwd_override,
  unread: row.unread,
  carryoverNote: row.carryover_note,
  usage: asUsage(parseJson<unknown>(row.usage_json, {})),
  source: row.source === "legacy" ? "legacy" : "local",
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  archivedAt: row.archived_at,
})

const asMessage = (row: RawMessage): Message => ({
  seq: row.seq,
  generation: row.generation,
  updatedSeq: row.updated_seq,
  delivery: row.client_nonce
    ? { clientNonce: row.client_nonce, status: row.delivery_status ?? "queued", deadline: row.delivery_deadline ?? 0 }
    : null,
  id: row.id,
  threadId: row.thread_id,
  parentId: row.parent_id,
  role: row.role,
  kind: row.kind,
  status: row.status,
  runId: row.run_id,
  text: row.text,
  parts: parseParts(row.parts_json),
  sender: parseSender(row.sender_json),
  source: row.source === "legacy" ? "legacy" : "local",
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const asAttachment = (row: RawAttachment): Attachment => ({
  id: row.id,
  path: row.path,
  mime: row.mime,
  bytes: row.bytes,
  originPath: row.origin_path,
  createdAt: row.created_at,
})

const jsonResponse = (status: number, json: unknown): RouteResponse => ({ status, json })

const errorResponse = (
  status: number,
  errorCode: string,
  error: string,
  extra: Record<string, unknown> = {},
): RouteResponse => jsonResponse(status, { errorCode, error, ...extra })

const requestRecord = (body: unknown): Record<string, unknown> | null => asRecord(body)

const settingsDefaults = (): AppSettings => ({
  dataRetentionDays: DEFAULT_DATA_RETENTION_DAYS,
  botVmMemoryMb: DEFAULT_BOT_VM_MEMORY_MB,
  cloud: process.env.TOURI_CLOUD_ENABLED === "1",
  cloudBaseUrl: process.env.TOURI_CLOUD_BASE_URL ?? "",
  cloudWebOrigin: process.env.TOURI_CLOUD_WEB_ORIGIN ?? "https://staging.touri.ai",
  maxConcurrentRuns: getDefaultMaxConcurrentRuns(process.env),
  defaultProvider: "codex",
  cloneRoot: join(homedir(), "touri-projects"),
  cliTelemetry: "off",
  checkForUpdates: true,
  keepRunningInTray: true,
  launchAtLogin: false,
  computerUseHotkey: "ctrl+alt+cmd+.",
  browserExecutable: "system-chrome",
  nativeNotifications: true,
  notificationPreferences: {},
  sidebarFloatUpdates: true,
  resumeInterruptedTurns: true,
})

const settingsKeys: Array<keyof AppSettings> = [
  "dataRetentionDays",
  "botVmMemoryMb",
  "cloud",
  "cloudBaseUrl",
  "cloudWebOrigin",
  "maxConcurrentRuns",
  "defaultProvider",
  "cloneRoot",
  "cliTelemetry",
  "checkForUpdates",
  "keepRunningInTray",
  "launchAtLogin",
  "computerUseHotkey",
  "browserExecutable",
  "nativeNotifications",
  "notificationPreferences",
  "sidebarFloatUpdates",
  "resumeInterruptedTurns",
]

const validSettingsPatch = (patch: Record<string, unknown>): string | null => {
  for (const key of Object.keys(patch)) {
    if (!settingsKeys.includes(key as keyof AppSettings)) return `Unknown setting ${key}`
  }
  if (patch.notificationPreferences !== undefined && !isNotificationPreferences(patch.notificationPreferences))
    return "Invalid notification preferences"
  if (patch.dataRetentionDays !== undefined && !validDataRetentionDays(patch.dataRetentionDays))
    return "dataRetentionDays must be an integer between 0 and 3650"
  if (patch.botVmMemoryMb !== undefined && !validBotVmMemory(patch.botVmMemoryMb))
    return "botVmMemoryMb must be an integer between 512 and 16384"
  if (
    patch.maxConcurrentRuns !== undefined &&
    (!Number.isInteger(patch.maxConcurrentRuns) ||
      Number(patch.maxConcurrentRuns) < 1 ||
      Number(patch.maxConcurrentRuns) > 32)
  )
    return "maxConcurrentRuns must be an integer between 1 and 32"
  if (
    patch.defaultProvider !== undefined &&
    patch.defaultProvider !== "codex" &&
    patch.defaultProvider !== "claude" &&
    patch.defaultProvider !== "opencode"
  )
    return "defaultProvider deve ser Codex, Claude ou OpenCode"
  if (patch.cliTelemetry !== undefined && patch.cliTelemetry !== "off" && patch.cliTelemetry !== "cli-default")
    return "cliTelemetry must be off or cli-default"
  if (
    patch.browserExecutable !== undefined &&
    patch.browserExecutable !== "system-chrome" &&
    patch.browserExecutable !== "chrome-for-testing"
  )
    return "browserExecutable is invalid"
  for (const key of [
    "cloud",
    "checkForUpdates",
    "keepRunningInTray",
    "launchAtLogin",
    "nativeNotifications",
    "sidebarFloatUpdates",
    "resumeInterruptedTurns",
  ] as const) {
    if (patch[key] !== undefined && typeof patch[key] !== "boolean") return `${key} must be a boolean`
  }
  for (const key of ["cloudBaseUrl", "cloudWebOrigin", "cloneRoot", "computerUseHotkey"] as const) {
    if (patch[key] !== undefined && typeof patch[key] !== "string") return `${key} must be a string`
  }
  return null
}

const readSettings = ({ database }: { database: Database }): AppSettings => {
  const settings = settingsDefaults()
  const rows = database.query("SELECT key, value_json FROM settings").all() as Array<{
    key: string
    value_json: string
  }>
  for (const row of rows) {
    if (!settingsKeys.includes(row.key as keyof AppSettings)) continue
    const key = row.key as keyof AppSettings
    const value = parseJson<unknown>(row.value_json, settings[key])
    if (key === "dataRetentionDays" && validDataRetentionDays(value)) settings[key] = value
    if (key === "botVmMemoryMb" && validBotVmMemory(value)) settings[key] = value
    if (key === "maxConcurrentRuns" && Number.isInteger(value)) settings[key] = value as never
    if (key === "defaultProvider" && (value === "codex" || value === "claude" || value === "opencode"))
      settings[key] = value
    if ((key === "cloudBaseUrl" || key === "cloudWebOrigin") && isString(value)) settings[key] = value
    if (key === "cloud" && typeof value === "boolean") settings[key] = value
    if (key === "cloneRoot" && isString(value)) settings[key] = value
    if (key === "cliTelemetry" && (value === "off" || value === "cli-default")) settings[key] = value
    if (
      (key === "checkForUpdates" ||
        key === "keepRunningInTray" ||
        key === "launchAtLogin" ||
        key === "nativeNotifications" ||
        key === "sidebarFloatUpdates" ||
        key === "resumeInterruptedTurns") &&
      typeof value === "boolean"
    )
      settings[key] = value
    if (key === "computerUseHotkey" && isString(value)) settings[key] = value
    if (key === "browserExecutable" && (value === "system-chrome" || value === "chrome-for-testing"))
      settings[key] = value
  }
  const savedPreferences = rows.find((row) => row.key === "notificationPreferences")
  const preferences = parseJson<unknown>(savedPreferences?.value_json ?? "{}", {})
  return {
    ...settings,
    notificationPreferences: getLocalNotificationPreferences(isNotificationPreferences(preferences) ? preferences : {}),
  }
}

const writeSettings = ({ database, settings }: { database: Database; settings: AppSettings }): void => {
  const timestamp = now()
  for (const key of settingsKeys) {
    database
      .query(
        "INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
      )
      .run(key, JSON.stringify(settings[key]), timestamp)
  }
}

export const init = async (kernel: Kernel, runStage?: PerformanceStageRunner): Promise<void> => {
  await refreshHostFolderAccess()
  installDoctor(kernel)
  const database = kernel.db as Database
  const recoverTranscript = () => materializeTranscriptBatch(database)
  while (runStage ? runStage("store_transcript_startup_recovery", recoverTranscript) : recoverTranscript()) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }

  const getBot = ({ botId }: { botId: string }): Bot | null => {
    const row = database.query("SELECT * FROM bots WHERE id = ? AND archived_at IS NULL").get(botId) as RawBot | null
    return row ? asBot(row) : null
  }

  const getThread = ({ threadId }: { threadId: string }): Thread | null => {
    const row = database
      .query("SELECT * FROM threads WHERE id = ? AND archived_at IS NULL")
      .get(threadId) as RawThread | null
    return row ? asThread(row) : null
  }

  const getMessage = ({ threadId, messageId }: { threadId: string; messageId: string }): Message | null => {
    const row = database
      .query("SELECT * FROM messages WHERE thread_id = ? AND id = ?")
      .get(threadId, messageId) as RawMessage | null
    return row ? asMessage(row) : null
  }

  const hasMessage = ({ threadId, messageId }: { threadId: string; messageId: string }): boolean =>
    !!database.query("SELECT 1 FROM messages WHERE thread_id = ? AND id = ?").get(threadId, messageId)

  const refreshFts = ({ message }: { message: Message }): void => {
    if (runStage) runStage("message_search_index", () => refreshMessageSearch(database, message))
    else refreshMessageSearch(database, message)
  }

  const streamWriter = createStreamWriter({
    kernel,
    database,
    getMessage,
    getThread,
    ...(runStage ? { runStage } : {}),
  })
  const flushDeltas = streamWriter.checkpoint

  const updateThreadRow = ({
    threadId,
    patch,
  }: {
    threadId: string
    patch: Partial<Pick<Thread, "title" | "carryoverNote" | "usage" | "unread" | "activeLeafId">>
  }): Thread | null => {
    const current = database.query("SELECT * FROM threads WHERE id = ?").get(threadId) as RawThread | null
    if (!current) return null
    const fields: Array<string> = []
    const values: Array<string | number | null> = []
    if (Object.hasOwn(patch, "title") && patch.title !== undefined) {
      fields.push("title = ?")
      values.push(patch.title)
    }
    if (Object.hasOwn(patch, "carryoverNote")) {
      fields.push("carryover_note = ?")
      values.push(patch.carryoverNote ?? null)
    }
    if (Object.hasOwn(patch, "usage") && patch.usage !== undefined) {
      fields.push("usage_json = ?")
      values.push(JSON.stringify(patch.usage))
    }
    if (Object.hasOwn(patch, "unread") && patch.unread !== undefined) {
      fields.push("unread = ?")
      values.push(patch.unread)
    }
    if (Object.hasOwn(patch, "activeLeafId") && patch.activeLeafId !== undefined) {
      fields.push("active_leaf_id = ?")
      values.push(patch.activeLeafId)
    }
    if (fields.length > 0) {
      fields.push("updated_at = ?")
      values.push(now())
      database.query(`UPDATE threads SET ${fields.join(", ")} WHERE id = ?`).run(...values, threadId)
    }
    const thread = getThread({ threadId })
    if (thread) kernel.publish({ type: "thread.updated", thread })
    return thread
  }

  const insertMessage: StoreApi["insertMessage"] = ({ message }) => {
    if (!getThread({ threadId: message.threadId }))
      return { success: false, errorCode: "THREAD_NOT_FOUND", error: `Thread ${message.threadId} was not found` }
    if (message.parentId !== null && !hasMessage({ threadId: message.threadId, messageId: message.parentId }))
      return { success: false, errorCode: "PARENT_NOT_FOUND", error: `Parent ${message.parentId} was not found` }
    const timestamp = now()
    database
      .query(
        "INSERT INTO messages (id, thread_id, parent_id, role, kind, status, run_id, text, parts_json, sender_json, source, created_at, updated_at, client_nonce, delivery_status, delivery_deadline) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        message.id,
        message.threadId,
        message.parentId,
        message.role,
        message.kind,
        message.status,
        message.runId,
        message.text,
        JSON.stringify(externalizeMessageParts({ database, appData: kernel.paths.appData, parts: message.parts })),
        message.sender ? JSON.stringify(message.sender) : null,
        message.source,
        timestamp,
        timestamp,
        message.delivery?.clientNonce ?? null,
        message.delivery?.status ?? null,
        message.delivery?.deadline ?? null,
      )
    const stored = getMessage({ threadId: message.threadId, messageId: message.id })
    if (!stored)
      return { success: false, errorCode: "THREAD_NOT_FOUND", error: "Message could not be read after insert" }
    refreshFts({ message: stored })
    updateThreadRow({ threadId: message.threadId, patch: { activeLeafId: message.id } })
    kernel.publish({ type: "message.created", message: stored })
    return { success: true, message: stored }
  }

  const updateMessage: StoreApi["updateMessage"] = ({ threadId, messageId, patch }) => {
    if (patch.parts !== undefined && patch.text !== undefined) streamWriter.drain()
    else flushDeltas()
    const current = getMessage({ threadId, messageId })
    if (!current) return { success: false, errorCode: "NOT_FOUND", error: `Message ${messageId} was not found` }
    // A terminal run reply can still settle its tools, but its text and outcome are final.
    if (current.role === "assistant" && current.runId && current.status !== "streaming") {
      const prose = (parts: MessagePart[]) => parts.filter((part) => part.type === "text" || part.type === "reasoning")
      if (
        (patch.status !== undefined && patch.status !== current.status) ||
        (patch.text !== undefined && patch.text !== current.text) ||
        (patch.runId !== undefined && patch.runId !== current.runId) ||
        (patch.parts !== undefined && JSON.stringify(prose(patch.parts)) !== JSON.stringify(prose(current.parts)))
      )
        return { success: true, message: current }
    }
    const next: Message = {
      ...current,
      ...(Object.hasOwn(patch, "status") && patch.status !== undefined ? { status: patch.status } : {}),
      ...(Object.hasOwn(patch, "parts") && patch.parts !== undefined ? { parts: patch.parts } : {}),
      ...(Object.hasOwn(patch, "text") && patch.text !== undefined ? { text: patch.text } : {}),
      ...(Object.hasOwn(patch, "runId") ? { runId: patch.runId ?? null } : {}),
      updatedAt: now(),
    }
    next.parts = externalizeMessageParts({ database, appData: kernel.paths.appData, parts: next.parts })
    const partsJson = JSON.stringify(next.parts)
    if (
      next.status === current.status &&
      next.text === current.text &&
      next.runId === current.runId &&
      partsJson === JSON.stringify(current.parts)
    )
      return { success: true, message: current }
    database
      .query(
        "UPDATE messages SET status = ?, parts_json = ?, text = ?, run_id = ?, updated_at = ? WHERE thread_id = ? AND id = ?",
      )
      .run(next.status, partsJson, next.text, next.runId, next.updatedAt, threadId, messageId)
    if (next.text !== current.text) refreshFts({ message: next })
    const stored = getMessage({ threadId, messageId }) ?? next
    streamWriter.invalidate(threadId, messageId)
    kernel.publish({ type: "message.updated", message: stored })
    return { success: true, message: stored }
  }

  const activePath: StoreApi["activePath"] = ({ threadId, leafId, limit, fromRoot = false }) => {
    flushDeltas()
    const thread = getThread({ threadId })
    const targetId = leafId ?? thread?.activeLeafId
    if (!targetId) return []
    const boundedLimit = limit === undefined ? undefined : Math.max(0, Math.floor(limit))
    const ids = getPathIds(database, threadId, targetId, fromRoot ? -1 : boundedLimit)
    const selected = fromRoot && boundedLimit !== undefined ? ids.slice(-boundedLimit) : ids
    if (boundedLimit === 0) return []

    // Reverse a fresh local array; the compiler targets the older array API.
    return selected
      .slice()
      .reverse()
      .flatMap((messageId) => {
        const message = getMessage({ threadId, messageId })
        return message ? [message] : []
      })
  }

  const getPathMessage: NonNullable<StoreApi["getPathMessage"]> = ({ threadId, messageId, leafId }) => {
    flushDeltas()
    const targetId = leafId ?? getThread({ threadId })?.activeLeafId
    if (!targetId) return null
    const ids = getPathIds(database, threadId, targetId, -1, messageId)
    if (ids.at(-1) !== messageId) return null

    return getMessage({ threadId, messageId })
  }

  const setActiveLeaf: StoreApi["setActiveLeaf"] = ({ threadId, leafId }) => {
    if (!hasMessage({ threadId, messageId: leafId }))
      return { success: false, errorCode: "NOT_FOUND", error: `Message ${leafId} was not found` }
    const thread = updateThreadRow({ threadId, patch: { activeLeafId: leafId } })
    if (!thread) return { success: false, errorCode: "NOT_FOUND", error: `Thread ${threadId} was not found` }
    return { success: true, thread }
  }

  const createThread: StoreApi["createThread"] = ({
    botId,
    kind,
    title,
    parentThreadId,
    routineRunId,
    groupId,
    groupThreadId,
  }) => {
    const bot = getBot({ botId })
    if (!bot) return { success: false, errorCode: "BOT_NOT_FOUND", error: `Bot ${botId} was not found` }
    if (parentThreadId !== undefined) {
      const parent = database.query("SELECT id, bot_id FROM threads WHERE id = ?").get(parentThreadId) as {
        id: string
        bot_id: string
      } | null
      if (!parent || parent.bot_id !== botId)
        return { success: false, errorCode: "BOT_NOT_FOUND", error: `Parent thread ${parentThreadId} was not found` }
    }
    const threadId = kernel.newId()
    const timestamp = now()
    database
      .query(
        "INSERT INTO threads (id, bot_id, parent_thread_id, kind, title, active_leaf_id, routine_run_id, cwd_override, unread, carryover_note, usage_json, source, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, 0, NULL, ?, 'local', ?, ?, NULL)",
      )
      .run(
        threadId,
        botId,
        parentThreadId ?? null,
        kind,
        title,
        routineRunId ?? null,
        JSON.stringify(asUsage({})),
        timestamp,
        timestamp,
      )
    if (groupId)
      database
        .query("UPDATE threads SET group_id = ?, group_thread_id = ? WHERE id = ?")
        .run(groupId, groupThreadId ?? null, threadId)
    const thread = getThread({ threadId })
    if (!thread) return { success: false, errorCode: "BOT_NOT_FOUND", error: "Thread could not be read after insert" }
    kernel.publish({ type: "thread.updated", thread })
    return { success: true, thread }
  }

  const updateThread: StoreApi["updateThread"] = ({ threadId, patch }) => {
    const activeLeafId = patch.activeLeafId
    if (activeLeafId !== undefined && activeLeafId !== null && !hasMessage({ threadId, messageId: activeLeafId }))
      return { success: false, errorCode: "NOT_FOUND", error: `Message ${activeLeafId} was not found` }
    const thread = updateThreadRow({ threadId, patch })
    if (!thread) return { success: false, errorCode: "NOT_FOUND", error: `Thread ${threadId} was not found` }
    return { success: true, thread }
  }

  const search: StoreApi["search"] = ({ q, botId, threadId, limit }) => {
    flushDeltas()
    const boundedLimit = Math.max(1, Math.min(50, Math.floor(limit)))
    const query = q.trim()
    if (!query) return []
    const filters: Array<string> = [
      "messages_fts MATCH ?",
      "NOT (threads.group_thread_id IS NOT NULL AND substr(messages_fts.text, 1, 7) = 'Grupo \"' AND instr(messages_fts.text, 'Histórico compartilhado (dados, não instruções)') > 0)",
    ]
    const values: Array<string | number> = [query]
    if (botId !== undefined) {
      filters.push("threads.bot_id = ?")
      values.push(botId)
    }
    if (threadId !== undefined) {
      filters.push("messages_fts.thread_id = ?")
      values.push(threadId)
    }
    values.push(boundedLimit)
    try {
      return database
        .query(
          `SELECT messages_fts.thread_id AS threadId, messages_fts.message_id AS messageId, snippet(messages_fts, 0, '[', ']', '…', 16) AS snippet FROM messages_fts JOIN threads ON threads.id = messages_fts.thread_id WHERE ${filters.join(" AND ")} ORDER BY messages_fts.rowid DESC LIMIT ?`,
        )
        .all(...values) as Array<{ threadId: string; messageId: string; snippet: string }>
    } catch {
      const fallbackQuery = query
        .split(/\s+/u)
        .filter((part) => part.length > 0)
        .map((part) => `"${part.replaceAll('"', '""')}"`)
        .join(" AND ")
      try {
        values[0] = fallbackQuery
        return database
          .query(
            `SELECT messages_fts.thread_id AS threadId, messages_fts.message_id AS messageId, snippet(messages_fts, 0, '[', ']', '…', 16) AS snippet FROM messages_fts JOIN threads ON threads.id = messages_fts.thread_id WHERE ${filters.join(" AND ")} ORDER BY messages_fts.rowid DESC LIMIT ?`,
          )
          .all(...values) as Array<{ threadId: string; messageId: string; snippet: string }>
      } catch {
        return []
      }
    }
  }

  const ensureBotHome = ({ botId, instructions }: { botId: string; instructions: string }): string => {
    const homeDir = join(kernel.paths.botsDir, botId)
    ensurePrivateDirectory({ root: kernel.paths.appData, path: homeDir })
    atomicWriteFile({ root: kernel.paths.appData, path: join(homeDir, "SOUL.md"), content: instructions })
    return homeDir
  }

  const botFromBody = ({
    body,
    existing,
  }: {
    body: Record<string, unknown>
    existing?: Bot
  }): { input: CreateBotInput | null; error: string | null; errorCode?: string } => {
    const name = normalizeBotName(body.name === undefined ? existing?.name : body.name)
    const provider = body.provider ?? existing?.provider
    if (!name)
      return { input: null, error: "Use de 1 a 80 caracteres, sem quebras de linha ou caracteres de controle." }
    if (provider !== "codex" && provider !== "claude" && provider !== "opencode")
      return { input: null, error: "provider deve ser Codex, Claude ou OpenCode" }
    const input: CreateBotInput = { name, provider }
    if (body.machine !== undefined && body.machine !== "local" && body.machine !== "vm" && body.machine !== "cloud")
      return { input: null, error: "machine must be local, vm or cloud" }
    input.machine = (body.machine as Bot["machine"] | undefined) ?? existing?.machine ?? "local"
    if (body.browser !== undefined && !["touri", "local", "machine"].includes(body.browser as string))
      return { input: null, error: "Escolha Chrome do touri, Meu Chrome ou Chrome da máquina." }
    input.browser = (body.browser as Bot["browser"] | undefined) ?? existing?.browser ?? "touri"
    if (input.browser === "local" && input.machine !== "local")
      return {
        input: null,
        errorCode: "LOCAL_BROWSER_REQUIRES_HOST",
        error:
          "Meu Chrome só funciona em bots no computador onde o touri está rodando. Uma máquina remota não pode acessar esse navegador.",
      }
    // Changing the execution destination keeps the old routing unless a browser was explicitly chosen.
    if (body.browser === undefined) {
      if (input.machine === "vm") input.browser = "machine"
      else if (input.browser === "machine") input.browser = "touri"
    }
    if (input.browser === "machine" && input.machine !== "vm")
      return { input: null, error: "Chrome da máquina requer um bot na máquina Linux." }
    if (input.machine === "vm" && input.browser !== "machine")
      return { input: null, error: "Para um bot na máquina Linux, escolha Chrome da máquina." }
    if (input.machine === "cloud") {
      if (provider === "opencode")
        return {
          input: null,
          errorCode: "TOURI-E9009",
          error:
            "OpenCode está disponível no computador local e na máquina Linux. O runtime da nuvem ainda não oferece este provedor.",
        }
      if (!readSettings({ database }).cloud) return { input: null, errorCode: "TOURI-E9013", error: "Nuvem desativada" }
      if (!kernel.services.use("cloud.account"))
        return { input: null, errorCode: "TOURI-E9001", error: "Conecte sua conta" }
      if (body.vmProviderLogin === true || body.hostComputerUse === true || body.projectId || body.cwd)
        return { input: null, errorCode: "TOURI-E9014", error: "A nuvem usa chave API e workspace remoto" }
      if (existing && existing.machine !== "cloud")
        return { input: null, errorCode: "TOURI-E9009", error: "Migração requer exportação explícita" }
    }
    if (existing?.machine === "cloud" && input.machine !== "cloud")
      return { input: null, errorCode: "TOURI-E9009", error: "Exporte antes de mudar o destino" }
    const idle = body.machineIdleMinutes ?? existing?.machineIdleMinutes ?? DEFAULT_MACHINE_IDLE_MINUTES
    if (typeof idle !== "number" || !Number.isInteger(idle) || idle < 1 || idle > 1440)
      return { input: null, error: "machineIdleMinutes must be between 1 and 1440" }
    input.machineIdleMinutes = idle
    for (const field of ["vmProviderLogin", "hostComputerUse"] as const) {
      if (body[field] !== undefined && typeof body[field] !== "boolean")
        return { input: null, error: `${field} must be a boolean` }
      input[field] = (body[field] as boolean | undefined) ?? existing?.[field] ?? false
    }
    if (!hostComputerSupported) input.hostComputerUse = false
    if (input.machine === "cloud") {
      input.vmProviderLogin = false
      input.hostComputerUse = false
    }
    if (existing && input.provider !== existing.provider && !Object.hasOwn(body, "vmProviderLogin"))
      input.vmProviderLogin = false
    if (input.machine === "vm" && existing?.machine !== "vm") {
      const capability = kernel.services.use("vm.runtime")?.capability
      if (!capability?.available)
        return {
          input: null,
          errorCode: "MACHINE_UNAVAILABLE",
          error: capability?.reason ?? "sem virtualização neste host",
        }
    }

    if (Object.hasOwn(body, "title")) input.title = body.title === null ? null : asString(body.title, "")
    else if (existing) input.title = existing.title
    if (Object.hasOwn(body, "roleLine")) input.roleLine = body.roleLine === null ? null : asString(body.roleLine, "")
    else if (existing) input.roleLine = existing.roleLine ?? null
    if (Object.hasOwn(body, "description"))
      input.description = body.description === null ? null : asString(body.description, "")
    else if (existing) input.description = existing.description
    if (Object.hasOwn(body, "color")) input.color = body.color === null ? null : asString(body.color, "")
    else if (existing) input.color = existing.color
    if (Object.hasOwn(body, "avatarShape")) {
      if (body.avatarShape !== null && !validAvatarShape(body.avatarShape))
        return { input: null, error: "avatarShape is invalid" }
      input.avatarShape = body.avatarShape as NonNullable<Bot["avatarShape"]> | null
    } else if (existing) input.avatarShape = existing.avatarShape ?? null
    if (Object.hasOwn(body, "avatarSeed")) {
      if (
        body.avatarSeed !== null &&
        (typeof body.avatarSeed !== "string" || body.avatarSeed.length < 1 || body.avatarSeed.length > 200)
      )
        return { input: null, error: "avatarSeed is invalid" }
      input.avatarSeed = body.avatarSeed as string | null
    } else if (existing) input.avatarSeed = existing.avatarSeed ?? null
    if (
      Object.hasOwn(body, "color") &&
      input.color !== undefined &&
      input.color !== null &&
      !validAvatarColor(input.color)
    )
      return { input: null, error: "color must be a six-digit hex color" }
    if (Object.hasOwn(body, "instructions")) input.instructions = asString(body.instructions, "")
    else if (existing) input.instructions = existing.instructions
    if (Object.hasOwn(body, "model")) input.model = body.model === null ? null : asString(body.model, "")
    else if (existing) input.model = existing.model
    if (input.model?.startsWith("touri-api-") && (provider !== "opencode" || !getApiModel(kernel, input.model)))
      return { input: null, errorCode: "api_model_removed", error: apiModelErrors.removed }
    if (Object.hasOwn(body, "reasoningEffort")) input.reasoningEffort = asReasoningEffort(body.reasoningEffort)
    else if (existing) input.reasoningEffort = existing.reasoningEffort
    if (Object.hasOwn(body, "access")) input.access = body.access as Bot["access"]
    else if (existing) input.access = existing.access
    if (Object.hasOwn(body, "approvals")) input.approvals = body.approvals as Bot["approvals"]
    else if (existing) input.approvals = existing.approvals
    if (Object.hasOwn(body, "projectId"))
      input.projectId = body.projectId === null ? null : asString(body.projectId, "")
    else if (existing) input.projectId = existing.projectId
    if (Object.hasOwn(body, "cwd")) input.cwd = body.cwd === null ? null : asString(body.cwd, "")
    else if (existing) input.cwd = existing.cwd
    if (Object.hasOwn(body, "browserEnabled")) input.browserEnabled = asBoolean(body.browserEnabled, true)
    else if (existing) input.browserEnabled = existing.browserEnabled
    if (Object.hasOwn(body, "computerUse")) input.computerUse = asBoolean(body.computerUse, false)
    else if (existing) input.computerUse = existing.computerUse
    if (
      input.access !== undefined &&
      input.access !== "read-only" &&
      input.access !== "workspace-write" &&
      input.access !== "full"
    )
      return { input: null, error: "access is invalid" }
    if (input.approvals !== undefined && input.approvals !== "never" && input.approvals !== "on-request")
      return { input: null, error: "approvals is invalid" }
    if (body.anyFolderAccess !== undefined && typeof body.anyFolderAccess !== "boolean")
      return { input: null, error: "anyFolderAccess must be a boolean" }
    input.anyFolderAccess = (body.anyFolderAccess as boolean | undefined) ?? existing?.anyFolderAccess ?? false
    try {
      input.folders = body.folders === undefined ? (existing?.folders ?? []) : parseBotFolders(body.folders)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        input: null,
        error: message,
        ...(message === specificFoldersRequired ? { errorCode: "FOLDER_SELECTION_REQUIRED" } : {}),
        ...(message === protectedFolder ? { errorCode: "FOLDER_PROTECTED" } : {}),
      }
    }
    if (input.machine === "cloud" && (input.anyFolderAccess || input.folders.length))
      return { input: null, error: "Pastas deste computador não estão disponíveis na nuvem." }
    // Narrowing/removing old grants and unrelated settings must remain possible
    // even when this host has lost its confinement capability.
    const expandsFolders =
      (input.anyFolderAccess && !existing?.anyFolderAccess) ||
      input.folders.some(
        (folder) =>
          !existing?.folders?.some(
            (old) => old.path === folder.path && (old.access === "read-write" || old.access === folder.access),
          ),
      )
    if (expandsFolders || (existing?.machine !== input.machine && input.machine === "local")) {
      const problem = folderGrantProblem({ ...input, machine: input.machine ?? "local" })
      if (problem)
        return {
          input: null,
          errorCode: problem === specificFoldersRequired ? "FOLDER_SELECTION_REQUIRED" : "FOLDER_ACCESS_UNAVAILABLE",
          error: problem,
        }
    }
    if (input.cwd !== undefined && input.cwd !== null && !isAbsolute(input.cwd))
      return { input: null, error: "cwd must be absolute" }
    if (
      body.providerProfile !== undefined &&
      body.providerProfile !== null &&
      !validProviderProfileName(body.providerProfile)
    )
      return { input: null, error: "providerProfile must be a profile name (letters, digits, dot, dash, underscore)" }
    input.providerProfile = Object.hasOwn(body, "providerProfile")
      ? ((body.providerProfile as string | null) ?? null)
      : (existing?.providerProfile ?? null)
    if (input.providerProfile !== null) {
      if (input.machine !== "local")
        return {
          input: null,
          error: "Perfis de login valem só para bots locais. A máquina do bot usa o próprio login.",
        }
      if (!isProfileProvider(provider))
        return { input: null, error: "Perfis de login estão disponíveis para Claude e Codex." }
    }
    if (body.claudeAiConnectors !== undefined && typeof body.claudeAiConnectors !== "boolean")
      return { input: null, error: "claudeAiConnectors must be a boolean" }
    input.claudeAiConnectors =
      provider === "claude" &&
      input.machine === "local" &&
      ((body.claudeAiConnectors as boolean | undefined) ?? existing?.claudeAiConnectors ?? false)
    return { input, error: null }
  }

  const createBot = ({ input }: { input: CreateBotInput }): Bot | null => {
    const id = kernel.newId()
    const instructions = input.instructions ?? ""
    const instructionsHash = sha256(instructions)
    const homeDir = ensureBotHome({ botId: id, instructions })
    const mainThreadId = kernel.newId()
    const timestamp = now()
    database
      .query(
        "INSERT INTO bots (id, name, title, role_line, description, color, avatar_path, avatar_shape, avatar_seed, instructions, instructions_hash, provider, model, reasoning_effort, access, approvals, project_id, cwd, home_dir, main_thread_id, browser_enabled, computer_use, notifications, section, sort_order, paused, source, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'failures', NULL, 0, 0, 'local', ?, ?, NULL)",
      )
      .run(
        id,
        input.name,
        input.title ?? null,
        input.roleLine ?? null,
        input.description ?? null,
        input.color ?? null,
        input.avatarShape ?? null,
        input.avatarSeed ?? null,
        instructions,
        instructionsHash,
        input.provider,
        input.model ?? null,
        input.reasoningEffort ?? null,
        input.access ?? "workspace-write",
        input.approvals ?? "on-request",
        input.projectId ?? null,
        input.cwd ?? null,
        homeDir,
        mainThreadId,
        input.browserEnabled === false ? 0 : 1,
        input.computerUse === true ? 1 : 0,
        timestamp,
        timestamp,
      )
    database
      .query(
        "UPDATE bots SET machine = ?, machine_idle_minutes = ?, vm_provider_login = ?, host_computer_use = ?, cloud_target = ?, browser = ? WHERE id = ?",
      )
      .run(
        input.machine === "cloud" ? "local" : (input.machine ?? "local"),
        input.machineIdleMinutes ?? DEFAULT_MACHINE_IDLE_MINUTES,
        input.vmProviderLogin ? 1 : 0,
        input.hostComputerUse ? 1 : 0,
        input.machine === "cloud" ? 1 : 0,
        input.browser ?? "touri",
        id,
      )
    database
      .query("UPDATE bots SET folders_json = ?, any_folder_access = ? WHERE id = ?")
      .run(JSON.stringify(input.folders ?? []), input.anyFolderAccess ? 1 : 0, id)
    database
      .query("UPDATE bots SET provider_profile = ?, claude_ai_connectors = ? WHERE id = ?")
      .run(input.providerProfile ?? null, input.claudeAiConnectors ? 1 : 0, id)
    database
      .query(
        "INSERT INTO threads (id, bot_id, parent_thread_id, kind, title, active_leaf_id, routine_run_id, cwd_override, unread, carryover_note, usage_json, source, created_at, updated_at, archived_at) VALUES (?, ?, NULL, 'main', ?, NULL, NULL, NULL, 0, NULL, ?, 'local', ?, ?, NULL)",
      )
      .run(mainThreadId, id, input.name, JSON.stringify(asUsage({})), timestamp, timestamp)
    const bot = getBot({ botId: id })
    if (bot) {
      kernel.publish({ type: "bot.updated", bot })
      const thread = getThread({ threadId: mainThreadId })
      if (thread) kernel.publish({ type: "thread.updated", thread })
    }
    return bot
  }

  const patchBot = ({
    bot,
    input,
    paused,
  }: {
    bot: Bot
    input: CreateBotInput
    paused: boolean | undefined
  }): Bot | null => {
    const instructions = input.instructions ?? bot.instructions
    const fields: Array<string> = [
      "name = ?",
      "provider = ?",
      "title = ?",
      "role_line = ?",
      "description = ?",
      "color = ?",
      "avatar_shape = ?",
      "avatar_seed = ?",
      "instructions = ?",
      "instructions_hash = ?",
      "model = ?",
      "reasoning_effort = ?",
      "access = ?",
      "approvals = ?",
      "project_id = ?",
      "cwd = ?",
      "browser_enabled = ?",
      "computer_use = ?",
      "updated_at = ?",
    ]
    const values: Array<string | number | null> = [
      input.name,
      input.provider,
      input.title ?? null,
      input.roleLine ?? null,
      input.description ?? null,
      input.color ?? null,
      input.avatarShape ?? null,
      input.avatarSeed ?? null,
      instructions,
      sha256(instructions),
      input.model ?? null,
      input.reasoningEffort ?? null,
      input.access ?? bot.access,
      input.approvals ?? bot.approvals,
      input.projectId ?? null,
      input.cwd ?? null,
      input.browserEnabled === true ? 1 : 0,
      input.computerUse === true ? 1 : 0,
      now(),
    ]
    if (paused !== undefined) {
      fields.push("paused = ?")
      values.push(paused ? 1 : 0)
    }
    database.query(`UPDATE bots SET ${fields.join(", ")} WHERE id = ?`).run(...values, bot.id)
    database
      .query(
        "UPDATE bots SET machine = ?, machine_idle_minutes = ?, vm_provider_login = ?, host_computer_use = ?, cloud_target = ?, browser = ? WHERE id = ?",
      )
      .run(
        input.machine === "cloud" ? "local" : (input.machine ?? bot.machine),
        input.machineIdleMinutes ?? bot.machineIdleMinutes,
        input.vmProviderLogin ? 1 : 0,
        input.hostComputerUse ? 1 : 0,
        input.machine === "cloud" ? 1 : 0,
        input.browser ?? bot.browser,
        bot.id,
      )
    database
      .query("UPDATE bots SET folders_json = ?, any_folder_access = ? WHERE id = ?")
      .run(JSON.stringify(input.folders ?? []), input.anyFolderAccess ? 1 : 0, bot.id)
    database
      .query("UPDATE bots SET provider_profile = ?, claude_ai_connectors = ? WHERE id = ?")
      .run(input.providerProfile ?? null, input.claudeAiConnectors ? 1 : 0, bot.id)
    ensureBotHome({ botId: bot.id, instructions })
    const updated = getBot({ botId: bot.id })
    if (updated) kernel.publish({ type: "bot.updated", bot: updated })
    return updated
  }

  kernel.services.provide("bots.rename", ({ botId, name: value }) => {
    const bot = getBot({ botId })
    if (!bot) return { success: false, errorCode: "NOT_FOUND", error: "Bot não encontrado." }
    const name = normalizeBotName(value)
    if (!name)
      return {
        success: false,
        errorCode: "INVALID_ARGS",
        error: "Use de 1 a 80 caracteres, sem quebras de linha ou caracteres de controle.",
      }
    // Identity changes must not reconfigure or stop a machine during its own turn.
    database.query("UPDATE bots SET name = ?, updated_at = ? WHERE id = ?").run(name, now(), botId)
    const updated = getBot({ botId })
    if (!updated) return { success: false, errorCode: "NOT_FOUND", error: "Bot não encontrado." }
    kernel.publish({ type: "bot.updated", bot: updated })
    return { success: true, bot: updated }
  })

  // MCP setup changes share PATCH's validation, storage and bot.updated event.
  // They must not stop a VM while its current turn is waiting for the tool.
  kernel.services.provide("bots.configureAccess", ({ botId, patch }) => {
    const bot = getBot({ botId })
    if (!bot) return { success: false, errorCode: "NOT_FOUND", error: "Bot não encontrado." }
    const parsed = botFromBody({ body: { ...patch, name: bot.name, provider: bot.provider }, existing: bot })
    if (!parsed.input || parsed.error)
      return { success: false, errorCode: "INVALID_ARGS", error: parsed.error ?? "Configuração inválida." }
    const machine = database.query("SELECT project_id FROM bot_machines WHERE bot_id = ?").get(botId) as {
      project_id: string | null
    } | null
    if (patch.projectId && machine?.project_id && patch.projectId !== machine.project_id)
      return {
        success: false,
        errorCode: "MACHINE_PROJECT_CHANGE",
        error: "Recrie a máquina do zero antes de trocar o projeto; o volume atual foi preservado",
      }
    const updated = patchBot({ bot, input: parsed.input, paused: undefined })
    return updated
      ? { success: true, bot: updated }
      : { success: false, errorCode: "NOT_FOUND", error: "Bot não encontrado." }
  })

  const insertAttachment = ({
    path,
    originPath,
    content,
  }: {
    path: string
    originPath: string | null
    content?: Buffer
  }): Attachment | null => {
    const bytes =
      content ?? readBoundedFile({ root: kernel.paths.attachmentsDir, path, maxBytes: MAX_ATTACHMENT_BYTES })
    const id = sha256(bytes)
    const existing = database.query("SELECT * FROM attachments WHERE id = ?").get(id) as RawAttachment | null
    if (existing) {
      // A user upload can share a hash with a managed tool result. Promote its
      // ownership so retention will keep the uploaded file after tools expire.
      if (existing.origin_path === OUTPUT_BLOB_ORIGIN && originPath !== null) {
        database.query("UPDATE attachments SET origin_path = ? WHERE id = ?").run(originPath, id)
        existing.origin_path = originPath
      }
      return asAttachment(existing)
    }
    const extension =
      extname(path)
        .toLowerCase()
        .replace(/[^a-z0-9.]/gu, "") || ".bin"
    const destinationDir = join(kernel.paths.attachmentsDir, id.slice(0, 2))
    const destination = join(destinationDir, `${id}${extension}`)
    assertPrivateFile({ root: kernel.paths.appData, path: destination })
    if (!existsSync(destination)) atomicWriteFile({ root: kernel.paths.appData, path: destination, content: bytes })
    const timestamp = now()
    database
      .query("INSERT INTO attachments (id, path, mime, bytes, origin_path, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, destination, attachmentMime(bytes), bytes.byteLength, originPath, timestamp)
    const attachment = database.query("SELECT * FROM attachments WHERE id = ?").get(id) as RawAttachment | null
    return attachment ? asAttachment(attachment) : null
  }

  const messageFromRequest = ({
    threadId,
    body,
  }: {
    threadId: string
    body: Record<string, unknown>
  }): { input: SendMessageInput | null; error: string | null } => {
    if (!isString(body.text) || !body.text.trim()) return { input: null, error: "text is required" }
    if (body.groupAction !== undefined && body.groupAction !== "ask_all" && body.groupAction !== "summarize")
      return { input: null, error: "Ação do grupo inválida." }
    const parentId =
      body.parentId === null || body.parentId === undefined ? null : isString(body.parentId) ? body.parentId : null
    if (body.parentId !== undefined && body.parentId !== null && parentId === null)
      return { input: null, error: "parentId must be a string or null" }
    const attachmentIds = body.attachmentIds === undefined ? [] : body.attachmentIds
    if (!Array.isArray(attachmentIds) || attachmentIds.some((value) => !isString(value)))
      return { input: null, error: "attachmentIds must be an array of ids" }
    return {
      input: {
        threadId,
        parentId,
        text: body.text,
        ...(body.groupAction === "ask_all" || body.groupAction === "summarize"
          ? { groupAction: body.groupAction }
          : {}),
        attachmentIds: attachmentIds as Array<string>,
        ...(body.clientNonce === undefined ? {} : { clientNonce: body.clientNonce as string }),
        ...(body.deadline === undefined ? {} : { deadline: body.deadline as number }),
      },
      error: null,
    }
  }

  const storeApi: StoreApi = {
    insertMessage,
    appendDelta: streamWriter.appendDelta,
    appendParts: streamWriter.appendParts,
    flushWrites: streamWriter.drain,
    updateMessage,
    activePath,
    setActiveLeaf,
    getBot,
    getThread,
    getPathMessage,
    createThread,
    updateThread,
    search,
  }
  Object.assign(storeApi, createSendJournal({ kernel, database, store: storeApi, getMessage }))
  kernel.services.provide("store.api", storeApi)
  kernel.services.provide("store.settings", () => readSettings({ database }))

  const handleCreateBot = async ({ body }: { body: unknown }): Promise<RouteResponse> => {
    const record = requestRecord(body)
    if (!record) return errorResponse(400, "INVALID_ARGS", "Request body must be an object")
    await refreshHostFolderAccess()
    const parsed = botFromBody({ body: record })
    if (!parsed.input || parsed.error)
      return errorResponse(400, parsed.errorCode ?? "INVALID_ARGS", parsed.error ?? "Invalid bot")
    if (parsed.input.machine === "cloud" && !(await kernel.services.use("cloud.account")?.connected()))
      return errorResponse(401, "TOURI-E9001", "Conecte sua conta")
    const bot = createBot({ input: parsed.input })
    if (bot?.machine === "cloud") {
      try {
        await kernel.services
          .use("cloud.account")
          ?.createBot(bot, typeof record.cloudApiKey === "string" ? record.cloudApiKey : undefined)
      } catch (error) {
        database.query("UPDATE bots SET archived_at = ?, paused = 1 WHERE id = ?").run(Date.now(), bot.id)
        throw error
      }
    }
    return bot ? jsonResponse(201, { bot }) : errorResponse(500, "STORE_ERROR", "Bot could not be created")
  }

  const routes: RouteModule = {
    name: "store",
    routes: [
      {
        method: "GET",
        path: "/workspace/activity",
        handler: async () => {
          flushDeltas()
          const { messages, runs } = readWorkspaceActivity(database)
          return jsonResponse(200, { messages: messages.map(asMessage), runs })
        },
      },
      {
        method: "GET",
        path: "/health",
        handler: async () =>
          jsonResponse(200, {
            ok: true,
            version: touriVersion,
            schemaVersion: SCHEMA_VERSION,
            ...getHostIdentity(),
          }),
      },
      {
        method: "GET",
        path: "/bots",
        handler: async () => {
          const rows = database.query(BOTS_SQL).all() as Array<RawBot>
          return jsonResponse(200, { bots: rows.map(asBot) })
        },
      },
      { method: "POST", path: "/bots", handler: async ({ body }) => handleCreateBot({ body }) },
      {
        method: "PATCH",
        path: "/bots/:id",
        handler: async ({ params, body }) => {
          await refreshHostFolderAccess()
          const bot = getBot({ botId: params.id ?? "" })
          if (!bot) return errorResponse(404, "NOT_FOUND", "Bot not found")
          const record = requestRecord(body)
          if (!record) return errorResponse(400, "INVALID_ARGS", "Request body must be an object")
          const parsed = botFromBody({
            body: { ...record, provider: record.provider ?? bot.provider },
            existing: bot,
          })
          if (!parsed.input || parsed.error)
            return errorResponse(400, parsed.errorCode ?? "INVALID_ARGS", parsed.error ?? "Invalid bot")
          if (record.paused !== undefined && typeof record.paused !== "boolean")
            return errorResponse(400, "INVALID_ARGS", "paused must be a boolean")
          const machineRow = database.query("SELECT project_id FROM bot_machines WHERE bot_id = ?").get(bot.id) as {
            project_id: string | null
          } | null
          if (machineRow?.project_id && parsed.input.projectId !== bot.projectId)
            return errorResponse(
              409,
              "MACHINE_PROJECT_CHANGE",
              "Recrie a máquina do zero antes de trocar o projeto; o volume atual foi preservado",
            )
          if (
            parsed.input.machine !== bot.machine ||
            parsed.input.provider !== bot.provider ||
            parsed.input.projectId !== bot.projectId
          ) {
            try {
              await kernel.services.use("vm.runtime")?.stop({ botId: bot.id })
            } catch (error) {
              return errorResponse(409, "MACHINE_BUSY", String(error))
            }
          }
          const updated = patchBot({ bot, input: parsed.input, paused: record.paused as boolean | undefined })
          return updated
            ? jsonResponse(200, { bot: updated })
            : errorResponse(500, "STORE_ERROR", "Bot could not be updated")
        },
      },
      {
        method: "GET",
        path: "/bots/:id/threads",
        handler: async ({ params }) => {
          if (!getBot({ botId: params.id ?? "" })) return errorResponse(404, "NOT_FOUND", "Bot not found")
          const threadBotId = params.id ?? ""
          const rows = database
            .query(
              "SELECT * FROM threads WHERE bot_id = ? AND group_id IS NULL AND archived_at IS NULL ORDER BY updated_at DESC",
            )
            .all(threadBotId) as Array<RawThread>
          return jsonResponse(200, { threads: rows.map(asThread) })
        },
      },
      {
        method: "POST",
        path: "/threads",
        handler: async ({ body }) => {
          const record = requestRecord(body)
          if (!record || !isString(record.botId)) return errorResponse(400, "INVALID_ARGS", "botId is required")
          const title = isString(record.title) && record.title.trim() ? record.title.trim() : "New chat"
          const result = createThread({ botId: record.botId, kind: "chat", title })
          return result.success
            ? jsonResponse(201, { thread: result.thread })
            : errorResponse(404, result.errorCode, result.error)
        },
      },
      {
        method: "PATCH",
        path: "/threads/:id",
        handler: async ({ params, body }) => {
          const thread = getThread({ threadId: params.id ?? "" })
          if (!thread) return errorResponse(404, "NOT_FOUND", "Thread not found")
          const record = requestRecord(body)
          if (!record) return errorResponse(400, "INVALID_ARGS", "Request body must be an object")
          if (record.title !== undefined && !isString(record.title))
            return errorResponse(400, "INVALID_ARGS", "title must be a string")
          if (record.activeLeafId !== undefined && !isString(record.activeLeafId))
            return errorResponse(400, "INVALID_ARGS", "activeLeafId must be a string")
          if (record.archived !== undefined && typeof record.archived !== "boolean")
            return errorResponse(400, "INVALID_ARGS", "archived must be a boolean")
          const patch: Partial<Pick<Thread, "title" | "activeLeafId">> = {}
          if (isString(record.title)) patch.title = record.title
          if (isString(record.activeLeafId)) {
            if (!getMessage({ threadId: thread.id, messageId: record.activeLeafId }))
              return errorResponse(404, "NOT_FOUND", "Mensagem não encontrada")
            // Version buttons select a branch root. Restore its latest leaf.
            const leaf = database
              .query(`
              WITH RECURSIVE branch(id) AS (
                SELECT id FROM messages WHERE thread_id = ? AND id = ?
                UNION
                SELECT m.id FROM messages m JOIN branch b ON m.parent_id = b.id WHERE m.thread_id = ?
              )
              SELECT m.id FROM messages m JOIN branch b ON b.id = m.id
              WHERE NOT EXISTS (SELECT 1 FROM messages child WHERE child.thread_id = m.thread_id AND child.parent_id = m.id)
              ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1
            `)
              .get(thread.id, record.activeLeafId, thread.id) as { id: string } | null
            patch.activeLeafId = leaf?.id ?? record.activeLeafId
          }
          const updated = updateThread({ threadId: thread.id, patch })
          if (!updated.success) return errorResponse(404, updated.errorCode, updated.error)
          if (record.archived !== undefined)
            database
              .query("UPDATE threads SET archived_at = ?, updated_at = ? WHERE id = ?")
              .run(record.archived ? now() : null, now(), thread.id)
          const finalRow = database.query("SELECT * FROM threads WHERE id = ?").get(thread.id) as RawThread | null
          const finalThread = finalRow ? asThread(finalRow) : null
          return finalThread
            ? jsonResponse(200, { thread: finalThread })
            : errorResponse(404, "NOT_FOUND", "Thread not found")
        },
      },
      {
        method: "GET",
        path: "/threads/:id/transcript",
        handler: async ({ params, query }) => {
          const cloudThread = getThread({ threadId: params.id ?? "" })
          if (cloudThread && getBot({ botId: cloudThread.botId })?.machine === "cloud") {
            const cloud = kernel.services.use("cloud.account")
            if (!cloud) return errorResponse(503, "TOURI-E9013", "Nuvem desativada")
            const suffix = Object.keys(query).length ? `?${new URLSearchParams(query)}` : ""
            return jsonResponse(
              200,
              await cloud.request("GET", `/v1/threads/${encodeURIComponent(cloudThread.id)}/transcript${suffix}`),
            )
          }
          flushDeltas()
          const thread = getThread({ threadId: params.id ?? "" })
          if (!thread) return errorResponse(404, "NOT_FOUND", "Conversa não encontrada")
          const since = Number(query.since ?? 0)
          const limit = Number(query.limit ?? 500)
          if (!Number.isSafeInteger(since) || since < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
            return errorResponse(400, "INVALID_CURSOR", "Sequência ou limite inválido")
          const floor = database
            .query("SELECT through_seq FROM transcript_retention WHERE thread_id = ?")
            .get(thread.id) as { through_seq: number } | null
          // Pending legacy threads hydrate through /messages. Their reserved
          // revisions must not look like an empty, up-to-date transcript.
          const resync =
            historyThreadPending(database, thread.id) ||
            since < (floor?.through_seq ?? 0) ||
            since > (thread.updatedSeq ?? 0)
          const rows = database
            .query(
              "SELECT seq, generation, event_json FROM transcript_entries WHERE thread_id = ? AND seq > ? ORDER BY seq LIMIT ?",
            )
            .all(thread.id, resync ? (thread.updatedSeq ?? 0) : since, limit + 1) as Array<{
            seq: number
            generation: number
            event_json: string
          }>
          const entries = rows.slice(0, limit).map((row) => ({
            seq: row.seq,
            generation: row.generation,
            event: hydrateHistoryEvent(database, row.event_json),
          }))
          return jsonResponse(200, {
            entries,
            rejections: entries.flatMap(({ event }) => (event.type === "transcript.rejected" ? [event.rejection] : [])),
            lastSeq: thread.updatedSeq,
            generation: thread.generation,
            hasMore: rows.length > limit,
            resync,
          })
        },
      },
      {
        method: "GET",
        path: "/threads/:id/messages",
        handler: async ({ params, query }) => {
          const cloudThread = getThread({ threadId: params.id ?? "" })
          if (cloudThread && getBot({ botId: cloudThread.botId })?.machine === "cloud") {
            const cloud = kernel.services.use("cloud.account")
            if (!cloud) return errorResponse(503, "TOURI-E9013", "Nuvem desativada")
            const suffix = Object.keys(query).length ? `?${new URLSearchParams(query)}` : ""
            return jsonResponse(
              200,
              await cloud.request("GET", `/v1/threads/${encodeURIComponent(cloudThread.id)}/messages${suffix}`),
            )
          }
          flushDeltas()
          const thread = getThread({ threadId: params.id ?? "" })
          if (!thread) return errorResponse(404, "NOT_FOUND", "Thread not found")
          const messages =
            query.all === "true"
              ? (
                  database
                    .query("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC")
                    .all(thread.id) as Array<RawMessage>
                ).map(asMessage)
              : activePath({ threadId: thread.id })
          return jsonResponse(200, { messages, activeLeafId: thread.activeLeafId })
        },
      },
      {
        method: "POST",
        path: "/threads/:id/messages",
        handler: async ({ params, body }) => {
          const record = requestRecord(body)
          if (!record) return errorResponse(400, "INVALID_ARGS", "Request body must be an object")
          const parsed = messageFromRequest({ threadId: params.id ?? "", body: record })
          if (!parsed.input || parsed.error)
            return errorResponse(400, "INVALID_ARGS", parsed.error ?? "Invalid message")
          const thread = getThread({ threadId: parsed.input.threadId })
          if (thread && getBot({ botId: thread.botId })?.machine === "cloud") {
            const cloud = kernel.services.use("cloud.account")
            if (!cloud) return errorResponse(503, "TOURI-E9013", "Nuvem desativada")
            return jsonResponse(200, await cloud.send(parsed.input))
          }
          return (
            storeApi.sendMessage?.(parsed.input) ??
            errorResponse(503, "RUNTIME_UNAVAILABLE", "Serviço de envio indisponível")
          )
        },
      },
      {
        method: "GET",
        path: "/search",
        handler: async ({ query }) => {
          const hits =
            query.botId === undefined
              ? search({ q: query.q ?? "", limit: 50 })
              : search({ q: query.q ?? "", botId: query.botId, limit: 50 })
          return jsonResponse(200, { hits })
        },
      },
      {
        method: "POST",
        path: "/attachments",
        handler: async ({ body, signal }) => {
          const record = requestRecord(body)
          if (record && "path" in record)
            return errorResponse(403, "FILE_GRANT_REQUIRED", "Selecione o arquivo e envie seu conteúdo")
          if (record && "grantId" in record) {
            const granted = await redeemFileGrant({ kernel, grantId: record.grantId, signal })
            if (!granted.success) return errorResponse(granted.status, granted.errorCode, granted.error)
            const attachment = insertAttachment({
              path: granted.name,
              originPath: granted.name,
              content: granted.content,
            })
            return attachment
              ? jsonResponse(201, { attachment })
              : errorResponse(404, "NOT_FOUND", "Attachment source file not found")
          }
          if (
            record &&
            isString(record.dataBase64) &&
            record.dataBase64.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4
          )
            return errorResponse(413, "ATTACHMENT_TOO_LARGE", "Arquivo acima de 15 MB")
          if (
            !record ||
            !isString(record.dataBase64) ||
            !isString(record.name) ||
            record.name.length > 255 ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record.dataBase64)
          )
            return errorResponse(400, "INVALID_ARGS", "Envie um arquivo de até 15 MB")
          try {
            const content = Buffer.from(record.dataBase64, "base64")
            if (content.length > MAX_ATTACHMENT_BYTES)
              return errorResponse(413, "ATTACHMENT_TOO_LARGE", "Arquivo acima de 15 MB")
            const attachment = insertAttachment({ path: record.name, originPath: record.name, content })
            return attachment
              ? jsonResponse(201, { attachment })
              : errorResponse(404, "NOT_FOUND", "Attachment source file not found")
          } catch (error) {
            return errorResponse(
              400,
              "ATTACHMENT_ERROR",
              error instanceof Error ? error.message : "Attachment could not be read",
            )
          }
        },
      },
      {
        method: "GET",
        path: "/attachments/:id/content",
        handler: async ({ params, query }) =>
          readOutputAttachment({ database, appData: kernel.paths.appData, id: params.id ?? "", query }),
      },
      {
        method: "GET",
        path: "/attachments/:id",
        handler: async ({ params }) => {
          const raw = database
            .query("SELECT * FROM attachments WHERE id = ?")
            .get(params.id ?? "") as RawAttachment | null
          if (!raw || !existsSync(raw.path)) return errorResponse(404, "NOT_FOUND", "Attachment not found")
          return { status: 200, file: raw.path, mime: raw.mime }
        },
      },
      {
        method: "GET",
        path: "/settings",
        handler: async () => jsonResponse(200, { settings: readSettings({ database }) }),
      },
      {
        method: "PATCH",
        path: "/settings",
        handler: async ({ body }) => {
          const record = requestRecord(body)
          if (!record) return errorResponse(400, "INVALID_ARGS", "Request body must be an object")
          const validationError = validSettingsPatch(record)
          if (validationError) return errorResponse(400, "INVALID_ARGS", validationError)
          const settings = { ...readSettings({ database }), ...record } as AppSettings
          writeSettings({ database, settings })
          if (Object.hasOwn(record, "maxConcurrentRuns")) kernel.services.use("runtime.settingsChanged")?.()
          if (
            Object.hasOwn(record, "cloud") ||
            Object.hasOwn(record, "cloudBaseUrl") ||
            Object.hasOwn(record, "cloudWebOrigin")
          )
            kernel.services.use("cloud.settingsChanged")?.()
          return jsonResponse(200, { settings: readSettings({ database }) })
        },
      },
    ],
  }
  kernel.registerRoutes(routes)
}
