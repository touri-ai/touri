import type { ApiModel, ApiModelConnection, ApiModelError, ApiModelInput, ApiModelTest } from "./api-models"
import type { HostKind } from "./host"

/**
 * touri desktop shared contracts, v0.
 *
 * Owned by WP0. After WP0 lands, this file lives at packages/contracts/src/types.ts and is the
 * single source of truth for every work package. Changing a type here is a contract change:
 * it needs a PR that touches only packages/contracts and is approved before dependent work merges.
 *
 * Style: `type` only (no classes, no interfaces with methods on objects that carry state),
 * string-literal unions instead of enums, RO-RO arguments, Result unions with `success`.
 */

/* ------------------------------------------------------------------------------------------ */
/* Primitives                                                                                  */
/* ------------------------------------------------------------------------------------------ */

export type Id = string
export type EpochMs = number
export type AbsolutePath = string

export type Provider = 'codex' | 'claude' | 'opencode'
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh'
export type BotAccess = 'read-only' | 'workspace-write' | 'full'
export type ApprovalMode = 'never' | 'on-request'
export type BotMachine = 'local' | 'vm' | 'cloud'
export type MachineIntent = 'composer-focus' | 'composer-typing' | 'computer-open' | 'computer-visible' | 'computer-hidden' | 'foreground' | 'background' | 'idle'
export type WorkspaceFile = { name: string; path: string; directory: boolean; bytes: number }
export type WorkspaceFileContent = { name: string; mime: string; base64: string }
export type MachineConnection = {
  machineId: string
  provider: string
  endpoints: { browser: string; bridge: string }
  ports: Array<{ guestPort: number; hostPort: number; hostIp: string; protocol: 'tcp' | 'udp'; url: string }>
  display: { name: string; width: number; height: number }
  bridge: { guestPort: number; socketPath: string; connectionFile: string }
  authKeyId: string | null
}
export type MachineState = { cloud?: { state: import('./cloud').CloudState; generation: number; usage: import('./cloud').CloudUsage }; botId: Id; status: 'stopped' | 'starting' | 'running' | 'error'; progress: string | null; pauseReason?: 'inactivity' | null; error: string | null; errorCode?: string | null; memoryMb: number; createdMs: number | null; startMs: number | null; connection?: MachineConnection | null }
export type MachineCapability = { available: boolean; reason: string | null; provider: string | null }
export type RowSource = 'local' | 'legacy'

export type Ok<T> = { success: true } & T
export type Err<C extends string = string> = { success: false; error: string; errorCode: C }
export type Result<T, C extends string = string> = Ok<T> | Err<C>

/* ------------------------------------------------------------------------------------------ */
/* Domain rows (camelCase mirror of schema.sql)                                                */
/* ------------------------------------------------------------------------------------------ */

export type DiscoveredProject = { path: AbsolutePath; name: string; lastModified: number }

export type FolderListing = {
  /** Whether this host can enforce provider folder grants. Browsing alone grants nothing. */
  canGrant: boolean
  home: AbsolutePath
  path: AbsolutePath
  parent: AbsolutePath | null
  folders: Array<{ name: string; path: AbsolutePath }>
  truncated: boolean
}

export type Project = {
  id: Id
  name: string
  path: AbsolutePath
  gitRemote: string | null
  defaultBranch: string | null
  dataDir: AbsolutePath
  createdAt: EpochMs
  updatedAt: EpochMs
  archivedAt: EpochMs | null
}

export type SecretUsage = { env: boolean; browser: boolean }

export type SecretMeta = {
  id: Id
  projectId: Id | null
  name: string
  usage: SecretUsage
  browserOrigin: string | null
  createdAt: EpochMs
  updatedAt: EpochMs
}

export type McpToolPolicy = 'always_allow' | 'needs_approval' | 'blocked'
export type McpTool = { name: string; description: string; inputSchema?: Record<string, unknown>; classification?: 'reads' | 'writes'; policy?: McpToolPolicy }
/** Hermes-style continuous learning for one bot; every switch is off by default. */
export type BotLearningSettings = {
  /** memory_write is available and periodic reviews may save facts to MEMORY.md and USER.md. */
  memory: boolean
  /** skill_* tools are available and periodic reviews may propose skills. */
  skills: boolean
  /** A memory review runs after this many completed user turns. */
  memoryEveryTurns: number
  /** A skills review runs once this many tool calls have happened since the last skill change. */
  skillsAfterToolCalls: number
}

export type BotLearning = BotLearningSettings & {
  turns: number
  toolCalls: number
  reviewThreadId: Id | null
  memoryChars: number
  userChars: number
  /** Counts are unavailable when the corresponding local reference cannot be safely read. */
  memoryError?: 'INVALID_PATH' | 'READ_ERROR'
  userError?: 'INVALID_PATH' | 'READ_ERROR'
  skillCount: number
}

export type McpServer = ({ name: string; transport: 'stdio'; command: string; args: Array<string> } | { name: string; transport: 'http'; url: string }) & { tools: Array<McpTool> }

export type McpPrerequisites = {
  machine: Bot['machine']
  status: 'checked' | 'unavailable'
  node: boolean
  oauthKeys: boolean
  credentials: boolean
}
export type ApprovalScope = { source: 'mcp' | 'computer' | 'claude' | 'opencode'; tool: string; server?: string }
export type StandingGrant = { id: Id; botId: Id; scope: ApprovalScope; grantedAt: EpochMs }
export type BotCapability = 'browser' | 'computer_use'
export type CapabilityRequestInput = { capability: BotCapability; reason: string }

export type ApprovalInput = { groupMemberId?: Id; ctx: Pick<ToolContext, 'botId' | 'threadId' | 'runId' | 'signal'>; scope: ApprovalScope; toolName: string; input: unknown; toolUseId?: string; allowStanding?: boolean; isCurrent?: () => boolean }
export type ApprovalResult = Result<{ behavior: 'allow' | 'deny'; updatedInput?: unknown; message?: string }, 'NOT_FOUND' | 'TIMEOUT' | 'DENIED'>

export type BotFolder = { path: AbsolutePath; access: 'read-only' | 'read-write' }
export type BotBrowser = 'touri' | 'local' | 'machine'

export type Bot = {
  /** Defaults for bots created before schema 16: [] and false. */
  folders?: Array<BotFolder>
  anyFolderAccess?: boolean
  mcpServers?: Array<McpServer>
  /** Defaults for bots created before schema 17: null and false. */
  providerProfile?: string | null
  claudeAiConnectors?: boolean

  id: Id
  name: string
  title: string | null
  roleLine?: string | null
  description: string | null
  color: string | null
  avatarPath: AbsolutePath | null
  avatarShape?: AvatarShape | null
  avatarSeed?: string | null
  instructions: string
  instructionsHash: string
  provider: Provider
  model: string | null
  reasoningEffort: ReasoningEffort | null
  access: BotAccess
  approvals: ApprovalMode
  projectId: Id | null
  cwd: AbsolutePath | null
  homeDir: AbsolutePath
  mainThreadId: Id | null
  browserEnabled: boolean
  browser: BotBrowser
  computerUse: boolean
  machine: BotMachine
  machineIdleMinutes: number
  vmProviderLogin: boolean
  hostComputerUse: boolean
  notifications: 'all' | 'failures' | 'none'
  section: string | null
  sortOrder: number
  paused: boolean
  source: RowSource
  createdAt: EpochMs
  updatedAt: EpochMs
  archivedAt: EpochMs | null
}

export type ThreadKind = 'main' | 'chat' | 'routine'

export type ThreadUsage = {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  costUsd: number | null
  turns: number
  contextTokens: number | null
  contextWindow: number | null
}

export type BotGroup = {
  id: Id
  name: string
  color: string
  avatarShape: AvatarShape
  avatarSeed: string
  memberIds: Array<Id>
  coordinatorBotId: Id | null
  createdAt: EpochMs
  updatedAt: EpochMs
}
export type GroupInput = Pick<BotGroup, 'name' | 'color' | 'avatarShape' | 'memberIds' | 'coordinatorBotId'>

export type Thread = {
  groupId?: Id | null
  groupThreadId?: Id | null
  generation?: number
  updatedSeq?: number
  id: Id
  botId: Id
  parentThreadId: Id | null
  kind: ThreadKind
  title: string
  activeLeafId: Id | null
  routineRunId: Id | null
  cwdOverride: AbsolutePath | null
  unread: number
  carryoverNote: string | null
  usage: ThreadUsage
  source: RowSource
  createdAt: EpochMs
  updatedAt: EpochMs
  archivedAt: EpochMs | null
}

export type ProviderSessionState = 'active' | 'replaced' | 'failed'

export type ProviderSession = {
  id: Id
  threadId: Id
  provider: Provider
  externalSessionId: string
  rolloutPath: AbsolutePath | null
  fingerprint: string
  state: ProviderSessionState
  model: string | null
  createdAt: EpochMs
  lastUsedAt: EpochMs
}

/** Inputs hashed (sha256 of canonical JSON) to decide resume vs replace. */
export type SessionFingerprint = {
  provider: Provider
  cwd: AbsolutePath
  access: BotAccess
  mcpServers: Array<{ name: string; command: string; args: Array<string> }>
  toolsetVersion: string
}

export type RunStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'interrupted'

export type RunTrigger = 'user' | 'routine' | 'retry' | 'import'

export type RunErrorClass =
  | 'cli_missing'
  | 'cli_auth'
  | 'cli_crash'
  | 'machine_service_unavailable'
  | 'machine_service_start_failed'
  | 'cli_protocol'
  | 'rate_limit'
  | 'context_overflow'
  | 'timeout'
  | 'canceled'
  | 'oom'
  | 'tool_error'
  | 'app_restart'
  | 'unknown'

export type RunUsage = {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  costUsd: number | null
  durationMs: number
  toolCalls: number
}

export type Run = {
  /** Group projection only: persisted association lives in group_run_links. */
  groupTurnId?: Id
  id: Id
  threadId: Id
  /** Visible group conversation; threadId always identifies the actual execution thread. */
  groupThreadId?: Id | null
  botId: Id
  provider: Provider
  trigger: RunTrigger
  requestMessageId: Id | null
  replyMessageId: Id | null
  externalTurnId: string | null
  status: RunStatus
  /** Engine snapshot, 1-based within the waiting queue; null outside that queue. */
  queuePosition?: number | null
  queueTotal?: number | null
  /** Origin derived from the request and continuation records. */
  origin?: 'message' | 'routine' | 'delegation' | 'resume'
  errorClass: RunErrorClass | null
  errorMessage: string | null
  usage: RunUsage | null
  routineRunId: Id | null
  queuedAt: EpochMs
  startedAt: EpochMs | null
  /** Provider invocation, after environment preparation. Absent on older runs. */
  providerStartedAt?: EpochMs | null
  finishedAt: EpochMs | null
}

/** A persisted interruption, shared by chat, notifications and the recovery center. */
export type RecoveryTask = {
  id: string
  notification: NotificationRecord
  runId: Id | null
  routineId: Id | null
  cause: RunErrorClass | null
  occurredAt: EpochMs
  effects: Array<{ description: string; uncertain: boolean; acknowledgeKey: string | null }>
}

/** Explicit, bounded work across provider turns in one local conversation. */
export type Goal = {
  id: Id
  threadId: Id
  botId: Id
  requestMessageId: Id
  text: string
  completionCriterion: string
  status: 'active' | 'paused' | 'budget_exhausted' | 'completed'
  maxTurns: number
  turnsUsed: number
  deadlineAt: EpochMs
  runId: Id | null
  steps: Array<{ runId: Id; text: string; at: EpochMs }>
  createdAt: EpochMs
  updatedAt: EpochMs
}

export type GoalStart = { requestMessageId: Id; completionCriterion: string; maxTurns: number; maxMinutes: number }
export type GoalControl = { action: 'pause' | 'resume' | 'complete' | 'budget'; maxTurns?: number; maxMinutes?: number }

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool'
export type MessageKind = 'text' | 'tool' | 'notice' | 'approval'
export type MessageStatus = 'streaming' | 'complete' | 'failed' | 'canceled'

export type TextPart = { type: 'text'; text: string }
export type ReasoningPart = { type: 'reasoning'; text: string; estimatedTokens?: number }
export type ImagePart = { type: 'image'; attachmentId: Id; mime: string; name?: string }
export type FilePart = { type: 'file'; attachmentId: Id; name: string; mime: string }
export type ToolResolution = 'running' | 'succeeded' | 'failed' | 'canceled' | 'interrupted' | 'unknown' | 'cancelled_by_user' | 'interrupted_by_restart' | 'completed_unobserved'
export type TranscriptAppend = { threadId: Id; messageId: Id; partIndex: number; delta: string; generation?: number; expectedSeq?: number }
export type TranscriptRejection = {
  threadId: Id
  messageId: Id
  partIndex: number | null
  reason: 'stale_generation' | 'seq_conflict' | 'oversize' | 'validation'
  seq: number
  generation: number
  expectedGeneration: number | null
  expectedSeq: number | null
  at: EpochMs
}
export type DeliveryState = { clientNonce: string; deadline: EpochMs; status: 'queued' | 'sent' | 'acked' | 'failed' }

export type ToolCallPart = {
  startedAt?: EpochMs
  outputMode?: 'streaming' | 'on_completion'
  outputTail?: string
  outputAttachmentId?: Id
  outputBytes?: number
  outputPreview?: string
  resolution?: ToolResolution
  resolvedAt?: EpochMs | null
  type: 'tool_call'
  callId: string
  tool: string
  summary: string
  inputJson: string
  outputJson: string | null
  ok: boolean | null
}
export type CommandPart = {
  startedAt?: EpochMs
  outputMode?: 'streaming' | 'on_completion'
  outputAttachmentId?: Id
  outputBytes?: number
  outputPreview?: string
  resolution?: ToolResolution
  resolvedAt?: EpochMs | null
  type: 'command'
  callId: string
  command: string
  cwd: string
  exitCode: number | null
  outputTail: string
}
export type FileChangePart = { outputAttachmentId?: Id; outputBytes?: number; outputPreview?: string; resolution?: ToolResolution; resolvedAt?: EpochMs | null; completedOutcome?: 'succeeded' | 'failed'; type: 'file_change'; callId: string; paths: Array<string>; diff: string | null }
export type NoticePart = {
  failure?: import('./run-failure').RunFailureDetail
  type: 'notice'
  level: 'info' | 'warning' | 'error'
  code:
    | 'group_ask_all'
    | 'group_summary'
    | 'group_member_removed'
    | 'group_coordination_prompt'
    | 'run_failed'
    | 'run_canceled'
    | 'session_replaced'
    | 'context_restored'
    | 'compaction'
    | 'routine_run'
    | 'imported'
    | 'app_restart'
    | 'run_resumed'
    | 'folder_access_unavailable'
  text: string
}
export type ApprovalPart = {
  /** A delegation approval belongs to the caller but waits on this group member. */
  groupMemberId?: Id
  type: 'approval'
  createdAt?: EpochMs
  approvalId: Id
  botId?: Id
  request: 'command' | 'file_change' | 'permission'
  detail: string
  decision: 'pending' | 'approved' | 'denied' | 'expired'
  scope?: ApprovalScope
  allowStanding?: boolean
  resolvedAt?: EpochMs
  standing?: boolean
}

export type MessagePart =
  | TextPart
  | ReasoningPart
  | ImagePart
  | FilePart
  | ToolCallPart
  | CommandPart
  | FileChangePart
  | NoticePart
  | ApprovalPart

export type Message = {
  seq?: number
  generation?: number
  updatedSeq?: number
  delivery?: DeliveryState | null
  id: Id
  threadId: Id
  parentId: Id | null
  role: MessageRole
  kind: MessageKind
  status: MessageStatus
  runId: Id | null
  text: string
  parts: Array<MessagePart>
  sender: { name: string; id: string } | null
  source: RowSource
  createdAt: EpochMs
  updatedAt: EpochMs
}

export type Attachment = {
  id: Id
  path: AbsolutePath
  mime: string
  bytes: number
  originPath: string | null
  createdAt: EpochMs
}

export type RoutineContinuity = 'new-thread' | 'results-thread' | 'main-thread'

export type Routine = {
  id: Id
  botId: Id
  name: string
  prompt: string
  cron: string
  timezone: string
  enabled: boolean
  continuity: RoutineContinuity
  resultsThreadId: Id | null
  /** When set, the prompt is posted into a conversation of this group, which routes it like a user message. */
  groupId: Id | null
  timeoutMinutes: number
  overlap: 'skip' | 'queue'
  catchUpMinutes: number
  nextRunAt: EpochMs | null
  source: RowSource
  createdAt: EpochMs
  updatedAt: EpochMs
}

export type Mem0Mode = 'platform' | 'server'

/** Optional Mem0 memory provider for one bot. The API key itself is never returned, only whether one is saved. */
export type Mem0Settings = {
  enabled: boolean
  mode: Mem0Mode
  /** Base URL of a self-hosted Mem0 server; unused in platform mode. */
  url: string
  /** `user` shares facts about the owner across bots; `bot` keeps them to this bot. */
  scope: 'user' | 'bot'
  autoSync: boolean
  topK: number
  threshold: number
  hasApiKey: boolean
}

/** `apiKey: null` removes the saved key. */
export type Mem0SettingsPatch = Partial<Omit<Mem0Settings, 'hasApiKey'>> & { apiKey?: string | null }

export type RoutineRunStatus = 'scheduled' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'canceled'

export type RoutineRun = {
  id: Id
  routineId: Id
  scheduledFor: EpochMs
  status: RoutineRunStatus
  threadId: Id | null
  runId: Id | null
  triggerSource: 'cron' | 'manual' | 'catch-up' | 'import'
  summary: string | null
  startedAt: EpochMs | null
  finishedAt: EpochMs | null
}

/* ------------------------------------------------------------------------------------------ */
/* Processes, ports, preview                                                                   */
/* ------------------------------------------------------------------------------------------ */

export type EnvValue = string | { secret: string }

export type ReadyCheck = { port: number } | { logRegex: string } | { http: string }

export type ProcessSpec = {
  vmBotId?: Id | null
  id: Id
  projectId: Id
  name: string
  command: string
  cwd: AbsolutePath
  env: Record<string, EnvValue>
  autostart: boolean
  restart: 'never' | 'on-failure' | 'always'
  dependsOn: Array<string>
  ready: ReadyCheck | null
  previewPort: number | null
  createdBy: 'user' | 'agent'
  createdAt: EpochMs
  updatedAt: EpochMs
}

export type ProcessRunStatus = 'starting' | 'running' | 'ready' | 'exited' | 'crashed' | 'stopped'

export type ListeningPort = { port: number; host: string; pid: number; detectedAt: EpochMs; via: 'lsof' | 'log' }

export type ProcessRunState = {
  id: Id
  processId: Id
  pid: number | null
  pgid: number | null
  status: ProcessRunStatus
  exitCode: number | null
  signal: string | null
  ports: Array<ListeningPort>
  logPath: AbsolutePath
  startedAt: EpochMs
  endedAt: EpochMs | null
}

export type PreviewTarget = {
  vmBotId?: Id | null
  projectId: Id
  processId: Id | null
  url: string
  port: number
  label: string
}

/* ------------------------------------------------------------------------------------------ */
/* Browser                                                                                     */
/* ------------------------------------------------------------------------------------------ */

/** Ref format: "<generation>.<index>", e.g. "12.34". Valid only while the tab generation is 12. */
export type BrowserRef = string

export type BrowserTarget =
  | { kind: 'ref'; ref: BrowserRef }
  | { kind: 'role'; role: string; name?: string; exact?: boolean }
  | { kind: 'text'; text: string; exact?: boolean }
  | { kind: 'css'; selector: string }
  | { kind: 'point'; x: number; y: number }

export type BrowserElement = {
  ref: BrowserRef
  role: string
  name: string
  value?: string
  states: Array<'checked' | 'disabled' | 'expanded' | 'focused' | 'selected' | 'required' | 'readonly'>
  frame: string
  inViewport: boolean
}

export type BrowserActionRecord = {
  at: EpochMs
  tool: string
  target: string
  ok: boolean
  errorCode: BrowserErrorCode | null
  note: string
}

export type BrowserDiagnostic = {
  at: EpochMs
  kind: 'console' | 'network' | 'load' | 'dialog' | 'popup'
  level: 'info' | 'warning' | 'error'
  text: string
}

export type SnapshotImageReason = 'canvas-or-video' | 'iframe' | 'low-semantic-coverage' | 'requested'

export type BrowserSnapshot = {
  tabId: Id
  generation: number
  url: string
  title: string
  loading: boolean
  viewport: { width: number; height: number; scrollY: number; scrollHeight: number }
  focus: { ref: BrowserRef | null; role: string | null; name: string | null }
  elements: Array<BrowserElement>
  text: string
  truncated: boolean
  recentActions: Array<BrowserActionRecord>
  diagnostics: Array<BrowserDiagnostic>
  image: { dataUrl: string; reason: SnapshotImageReason } | null
  recommendImage: SnapshotImageReason | null
  heldByUser: boolean
  notes: Array<string>
}

export type BrowserErrorCode =
  | 'STALE_REF'
  | 'TARGET_CHANGED'
  | 'NAVIGATED_DURING_SNAPSHOT'
  | 'AMBIGUOUS_TARGET'
  | 'TARGET_NOT_FOUND'
  | 'TARGET_COVERED'
  | 'TARGET_NOT_INTERACTABLE'
  | 'DEADLINE_EXCEEDED'
  | 'TAB_NOT_FOUND'
  | 'TAB_NOT_OWNED'
  | 'TAB_HELD_BY_USER'
  | 'TAB_LIMIT'
  | 'REPEATED_FAILURE'
  | 'SECRET_ENTRY_ACTIVE'
  | 'ENGINE_UNAVAILABLE'
  | 'LOCAL_BROWSER_UNAVAILABLE'
  | 'NAVIGATION_FAILED'
  | 'URL_NOT_ALLOWED'
  | 'SITE_BLOCKED'
  | 'INVALID_ARGS'

/** The latest failed browser tool call of a bot, shown where the screen would otherwise stay empty. */
export type BrowserFailureInfo = { tool: string; errorCode: string; error: string; at: EpochMs }

export type BrowserTabInfo = {
  tabId: Id
  url: string
  title: string
  state: 'live' | 'unloaded' | 'closed'
  openerTabId: Id | null
  heldByUser: boolean
  lastUsedAt: EpochMs
}

/* ------------------------------------------------------------------------------------------ */
/* MCP tool router (WP4) and handlers (WP5, WP6, WP7, WP3)                                     */
/* ------------------------------------------------------------------------------------------ */

/** Identity of the caller, resolved by the router from the per-session MCP token. Never from args. */
export type ToolContext = {
  botId: Id
  threadId: Id
  runId: Id | null
  projectId: Id | null
  cwd: AbsolutePath
  signal: AbortSignal
}

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: 'image/png' | 'image/jpeg' }

export type ToolOk = { success: true; content: Array<ToolContent>; structured?: unknown }
export type ToolErr = {
  success: false
  errorCode: string
  error: string
  content?: Array<ToolContent>
}
export type ToolResult = ToolOk | ToolErr

export type ToolHandlerArgs = { ctx: ToolContext; args: unknown }

/** A handler validates `args` against the tool's JSON Schema from mcp-tools.json itself. */
export type ToolHandler = (input: ToolHandlerArgs) => Promise<ToolResult>

export type ToolGroup = 'core' | 'project' | 'process' | 'secret' | 'preview' | 'browser' | 'computer'

export type ToolRegistration = { name: string; group: ToolGroup; handler: ToolHandler }

/** Provided by WP4. WP3/WP5/WP6/WP7 call it once at boot. */
export type RegisterTools = (input: { tools: Array<ToolRegistration> }) => Result<{ count: number }, 'DUPLICATE_TOOL' | 'UNKNOWN_TOOL'>

/** Issued by WP4 for each live CLI session; passed to the stdio shim via env, never args. */
export type McpSessionGrant = { token: string; ctx: Omit<ToolContext, 'signal' | 'runId'>; expiresAt: EpochMs | null }

/* ------------------------------------------------------------------------------------------ */
/* Agent runtime (WP3)                                                                         */
/* ------------------------------------------------------------------------------------------ */

export type ProviderEvent =
  | { type: 'session'; externalSessionId: string; rolloutPath: string | null }
  | { type: 'turn_started'; externalTurnId: string }
  | { type: 'text_delta'; itemId: string; delta: string }
  | { type: 'reasoning_delta'; itemId: string; delta: string }
  | { type: 'reasoning_progress'; estimatedTokens: number }
  | { type: 'item'; part: MessagePart }
  | { type: 'approval_request'; approvalId: Id; part: ApprovalPart }
  | { type: 'usage'; usage: Partial<RunUsage>; contextTokens: number | null; contextWindow: number | null }
  | { type: 'turn_completed'; status: 'succeeded' | 'failed' | 'interrupted'; errorClass: RunErrorClass | null; errorMessage: string | null }

export type StartTurnArgs = {
  /** Recovery for saved folder grants this host cannot enforce. No provider tools are exposed. */
  conversationOnly?: boolean
  execution?: { connect?: (port: number) => Promise<string>; spawn: Kernel['spawnTree']; writeFile: (input: { path: string; content: string }) => Promise<void>; wrapEvents?: (emit: (event: ProviderEvent) => void) => (event: ProviderEvent) => void }
  thread: Thread
  bot: Bot
  session: ProviderSession | null
  fingerprint: SessionFingerprint
  input: Array<TextPart | ImagePart>
  developerInstructions: string
  handoffPacket: string | null
  mcp: { command: AbsolutePath; args: Array<string>; env: Record<string, string> }
  env: Record<string, string>
  onEvent: (event: ProviderEvent) => void
  signal: AbortSignal
}

export type StartTurnResult = Result<
  { externalSessionId: string; rolloutPath: string | null; status: 'succeeded' | 'failed' | 'interrupted' },
  RunErrorClass
>

/** One adapter per provider. Implementations own their child processes. */
export type ProviderAdapter = {
  provider: Provider
  detect: () => Promise<Result<{ path: AbsolutePath; version: string; loggedIn: boolean }, 'cli_missing' | 'cli_auth'>>
  startTurn: (args: StartTurnArgs) => Promise<StartTurnResult>
  answerApproval: (input: { approvalId: Id; decision: 'approved' | 'denied'; message?: string }) => Promise<Result<{}, 'NOT_FOUND'>>
  shutdown: () => Promise<void>
}

/* ------------------------------------------------------------------------------------------ */
/* Sidecar HTTP API (WP2 serves, WP9 consumes). Base: http://127.0.0.1:<port>/api/v1         */
/* Auth: header `Authorization: Bearer <token>`; Origin must be tauri://localhost or the dev  */
/* origin. WebSocket: /api/v1/events?token=<token> (token also accepted as subprotocol).       */
/* ------------------------------------------------------------------------------------------ */

export type CreateBotInput = { cloudApiKey?: string } & Pick<Bot, 'name' | 'provider'> &
  Partial<Pick<Bot, 'title' | 'roleLine' | 'description' | 'color' | 'avatarShape' | 'avatarSeed' | 'instructions' | 'model' | 'reasoningEffort' | 'access' | 'approvals' | 'projectId' | 'cwd' | 'browserEnabled' | 'browser' | 'computerUse' | 'machine' | 'machineIdleMinutes' | 'vmProviderLogin' | 'hostComputerUse' | 'folders' | 'anyFolderAccess' | 'providerProfile' | 'claudeAiConnectors'>>

/** A named login under `<appData>/provider-profiles/<name>`, created with `touri profile login`. */
export type ProviderProfile = { name: string; provider: Provider; loggedIn: boolean; account: string | null }

export type ProviderLoginFlow = {
  provider: Provider
  state: 'idle' | 'host-available' | 'waiting' | 'ready' | 'cancelled' | 'error' | 'vault-locked'
  /** Sidecar host, independent of the browser and login state. */
  host?: 'mac' | 'server'
  /** Platform-aware host identity; legacy host values remain compatible. */
  hostKind?: HostKind
  /** File/executable check only; never starts a model request. Independent of login state. */
  executable?: 'available' | 'missing'
  /** An expired or failed CLI attempt can be started again; vault errors require repair. */
  retryable?: boolean
  deviceCode?: string
  verificationUrl?: string
  needsCode?: boolean
  codeError?: string
  prompt?: { kind: 'provider' | 'method'; choice: string }
  message?: string
}

/** Per-bot Telegram bridge. Off by default; only allowlisted private chats reach the bot. */
export type TelegramIntegrationConfig = {
  enabled: boolean
  /** Telegram user IDs allowed to talk to the bot. Empty means nobody. */
  allowedUserIds: Array<string>
  /** Chat that receives routine results when forwardRoutines is on. */
  homeChatId: string | null
  forwardRoutines: boolean
}

export type TelegramIntegrationStatus = {
  state: 'off' | 'connecting' | 'connected' | 'error'
  username: string | null
  error: string | null
}

export type TelegramIntegration = {
  config: TelegramIntegrationConfig
  tokenSaved: boolean
  status: TelegramIntegrationStatus
  /** Last sender refused by the allowlist, so the user can allow them in one click. */
  lastRejected: { userId: string; name: string; at: EpochMs } | null
}

export type GroupAction = 'ask_all' | 'summarize'

export type SendMessageInput = {
  /** Stored as a notice part so queued delivery and retries preserve routing. */
  groupAction?: GroupAction
  clientNonce?: string
  deadline?: EpochMs
  threadId: Id
  parentId: Id | null
  text: string
  attachmentIds: Array<Id>
}

export type ApiRoutes = {
  'GET /groups': { req: {}; res: { groups: Array<BotGroup> } }
  'POST /groups': { req: GroupInput; res: { group: BotGroup; thread: Thread } }
  'PATCH /groups/:id': { req: GroupInput; res: { group: BotGroup } }
  'DELETE /groups/:id': { req: {}; res: {} }
  'GET /groups/:id/threads': { req: {}; res: { threads: Array<Thread> } }
  'POST /groups/:id/threads': { req: { title: string }; res: { thread: Thread } }
  'GET /cloud/account': { req: {}; res: import('./cloud').CloudAccountState }
  'POST /cloud/pair': { req: {}; res: import('./cloud').CloudPairing }
  'POST /cloud/pair/poll': { req: {}; res: import('./cloud').CloudAccountState }
  'DELETE /cloud/account': { req: {}; res: {} }
  'POST /cloud/bots/:id/park': { req: {}; res: { machine: MachineState } }
  'POST /cloud/bots/:id/wake': { req: {}; res: { machine: MachineState } }
  'PUT /cloud/bots/:id/key': { req: { apiKey: string }; res: {} }

  'GET /health': { req: {}; res: { ok: true; version: string; schemaVersion: number; draining?: boolean; host?: 'mac' | 'server'; hostKind?: HostKind; historyMigration?: { running: boolean; done: number; total: number }; eventLoop?: { lagMs: number; p99Ms: number; maxMs: number; samples: number } } }
  'POST /ui/errors': { req: { area: string; message: string; stack: string; componentStack: string }; res: { ok: true } }
  'POST /reports/:id/saved': { req: { destination: 'zip' | 'github' }; res: {} }
  'POST /reports/history': { req: { history: import('./reports').ReportHistory[] }; res: {} }
  'GET /reports': { req: {}; res: { history: import('./reports').ReportHistory[]; cloudAvailable: boolean; repository: string } }
  'POST /reports/preview': { req: import('./reports').ReportInput; res: import('./reports').ReportSnapshot }
  'POST /reports/:id/deliver': { req: { destination: 'zip' | 'github' | 'cloud' }; res: { id: string; path?: string; url?: string; zipBase64?: string } }
  'GET /doctor': { req: { refresh?: boolean }; res: DoctorReport }
  'GET /doctor/storage': { req: {}; res: { storage: StorageStats; maintenance: StorageMaintenanceStatus } }
  'POST /doctor/storage/compact': { req: { vacuum?: boolean }; res: { maintenance: StorageMaintenanceStatus } }
  'GET /bots': { req: {}; res: { bots: Array<Bot> } }
  'POST /bots': { req: CreateBotInput; res: { bot: Bot } }
  'PATCH /bots/:id': { req: Partial<CreateBotInput & { paused: boolean }>; res: { bot: Bot } }
  'DELETE /bots/:id': { req: { name: string; deleteVolumes?: boolean }; res: {} }
  'GET /bots/:id/mcp': { req: {}; res: { servers: Array<McpServer> } }
  'GET /bots/:id/integrations/telegram': { req: {}; res: { telegram: TelegramIntegration } }
  'PUT /bots/:id/integrations/telegram': {
    req: Partial<TelegramIntegrationConfig> & { token?: string | null }
    res: { telegram: TelegramIntegration }
  }
  'GET /bots/:id/learning': { req: {}; res: { learning: BotLearning } }
  'PUT /bots/:id/learning': { req: Partial<BotLearningSettings>; res: { learning: BotLearning } }
  'GET /bots/:id/mcp/prerequisites': { req: {}; res: { prerequisites: McpPrerequisites } }
  'POST /bots/:id/mcp/test': { req: McpServer; res: { server: McpServer } }
  'PUT /bots/:id/mcp/:name': { req: McpServer; res: { server: McpServer } }
  'DELETE /bots/:id/mcp/:name': { req: {}; res: {} }
  'PATCH /bots/:id/mcp/:name/tools/:tool': { req: { classification: 'reads' | 'writes'; policy: McpToolPolicy }; res: { server: McpServer } }
  'GET /bots/:id/grants': { req: {}; res: { grants: Array<StandingGrant> } }
  'DELETE /bots/:id/grants/:grant': { req: {}; res: {} }
  'GET /providers/opencode/models': { req: { botId?: Id }; res: { models: Array<string>; defaultModel: string | null; available: boolean } }
  'GET /api-models': { req: {}; res: { models: Array<ApiModel>; executorAvailable?: boolean } }
  'POST /api-models': { req: ApiModelInput; res: { model: ApiModel } }
  'POST /api-models/models': { req: ApiModelConnection; res: { models: Array<string>; reason?: ApiModelError } }
  'POST /api-models/test': { req: ApiModelInput; res: ApiModelTest }
  'POST /api-models/:id/test': { req: {}; res: ApiModelTest }
  'DELETE /api-models/:id': { req: {}; res: {} }
  'GET /provider-profiles': { req: {}; res: { profiles: Array<ProviderProfile> } }
  'GET /bots/:id/provider-login': { req: {}; res: {
      provider: Provider
      ready: boolean
      source: 'token' | 'file' | 'guest' | 'missing'
      configuredSource?: 'vault' | 'host-file'
      health?: 'ready' | 'not-found' | 'transport' | 'invalid' | 'vault-locked'
      message: string
    }
  }
  'PUT /bots/:id/provider-login': { req: { value?: string; source?: 'vault' | 'host-file' }; res: {} }
  'DELETE /bots/:id/provider-login': { req: {}; res: {} }
  'GET /bots/:id/provider-login/flow': { req: { provider: Provider }; res: ProviderLoginFlow }
  'POST /bots/:id/provider-login/flow': { req: { provider: Provider; action: 'start' | 'cancel' | 'use-host' | 'paste' | 'adopt' | 'input' | 'code'; value?: string; draftId?: string; input?: 'up' | 'down' | 'enter' }; res: ProviderLoginFlow }
  'GET /machines': { req: {}; res: { capability: MachineCapability; machines: Array<MachineState> } }
  'POST /machines/service/start': { req: { botId?: Id }; res: { machine: MachineState | null } }
  'POST /bots/:id/machine/stop': { req: {}; res: { machine: MachineState } }
  'GET /bots/:id/images': { req: { path?: string; base?: string; attachmentId?: Id }; res: Blob }
  'GET /bots/:id/files': { req: { path?: string }; res: { files: Array<WorkspaceFile> } }
  'GET /bots/:id/files/content': { req: { path: string }; res: WorkspaceFileContent }
  'POST /bots/:id/machine/shell': { req: { command: string }; res: { stdout: string; stderr: string; code: number } }
  'POST /bots/:id/machine/restart': { req: { stopTurns?: boolean }; res: { machine: MachineState } }
  'POST /bots/:id/machine/intent': { req: { intent: MachineIntent; viewerId?: string }; res: { machine: MachineState } }
  'POST /bots/:id/machine/reset': { req: { confirm: true; projectId?: Id | null; stopTurns?: boolean }; res: { machine: MachineState } }
  'POST /bots/:id/desktop': { req: { control?: boolean; resume?: boolean; preview?: boolean }; res: { sessionId: string; path: string; control: boolean; humanControl?: boolean } }
  'POST /bots/:id/desktop/return': { req: {}; res: {} }
  'POST /desktop/:id/text': { req: { text: string }; res: {} }
  'DELETE /desktop/:id': { req: {}; res: {} }
  'GET /bots/:id/threads': { req: {}; res: { threads: Array<Thread> } }
  'POST /threads': { req: { botId: Id; title?: string }; res: { thread: Thread } }
  'PATCH /threads/:id': { req: { title?: string; activeLeafId?: Id; archived?: boolean }; res: { thread: Thread } }
  'GET /threads/:id/transcript': { req: { since?: number; limit?: number }; res: { entries: Array<{ seq: number; generation: number; event: UiEvent }>; rejections: Array<TranscriptRejection>; lastSeq: number; generation: number; hasMore: boolean; resync: boolean } }
  'GET /threads/:id/messages': { req: { all?: boolean }; res: { messages: Array<Message>; activeLeafId: Id | null } }
  'POST /threads/:id/messages': { req: SendMessageInput; res: { message: Message; run: Run } }
  'GET /runs': { req: Record<string, never>; res: { runs: Array<Run>; draining?: boolean } }
  'GET /threads/:id/goal': { req: {}; res: { goal: Goal | null } }
  'POST /threads/:id/goal': { req: GoalStart; res: { goal: Goal } }
  'PATCH /threads/:id/goal': { req: GoalControl; res: { goal: Goal } }
  'GET /threads/:id/runs': { req: { all?: boolean }; res: { runs: Array<Run> } }
  /** Compact sidebar messages and latest/active runs; never a transcript snapshot. */
  'GET /workspace/activity': { req: Record<string, never>; res: { messages: Array<Message>; runs: Array<Run> } }
  'POST /runs/:id/cancel': { req: {}; res: { run: Run } }
  'POST /runs/:id/retry': { req: {}; res: { run: Run } }
  'POST /approvals/:id': { req: { decision: 'approved' | 'denied'; standing?: boolean }; res: {} }
  'GET /search': { req: { q: string; botId?: Id }; res: { hits: Array<{ threadId: Id; messageId: Id; snippet: string }> } }
  'POST /attachments': { req: { grantId: string } | { path: AbsolutePath }; res: { attachment: Attachment } }
  'GET /attachments/:id': { req: {}; res: Blob }
  'GET /attachments/:id/content': { req: { offset?: number; limit?: number }; res: { text: string; offset: number; nextOffset: number | null; bytes: number } }
  'GET /routines': { req: { botId?: Id }; res: { routines: Array<Routine>; host?: 'mac' | 'server'; hostKind?: HostKind } }
  'POST /routines': { req: Omit<Routine, 'id' | 'nextRunAt' | 'source' | 'createdAt' | 'updatedAt'>; res: { routine: Routine } }
  'PATCH /routines/:id': { req: Partial<Omit<Routine, 'id' | 'source'>>; res: { routine: Routine } }
  'DELETE /routines/:id': { req: {}; res: {} }
  'POST /routines/:id/run': { req: {}; res: { routineRun: RoutineRun } }
  'GET /routine-runs': {
    req: { botId?: Id; from?: number; to?: number }
    res: { routineRuns: Array<RoutineRun> }
  }
  'GET /mcp/tools': {
    req: {}
    res: { server: { name: string; version: string }; tools: Array<{ name: string; description: string; group: string }> }
  }
  'GET /projects': { req: {}; res: { projects: Array<Project> } }
  'GET /projects/discover': { req: {}; res: { repositories: Array<DiscoveredProject> } }
  'GET /folders': { req: { path?: AbsolutePath }; res: FolderListing }
  'POST /folders': { req: { path: AbsolutePath; name: string }; res: { path: AbsolutePath } }
  'POST /projects': {
    req: { path: AbsolutePath; name?: string } | { gitUrl: string; parentDir: AbsolutePath; name?: string }
    res: { project: Project }
  }
  'GET /projects/:id/git': { req: {}; res: { branch: string | null; dirty: boolean; ahead: number; behind: number; commit?: string | null; remote?: string | null } }
  'GET /projects/:id/secrets': { req: {}; res: { secrets: Array<SecretMeta> } }
  'PUT /projects/:id/secrets/:name': { req: { usage: SecretUsage; browserOrigin?: string }; res: { secret: SecretMeta } }
  'DELETE /projects/:id/secrets/:name': { req: {}; res: {} }
  'GET /projects/:id/processes': { req: { vmBotId?: Id }; res: { processes: Array<{ spec: ProcessSpec; run: ProcessRunState | null }> } }
  'PUT /projects/:id/processes/:name': { req: Omit<ProcessSpec, 'id' | 'projectId' | 'name' | 'createdAt' | 'updatedAt'>; res: { spec: ProcessSpec } }
  'POST /processes/:id/start': { req: {}; res: { run: ProcessRunState } }
  'POST /processes/:id/stop': { req: {}; res: { run: ProcessRunState } }
  'POST /processes/:id/restart': { req: {}; res: { run: ProcessRunState } }
  'GET /processes/:id/logs': { req: { tail?: number }; res: { lines: Array<string> } }
  'GET /previews': { req: { projectId?: Id }; res: { previews: Array<PreviewTarget> } }
  'GET /browser/tabs': {
    req: { botId?: Id }
    res: { tabs: Array<BrowserTabInfo & { ownerBotId: Id | null }>; lastFailure?: BrowserFailureInfo | null }
  }
  'GET /bots/:id/browser-preview': { req: { tabId?: Id }; res: { title: string; url: string; image: string } }
  'POST /browser/tabs/:id/takeover': { req: { hold: boolean }; res: {} }
  'POST /browser/secret-entry/:id': { req: { secretName: string } | { cancel: true }; res: {} }
  'POST /computer/grants': { req: { botId: Id; threadId: Id; minutes: number }; res: { grantId: Id; expiresAt: EpochMs } }
  'POST /computer/kill': { req: {}; res: { revoked: number } }
  'POST /imports/legacy': { req: LegacyImportOptions; res: { importId: Id } }
  'GET /imports/:id': { req: {}; res: { status: 'running' | 'succeeded' | 'failed'; report: ImportReport | null } }
  'GET /recovery': { req: {}; res: { tasks: Array<RecoveryTask> } }
  'POST /recovery/:id/dismiss': { req: { acknowledgeKeys: Array<string> }; res: { tasks: Array<RecoveryTask> } }
  'GET /notifications': { req: { limit?: number }; res: { notifications: Array<NotificationRecord> } }
  'GET /notifications/pending': { req: {}; res: { notifications: Array<NotificationRecord>; lastSeq: number } }
  'POST /notifications/:id/dismiss': { req: {}; res: { notification: NotificationRecord } }
  'POST /notifications/dismiss-all': { req: {}; res: { dismissed: number; skipped: number; skippedIds: Array<number> } }
  'POST /threads/:id/respond': { req: { requestId: string; behavior: RespondBehavior; message?: string }; res: {} }
  'POST /bots/:id/messages': { req: { text: string; threadId?: Id; sendId?: string }; res: { message: Message; run: Run } }
  'GET /bots/:id/mem0': { req: {}; res: { settings: Mem0Settings } }
  'PUT /bots/:id/mem0': { req: Mem0SettingsPatch; res: { settings: Mem0Settings } }
  'POST /bots/:id/mem0/test': { req: {}; res: { ok: boolean; error?: string } }
  'GET /settings': { req: {}; res: { settings: AppSettings } }
  'PATCH /settings': { req: Partial<AppSettings>; res: { settings: AppSettings } }
}

export type AppSettings = {
  /** Keep tool details and reasoning for this many days; 0 keeps them indefinitely. Default: 30. */
  dataRetentionDays?: number
  /** Local bot VM memory cap, applied when the VM is created or recreated. Default: 1536 MiB. */
  botVmMemoryMb?: number
  cloud?: boolean
  cloudBaseUrl?: string
  cloudWebOrigin?: string
  maxConcurrentRuns: number
  defaultProvider: Provider
  cloneRoot: AbsolutePath
  cliTelemetry: 'off' | 'cli-default'
  checkForUpdates: boolean
  keepRunningInTray: boolean
  launchAtLogin: boolean
  computerUseHotkey: string
  browserExecutable: 'system-chrome' | 'chrome-for-testing'
  nativeNotifications: boolean
  /** Optional JSON setting; absent on existing installations, retaining legacy bot preferences. */
  notificationPreferences?: NotificationPreferences
  /** Float bots that need the user, are working or have unread results to the top of the sidebar. Default: true. */
  sidebarFloatUpdates?: boolean
  /** Continue a turn cut off by a restart, a provider crash or a stopped bot computer. Default: true. */
  resumeInterruptedTurns?: boolean
}

export type DoctorStatus = 'pass' | 'warn' | 'fail'
export type DoctorCheck = {
  id: string
  ok: boolean
  status?: DoctorStatus
  label?: string
  detail: string
  /** Exact terminal command; never executed automatically. */
  fix: string | null
  durationMs?: number
  errorCode?: string
  action?: 'start-machine-service' | 'authorize-vault'
  /** Account to authorize in the native app; never contains the secret. */
  vaultAccount?: string
}
export type DoctorReport = { checks: Array<DoctorCheck>; running?: boolean; checkedAt?: EpochMs | null }

export type StorageStats = {
  databaseBytes: number
  walBytes: number
  reusableBytes: number
  messageTextBytes: number
  messagePartsBytes: number
  transcriptBytes: number
  eventBytes: number
  attachmentBytes: number
  turns: number
}
export type StorageMaintenanceStatus = { running: boolean; processed: number; total: number; error?: string }

/** Server → UI push events on the WebSocket. Each carries a monotonically increasing `seq`. */
export type UiEvent =
  | { type: 'group.updated'; group: BotGroup }
  | { type: 'group.deleted'; groupId: Id }
  | { type: 'machine.updated'; machine: MachineState }
  | { type: 'bot.updated'; bot: Bot }
  | { type: 'bot.deleted'; botId: Id }
  | { type: 'project.created'; project: Project }
  | { type: 'thread.updated'; thread: Thread }
  | { type: 'message.created'; message: Message }
  | { type: 'message.delta'; threadId: Id; messageId: Id; partIndex: number; delta: string; offset?: number; updatedSeq?: number; generation?: number; partType?: 'text' | 'reasoning'; updatedAt?: EpochMs }
  | { type: 'message.parts'; threadId: Id; messageId: Id; parts: Array<{ partIndex: number; part: MessagePart }>; updatedSeq?: number; generation?: number; updatedAt?: EpochMs }
  | { type: 'transcript.resync' }
  /** Replay placeholder for a message revision already sent in its latest form earlier in the same replay. */
  | { type: 'transcript.superseded' }
  | { type: 'transcript.rejected'; rejection: TranscriptRejection }
  | { type: 'message.updated'; message: Message }
  | { type: 'run.updated'; run: Run }
  | { type: 'routine.deleted'; routineId: Id }
  | { type: 'routine.updated'; routine: Routine; lastRun: RoutineRun | null }
  | { type: 'process.updated'; spec: ProcessSpec; run: ProcessRunState | null }
  | { type: 'process.log'; processId: Id; lines: Array<string> }
  | { type: 'preview.available'; preview: PreviewTarget }
  | { type: 'browser.tab'; tab: BrowserTabInfo & { ownerBotId: Id | null } }
  | { type: 'browser.secret_requested'; requestId: Id; tabId: Id; origin: string; fieldKinds: Array<'username' | 'password' | 'otp'> }
  | { type: 'desktop.control'; botId: Id; human: boolean }
  | { type: 'computer.state'; active: boolean; botId: Id | null; grantId: Id | null }
  | { type: 'import.progress'; importId: Id; phase: string; done: number; total: number }
  | { type: 'notification.created'; notification: NotificationRecord }
  | { type: 'notification.resolved'; notification: NotificationRecord }
  | { type: 'notify'; level: 'info' | 'warning' | 'error'; title: string; body: string; threadId: Id | null; requestId?: Id | null; notificationId?: number; kind?: NotifyKind }

/** Attention kinds need the user; message kinds (`done`, `delegation-settled`, `notice`) are informational and expire. */
export type NotifyKind =
  | 'approval'
  | 'question'
  | 'takeover'
  | 'routine-deferred'
  | 'routine-failed'
  | 'turn-failed'
  | 'incident'
  | 'done'
  | 'delegation-settled'
  | 'notice'

export type NotificationScopePreferences = {
  enabled?: boolean
  digest?: 'attention' | 'all'
  types?: Partial<Record<NotifyKind, boolean>>
}

export type NotificationPreferences = NotificationScopePreferences & {
  bots?: Record<Id, NotificationScopePreferences>
  /** Times use the local clock; an equal start and end silences the entire day. */
  quietHours?: { enabled: boolean; start: string; end: string; timeZone?: string }
}

export type NotifyResolution = 'allow' | 'deny' | 'answer' | 'replied' | 'dismissed' | 'expired' | 'canceled'
export type AvatarHorns = 'classic' | 'short' | 'long' | 'none'
export type AvatarAccessory = 'none' | 'ring' | 'glasses' | 'headphones' | 'cap' | 'flower' | 'crown'
/** Bull look, horns then accessory (`short-flower`). */
export type AvatarBullShape = `${AvatarHorns}-${AvatarAccessory}`
/** Silhouette ids saved before the bulls; still accepted, rendered as the seeded automatic look. */
export type AvatarLegacyShape = 'cercle' | 'galet' | 'squircle' | 'capsule' | 'triangle' | 'hexagone' | 'nuage'
export type AvatarShape = AvatarBullShape | AvatarLegacyShape

/** Persisted notification. `id` is stable; `requestId` is set for approval/question and is what `respond` takes. */
export type NotificationRecord = {
  id: number
  kind: NotifyKind
  level: 'info' | 'warning' | 'error'
  botId: Id | null
  botName: string | null
  botColor: string
  avatarShape: AvatarShape
  avatarSeed?: string | null
  threadId: Id | null
  title: string
  body: string
  requestId: string | null
  createdAt: EpochMs
  resolvedAt: EpochMs | null
  resolution: NotifyResolution | null
}

export type NotifyInput = {
  kind: NotifyKind
  botId: Id | null
  threadId: Id | null
  title: string
  body: string
  requestId?: string | null
}

export type RespondBehavior = 'allow' | 'deny' | 'answer'

/** SSE frame names on `GET /api/events`. `id:` is the log sequence used by `?since=` and Last-Event-ID. */
export type NotifySseEvent = 'notify' | 'resolved' | 'ready'

export type UiEventEnvelope = { seq: number; at: EpochMs; event: UiEvent }

/* ------------------------------------------------------------------------------------------ */
/* Host bridge: sidecar ↔ Rust core. JSON-RPC 2.0, newline-delimited, over the Unix socket   */
/* <appData>/run/host.sock (mode 0600, dir 0700). First message must be {"method":"auth"}.     */
/* ------------------------------------------------------------------------------------------ */

export type HostPermission = 'accessibility' | 'screen-recording'
export type PermissionStatus = 'granted' | 'denied' | 'not-determined'

export type ScreenshotResult = {
  dataBase64: string
  mime: 'image/png' | 'image/jpeg'
  width: number
  height: number
  scale: number
  displayId: number
}

export type VaultErrorCode = 'VAULT_ACCESS_REQUIRED' | 'VAULT_TIMEOUT' | 'VAULT_CANCELLED' | 'VAULT_UNAVAILABLE'

export type HostMethods = {
  auth: { params: { token: string }; result: { ok: true } }
  'keychain.get': { params: { account: string }; result: { value: string | null } }
  'keychain.set': { params: { account: string; value: string }; result: {} }
  'keychain.delete': { params: { account: string }; result: {} }
  'secret.prompt': { params: { requestId: Id; title: string; origin: string; fieldKinds: Array<'username' | 'password' | 'otp'> }; result: { values: Record<string, string> | null } }
  'file.grant.redeem': { params: { grantId: string }; result: { path: AbsolutePath; dev: string; ino: string; size: number } }
  'notify': { params: { title: string; body: string; threadId: Id | null; onlyWhenUnfocused?: boolean; deepLink?: string; requestId?: Id | null; notificationId?: number; kind?: NotifyKind }; result: {} }
  'permissions.status': { params: {}; result: Record<HostPermission, PermissionStatus> }
  'permissions.request': { params: { permission: HostPermission }; result: { status: PermissionStatus; needsRelaunch: boolean } }
  'computer.screenshot': { params: { displayId?: number; maxWidth?: number; region?: { x: number; y: number; width: number; height: number } }; result: ScreenshotResult }
  'computer.click': { params: { x: number; y: number; button: 'left' | 'right' | 'middle'; clickCount: 1 | 2 | 3; modifiers: Array<'cmd' | 'shift' | 'alt' | 'ctrl'> }; result: {} }
  'computer.move': { params: { x: number; y: number }; result: {} }
  'computer.type': { params: { text: string }; result: {} }
  'computer.key': { params: { combo: string }; result: {} }
  'computer.scroll': { params: { x: number; y: number; dx: number; dy: number }; result: {} }
  'computer.frontmost': { params: {}; result: { app: string; bundleId: string; windowTitle: string | null } }
  'computer.setActive': { params: { active: boolean; botName: string | null }; result: {} }
}

/** Rust → sidecar notifications on the same socket. */
export type HostNotification =
  | { method: 'computer.killSwitch'; params: { at: EpochMs } }
  | { method: 'app.willQuit'; params: {} }
  | { method: 'power.sleep'; params: { sleeping: boolean } }

/* ------------------------------------------------------------------------------------------ */
/* Tauri IPC commands (frontend → Rust, via invoke). Everything else goes to the sidecar API.  */
/* ------------------------------------------------------------------------------------------ */

export type PreviewBounds = { x: number; y: number; width: number; height: number }
export type ServerModeStatus = { mode: 'local' | 'server'; url: string | null }
export type PendingDeepLink = { requestId: number; bot: string | null; thread: string | null }

export type TauriCommands = {
  deep_link_pending: { args: {}; result: PendingDeepLink | null }
  deep_link_ack: { args: { requestId: number }; result: {} }
  server_mode_status: { args: {}; result: ServerModeStatus }
  server_mode_pair: { args: { url: string; code: string }; result: ServerModeStatus }
  server_mode_test: { args: {}; result: { ok: true } }
  server_mode_local: { args: {}; result: ServerModeStatus }
  server_attention: { args: { title: string; body: string; deepLink?: string }; result: {} }
  server_badge: { args: { count: number }; result: {} }
  computer_kill_switch: { args: {}; result: {} }
  save_file: { args: { name: string; dataBase64: string }; result: { path: string | null } }
  report_save_zip: { args: { dataBase64: string }; result: { path: string } }
  report_shell_diagnostics: { args: {}; result: { home: string; versions: Record<string, unknown>; logs: Record<string, string> } }
  sidecar_endpoint: { args: {}; result: { baseUrl: string; wsUrl: string; token: string } }
  sidecar_restart: { args: {}; result: {} }
  preview_show: { args: { url: string; bounds: PreviewBounds }; result: { label: string } }
  preview_set_bounds: { args: { label: string; bounds: PreviewBounds }; result: {} }
  preview_navigate: { args: { label: string; url: string }; result: {} }
  preview_reload: { args: { label: string }; result: {} }
  preview_hide: { args: { label: string }; result: {} }
  permissions_status: { args: {}; result: Record<HostPermission, PermissionStatus> }
  permissions_open_settings: { args: { permission: HostPermission }; result: {} }
  secret_save: { args: { account: string; value: string }; result: {} }
  pick_folder: { args: { title: string }; result: { path: AbsolutePath | null } }
  reveal_in_finder: { args: { path: AbsolutePath }; result: {} }
  open_external: { args: { url: string }; result: {} }
  updater_check: { args: {}; result: { available: boolean; version: string | null; notes: string | null } }
  updater_install: { args: {}; result: {} }
}

/* ------------------------------------------------------------------------------------------ */
/* Sidecar kernel (WP0). Every sidecar module plugs in through these; no module imports       */
/* another module's internals.                                                                 */
/* ------------------------------------------------------------------------------------------ */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export type RouteRequest = {
  params: Record<string, string>
  query: Record<string, string>
  body: unknown
  signal: AbortSignal
}

export type RouteResponse =
  | { status: number; json: unknown }
  | { status: number; file: AbsolutePath; mime: string }
  | { status: number; stream: ReadableStream<Uint8Array>; mime: string }

export type RouteHandler = (req: RouteRequest) => Promise<RouteResponse>

/** `path` matches a key of ApiRoutes without the method, e.g. "/processes/:id/start". */
export type RouteModule = { name: string; routes: Array<{ method: HttpMethod; path: string; handler: RouteHandler }> }

export type AppPaths = {
  appData: AbsolutePath
  db: AbsolutePath
  runDir: AbsolutePath
  botsDir: AbsolutePath
  attachmentsDir: AbsolutePath
  projectsDir: AbsolutePath
  browserDir: AbsolutePath
  sessionsDir: AbsolutePath
  importsDir: AbsolutePath
  logsDir: AbsolutePath
  sidecarBinary: AbsolutePath
}

/** Output of the `project_info` tool and of the `projects.info` service. */
export type ProjectInfo = {
  project: Project
  git: { branch: string | null; dirty: boolean; ahead: number; behind: number; commit?: string | null; remote?: string | null } | null
  hints: Array<{ kind: 'node' | 'packageManager' | 'service' | 'envExample'; value: string; source: string }>
  processes: Array<{ name: string; status: ProcessRunStatus | 'not-started'; ports: Array<number> }>
  previews: Array<PreviewTarget>
  secretNames: Array<string>
}

export type StoreApi = {
  sendMessage?: (input: SendMessageInput) => RouteResponse
  drainSendQueue?: () => void
  insertMessage: (args: { message: Omit<Message, 'createdAt' | 'updatedAt'> }) => Result<{ message: Message }, 'THREAD_NOT_FOUND' | 'PARENT_NOT_FOUND'>
  appendDelta: (args: TranscriptAppend) => void
  appendParts?: (args: { threadId: Id; messageId: Id; parts: Array<{ partIndex: number; part: MessagePart }>; generation?: number }) => void
  flushWrites?: (options?: { stopping?: boolean }) => void
  updateMessage: (args: { threadId: Id; messageId: Id; patch: Partial<Pick<Message, 'status' | 'parts' | 'text' | 'runId'>> }) => Result<{ message: Message }, 'NOT_FOUND'>
  /** Select before hydrating bodies; fromRoot selects the oldest prefix instead of the recent tail. */
  activePath: (args: { threadId: Id; leafId?: Id; limit?: number; fromRoot?: boolean }) => Array<Message>
  getPathMessage?: (args: { threadId: Id; messageId: Id; leafId?: Id }) => Message | null
  setActiveLeaf: (args: { threadId: Id; leafId: Id }) => Result<{ thread: Thread }, 'NOT_FOUND'>
  getBot: (args: { botId: Id }) => Bot | null
  getThread: (args: { threadId: Id }) => Thread | null
  createThread: (args: { botId: Id; kind: ThreadKind; title: string; parentThreadId?: Id; routineRunId?: Id; groupId?: Id; groupThreadId?: Id }) => Result<{ thread: Thread }, 'BOT_NOT_FOUND'>
  updateThread: (args: { threadId: Id; patch: Partial<Pick<Thread, 'title' | 'carryoverNote' | 'usage' | 'unread' | 'activeLeafId'>> }) => Result<{ thread: Thread }, 'NOT_FOUND'>
  search: (args: { q: string; botId?: Id; threadId?: Id; limit: number }) => Array<{ threadId: Id; messageId: Id; snippet: string }>
}

/** Cross-module services. Providers call `provide` in their init; consumers must tolerate `null` from `use`. */
export type ServiceMap = {
  'bots.rename': (input: { botId: Id; name: string }) => Result<{ bot: Bot }, 'NOT_FOUND' | 'INVALID_ARGS'>
  'bots.configureAccess': (input: { botId: Id; patch: Partial<Pick<Bot, 'projectId' | 'folders' | 'browserEnabled' | 'browser' | 'computerUse'>> }) => Result<{ bot: Bot }, 'NOT_FOUND' | 'INVALID_ARGS' | 'MACHINE_PROJECT_CHANGE'>
  'diagnostics.errors': () => Array<{ code: string; at: number }>
  'groups.runtime': {
    enqueue: (args: { threadId: Id; requestMessageId: Id; trigger: RunTrigger; routineRunId?: Id }) => Result<{ run: Run }, 'THREAD_NOT_FOUND' | 'BOT_PAUSED' | 'DELEGATION_LIMIT' | 'RUNTIME_DRAINING'>
    cancel: (id: Id) => boolean
    cancelGroupTurns: (args: { groupId: Id }) => Promise<void>
    retry: (id: Id) => Result<{ run: Run }, 'THREAD_NOT_FOUND' | 'BOT_PAUSED' | 'DELEGATION_LIMIT' | 'RUNTIME_DRAINING' | 'CONFLICT'> | null
    listRuns: (threadId: Id) => Array<Run>
    beginDrain: () => void
    waitForDrain: () => Promise<void>
    shutdown: (options?: { appRestart?: boolean }) => void
    canCoordinate: (threadId: Id) => boolean
  }
  'vm.stopShells': () => void
  'mem0.api': {
    enabled: (botId: Id) => boolean
    /** Static guidance for the developer instructions, or null when Mem0 is off for the bot. */
    instructions: (botId: Id) => string | null
    /** A fenced recalled-context block for this turn's input, or null. Never throws, waits at most ~3 s. */
    recall: (args: { botId: Id; query: string; signal?: AbortSignal }) => Promise<string | null>
    /** Fire and forget: stores the exchange when auto sync is on. */
    sync: (args: { botId: Id; threadId: Id; userText: string; assistantText: string }) => void
  }
  'approvals.present': (input: ApprovalInput) => Promise<ApprovalResult>
  'approvals.approve': (input: { approvalId: Id; decision: 'approved' | 'denied'; standing?: boolean; message?: string }) => Promise<Result<{}, 'NOT_FOUND'>>
  'approvals.settle': (input: { approvalId: Id; decision: 'denied' | 'expired' }) => void
  'doctor': { start: () => void; dispose: () => void; snapshot: (refresh?: boolean) => DoctorReport; settled: () => Promise<void> }
  'storage.maintenance': { scheduleSessionKeyRetry: () => void; start: (vacuum?: boolean) => boolean; snapshot: () => StorageMaintenanceStatus; dispose: (options?: { closing?: boolean }) => void }
  'mcp.botTools': (bot: Bot) => Array<string>

  'cloud.settingsChanged': () => void
  'cloud.account': import('./cloud').CloudService
  'store.settings': () => AppSettings
  'vm.runtime': VmRuntime
  'vm.shutdown': () => Promise<void>
  'vm.desktop': VmDesktop
  'store.api': StoreApi
  'runtime.enqueue': (args: { threadId: Id; requestMessageId: Id; trigger: RunTrigger }) => Result<{ run: Run }, 'THREAD_NOT_FOUND' | 'BOT_PAUSED' | 'DELEGATION_LIMIT' | 'RUNTIME_DRAINING'>
  'runtime.isDraining': () => boolean
  'runtime.beginDrain': () => Promise<void>
  'runtime.settingsChanged': () => void
  'runtime.activeRun': (args: { threadId: Id }) => Run | null
  'runtime.continueAfterApproval': (ctx: Pick<ToolContext, 'botId' | 'threadId' | 'runId' | 'signal'>) => boolean
  'runtime.cancelBotTurns': (args: { botId: Id }) => Promise<void>
  'runtime.cancelRun': (args: { runId: Id }) => boolean
  'runtime.shutdown': (options?: { appRestart?: boolean }) => Promise<void>
  'projects.info': (args: { projectId: Id; botId?: Id }) => Promise<ProjectInfo | null>
  'browser.tabsForBot': (args: { botId: Id }) => Array<BrowserTabInfo>
  'computer.input': ComputerInput
  'computer.isActive': () => { active: boolean; botId: Id | null }
  'notify.emit': (input: NotifyInput) => NotificationRecord
  'runtime.answerApproval': (args: { approvalId: Id; decision: 'approved' | 'denied'; standing?: boolean; message?: string }) => Promise<Result<{}, 'NOT_FOUND'>>
  'notify.resolve': (args: { requestId: string; resolution: NotifyResolution }) => void
}

export type VmRuntime = {
  capability: MachineCapability
  states: () => Array<MachineState>
  intent: (input: { botId: Id; intent: MachineIntent; viewerId?: string }) => Promise<MachineState>
  /** Open UI connections lease without booting; released when their socket closes. */
  holdViewer?: (botId: Id) => () => void
  acquire: (input: { botId: Id; signal?: AbortSignal; runningOnly?: boolean }) => Promise<() => Promise<void>>
  spawn: (input: { botId: Id } & Parameters<Kernel['spawnTree']>[0]) => ReturnType<Kernel['spawnTree']>
  exec: (input: { botId: Id; command: string; args?: Array<string>; cwd?: string; signal?: AbortSignal }) => Promise<Result<{ stdout: string; stderr: string; code: number }>>
  writeFile: (input: { botId: Id; path: string; content: string; signal?: AbortSignal }) => Promise<void>
  prepareTurn: (input: { botId: Id; threadId: Id; token: string; signal?: AbortSignal }) => Promise<{ bot: Bot; cwd: string; env: Record<string, string>; mcp: StartTurnArgs['mcp']; execution: NonNullable<StartTurnArgs['execution']>; release: () => Promise<void> }>
  forwardPort: (input: { botId: Id; guestPort: number; signal?: AbortSignal }) => Promise<{ hostPort: number; url: string }>
  /** Private sidecar service; password must never enter API responses, events or URLs. */
  desktopConnection: (input: { botId: Id; signal?: AbortSignal; control?: boolean }) => Promise<{ hostPort: number; url: string; password: string }>
  browserEndpoint: (input: { botId: Id; runningOnly?: boolean; signal?: AbortSignal }) => Promise<string | null>
  computer: (input: { ctx: ToolContext; name: string; args: unknown }) => Promise<ToolResult>
  restart: (input: { botId: Id; reset?: boolean; projectId?: Id | null }) => Promise<MachineState>
  startService: (input: { botId?: Id }) => Promise<MachineState | null>
  stop: (input: { botId: Id }) => Promise<void>
  destroy: (input: { botId: Id; deleteVolumes?: boolean }) => Promise<void>
  doctor: () => Promise<Array<DoctorCheck>>
}

export type ComputerInput = {
  human: (botId: Id) => boolean
  take: (botId: Id, signal: AbortSignal) => Promise<void>
  handBack: (botId: Id) => void
  run: (ctx: ToolContext, operation: (signal: AbortSignal) => Promise<ToolResult>) => Promise<ToolResult>
  kill: () => void
}

/** Authenticated, one-use desktop connections; the VM module owns their leases and input policy. */
export type DesktopSocket = { send: (data: Uint8Array) => number; close: (code?: number, reason?: string) => void }
export type VmDesktop = {
  claim: (id: string) => boolean
  open: (id: string, socket: DesktopSocket) => void
  message: (id: string, data: Uint8Array | string) => void
  close: (id: string, closeCode?: number) => void
  revokeControl: () => void
  closeBot: (botId: Id) => Promise<void>
  dispose: () => void
}

export type Services = {
  provide: <K extends keyof ServiceMap>(name: K, impl: ServiceMap[K]) => void
  use: <K extends keyof ServiceMap>(name: K) => ServiceMap[K] | null
}

/** Shape of every sidecar module's index.ts. main.ts calls init in this order: store, mcp, projects, browser, computer, runtime, importer. */
export type SidecarModule = { name: string; init: (kernel: Kernel) => Promise<void> }

export type Kernel = {
  paths: AppPaths
  services: Services
  spawnTree: (args: { cmd: string; args: Array<string>; cwd: AbsolutePath; env: Record<string, string>; extraFds?: number }) => Result<{
    target?: 'local' | 'remote'
    remoteProcessId?: string
    /** Remote handles use 0; never pass them to host process APIs. */
    pid: number
    pgid: number
    stdout: ReadableStream<Uint8Array>
    stderr: ReadableStream<Uint8Array>
    stdin: WritableStream<Uint8Array>
    extra: Array<{ read: ReadableStream<Uint8Array> | null; write: WritableStream<Uint8Array> | null }>
    exited: Promise<{ code: number | null; signal: string | null }>
    kill: (signal: 'SIGTERM' | 'SIGKILL' | 'SIGINT') => void
  }, 'SPAWN_FAILED' | 'ENOENT'>
  db: unknown
  publish: (event: UiEvent) => void
  subscribe: (listener: (envelope: UiEventEnvelope) => void) => () => void
  registerRoutes: (module: RouteModule) => void
  registerTools: RegisterTools
  callHost: <M extends keyof HostMethods>(method: M, params: HostMethods[M]['params']) => Promise<Result<{ value: HostMethods[M]['result'] }, 'HOST_UNAVAILABLE' | 'HOST_ERROR' | VaultErrorCode>>
  onHostNotification: (listener: (notification: HostNotification) => void) => () => void
  redact: (text: string) => string
  addRedactionValue: (value: string) => void
  shellEnv: () => Promise<Record<string, string>>
  newId: () => Id
  log: (entry: { level: 'debug' | 'info' | 'warn' | 'error'; module: string; msg: string; data?: Record<string, unknown> }) => void
}

/** First stdout line printed by the sidecar after it is listening. Rust parses it. */
export type SidecarHandshake = {
  type: 'touri-sidecar-ready'
  port: number
  pid: number
  version: string
  schemaVersion: number
}

/* ------------------------------------------------------------------------------------------ */
/* legacy app importer (WP8)                                                                  */
/* ------------------------------------------------------------------------------------------ */

export type LegacySource =
  | { kind: 'local'; root: AbsolutePath }
  | { kind: 'ssh'; host: string; user: string; port?: number; root: string }

export type LegacyImportOptions = {
  source: LegacySource
  botIds: Array<string>
  importCodexSessions: boolean
  cwdMap: Array<{ from: string; to: AbsolutePath; projectId?: Id }>
  includeAttachments: boolean
  dryRun: boolean
}

export type ImportCounts = { created: number; updated: number; unchanged: number; skipped: number }

export type ImportReport = {
  importId: Id
  origin: string
  dryRun: boolean
  bots: ImportCounts
  threads: ImportCounts
  messages: ImportCounts
  routines: ImportCounts
  attachments: ImportCounts
  codexSessions: ImportCounts
  memoryFiles: ImportCounts
  droppedMessageKinds: Record<string, number>
  warnings: Array<string>
}

/** Fields read from legacy app `bots.json`. Anything not listed here is never read. */
export type LegacyBot = {
  id: string
  threadId: string
  name: string
  title?: string
  description?: string
  soul?: string
  color?: string
  section?: string
  createdAt: number
  modelSelection?: { instanceId: string; model?: string }
  resumeCursors?: { codex?: string; claude?: string; opencode?: string }
  cwd?: string
  approvalMode?: string
  browser?: boolean | string
  computer?: boolean | string
  tasks?: Array<{
    threadId: string
    title: string
    createdAt: number
    updatedAt?: number
    resumeCursors?: { codex?: string; claude?: string; opencode?: string }
    routineRunId?: string
    cwd?: string
    usage?: { input?: number; output?: number; cachedInput?: number; costUsd?: number; turns?: number }
  }>
}

/** `messages.db` row: messages(thread_id, id, at, role, kind, text, json). `json` parsed into this. */
export type LegacyMessageJson = {
  id: string
  at: number
  parentId?: string | null
  role: 'user' | 'bot'
  kind: 'text' | 'activity' | 'digest' | 'routine.run' | 'compaction' | 'options'
  text?: string
  attachments?: Array<{ kind: 'image'; path: string; mime: string }>
  sender?: { name: string; id: string }
  turnId?: string
  requestMessageId?: string
  turnTerminal?: boolean
  turnSucceeded?: boolean
  tool?: { name: string; summary?: string; input?: string; itemId?: string; ok?: boolean; output?: string }
  digest?: {
    turnId: string
    durationMs?: number
    toolCalls?: number
    reply?: string
    usage?: { input?: number; output?: number; cachedInput?: number; costUsd?: number }
  }
  routineRun?: { runId: string; routineId: string; routineName: string; scheduledFor?: number; status?: string; executionThreadId?: string; summary?: string }
  compaction?: { summary: string; firstKeptId?: string; foldedThroughId?: string; tokensBefore?: number; by?: string }
}

export type LegacyRoutine = {
  id: string
  name: string
  prompt: string
  botId: string
  enabled: boolean
  schedule: { type: 'cron'; expression: string; timeZone: string }
  timeoutMinutes?: number
  continuity?: string
  resultsThreadId?: string
}

export type LegacyRoutineRun = {
  id: string
  routineId: string
  status: string
  threadId?: string
  scheduledFor?: number
  startedAt?: number
  finishedAt?: number
  output?: string
  manual?: boolean
}
