import type {
  BrowserActionRecord,
  BrowserDiagnostic,
  BrowserElement,
  BrowserErrorCode,
  BrowserRef,
  BrowserSnapshot,
  BrowserTabInfo,
  BrowserTakeoverCapture,
  BrowserTakeoverInput,
  BrowserTakeoverReason,
  BrowserTarget,
  EpochMs,
  GroupDelegation,
  Id,
  Kernel,
  ToolContext,
  ToolResult,
} from "@touri/contracts"

export type JsonObject = Record<string, unknown>

export type CdpEvent = {
  method: string
  params: JsonObject
  sessionId?: string
}

export type CdpClient = {
  call: <T>(method: string, params?: JsonObject, sessionId?: string) => Promise<T>
  subscribe: (listener: (event: CdpEvent) => void) => () => void
  close: () => Promise<void>
  isClosed: () => boolean
  onDisconnect?: (listener: () => void) => () => void
}

export type CdpPipe = {
  read: ReadableStream<Uint8Array>
  write: WritableStream<Uint8Array>
}

export type CdpTargetInfo = {
  targetId: string
  type: string
  title: string
  url: string
  openerId?: string
  attached?: boolean
}

export type CdpSessionInfo = {
  sessionId: string
  targetId: string
}

export type Fingerprint = {
  role: string
  name: string
  tag: string
  textPrefix: string
  formAssociated?: boolean
  formSubmit?: boolean
  href?: string
  source?: "ax"
}

export type NodeRef = {
  ref: BrowserRef
  sessionId: string
  backendNodeId: number
  fingerprint: Fingerprint
  frame: string
  role: string
  name: string
  value?: string
  states: Array<"checked" | "disabled" | "expanded" | "focused" | "selected" | "required" | "readonly">
  bounds: Array<number>
}

export type CoveringElement = {
  role: string
  name: string
  ref: BrowserRef | null
}

export type BrowserFailure = {
  errorCode: BrowserErrorCode
  error: string
  covering?: CoveringElement
}

export type BrowserTabRow = {
  id: Id
  profile: string
  owner_bot_id: Id | null
  owner_thread_id: Id | null
  opener_tab_id: Id | null
  cdp_target_id: string | null
  url: string
  title: string
  state: "live" | "unloaded" | "closed"
  held_by_user: number
  private_after_takeover: number
  takeover_reason: BrowserTakeoverReason | null
  private_input: number
  created_at: EpochMs
  last_used_at: EpochMs
}

export type TabState = {
  info: BrowserTabInfo & { ownerBotId: Id | null; ownerThreadId: Id | null }
  targetId: string | null
  sessionId: string | null
  frameSessions: Map<string, string>
  generation: number
  refs: Map<BrowserRef, NodeRef>
  actions: Array<BrowserActionRecord>
  diagnostics: Array<BrowserDiagnostic>
  navigationVersion: number
  secretMode: boolean
  privateAfterTakeover: boolean
  takeoverReason: BrowserTakeoverReason | null
  privateInput: boolean
  dialog: { type: "alert" | "confirm" | "prompt" | "beforeunload"; message: string } | null
  lastFailureKey: string | null
  failureCount: number
  queue: Promise<void>
  takeover: {
    requestId: string | null
    botId: Id | null
    threadId: Id | null
    runId: Id | null
    timer: ReturnType<typeof setTimeout> | null
    signal?: AbortSignal
    onAbort?: () => void
    delegation?: GroupDelegation | null
  } | null
  handbackNote: string | null
  lastSnapshot: BrowserSnapshot | null
  /** Last main-frame document response, kept for blocked-page detection. */
  mainDocument: { url: string; status: number; headers: Record<string, string> } | null
}

export type BrowserEngine = {
  preview: (args: {
    botId: Id
    tabId?: Id
    signal: AbortSignal
  }) => Promise<{ title: string; url: string; image: string } | null>
  takeoverFrame: (args: { tabId: Id; botId: Id; signal: AbortSignal }) => Promise<BrowserTakeoverCapture | null>
  takeoverInput: (args: {
    tabId: Id
    botId: Id
    targetEpoch: number
    width: number
    height: number
    input: BrowserTakeoverInput
    signal: AbortSignal
  }) => Promise<boolean>
  open: (args: { url: string; ctx: ToolContext; timeoutMs: number }) => Promise<ToolResult>
  list: (args: { botId: Id | null; signal?: AbortSignal; timeoutMs?: number }) => Promise<ToolResult>
  close: (args: { tabId: Id; botId: Id; signal: AbortSignal; timeoutMs?: number }) => Promise<ToolResult>
  snapshot: (args: {
    tabId: Id
    botId: Id
    image: "auto" | "always" | "never"
    signal: AbortSignal
    timeoutMs?: number
  }) => Promise<ToolResult>
  screenshot: (args: {
    tabId: Id
    botId: Id
    fullPage: boolean
    signal: AbortSignal
    timeoutMs?: number
  }) => Promise<ToolResult>
  navigate: (args: {
    tabId: Id
    botId: Id
    url?: string
    action: string
    timeoutMs: number
    signal: AbortSignal
  }) => Promise<ToolResult>
  click: (args: {
    tabId: Id
    botId: Id
    target: BrowserTarget
    button: "left" | "right" | "middle"
    clickCount: number
    timeoutMs: number
    signal: AbortSignal
  }) => Promise<ToolResult>
  type: (args: {
    tabId: Id
    botId: Id
    target: BrowserTarget
    text: string
    clear: boolean
    submit: boolean
    timeoutMs: number
    signal: AbortSignal
  }) => Promise<ToolResult>
  press: (args: { tabId: Id; botId: Id; key: string; timeoutMs: number; signal: AbortSignal }) => Promise<ToolResult>
  hover: (args: {
    tabId: Id
    botId: Id
    target: BrowserTarget
    timeoutMs: number
    signal: AbortSignal
  }) => Promise<ToolResult>
  scroll: (args: {
    tabId: Id
    botId: Id
    target: BrowserTarget | null
    direction: "down" | "up"
    pages: number
    signal: AbortSignal
    timeoutMs?: number
  }) => Promise<ToolResult>
  selectOption: (args: {
    tabId: Id
    botId: Id
    target: BrowserTarget
    values: Array<string>
    signal: AbortSignal
    timeoutMs?: number
  }) => Promise<ToolResult>
  setChecked: (args: {
    tabId: Id
    botId: Id
    target: BrowserTarget
    checked: boolean
    signal: AbortSignal
    timeoutMs?: number
  }) => Promise<ToolResult>
  waitFor: (args: {
    tabId: Id
    botId: Id
    condition: unknown
    timeoutMs: number
    signal: AbortSignal
  }) => Promise<ToolResult>
  evaluate: (args: {
    tabId: Id
    botId: Id
    expression: string
    signal: AbortSignal
    timeoutMs?: number
  }) => Promise<ToolResult>
  requestTakeover: (args: {
    tabId: Id
    botId: Id
    reason: string
    reasonCode?: BrowserTakeoverReason
    timeoutMs: number
    signal: AbortSignal
    notify?: boolean
    threadId?: Id
    runId?: Id | null
  }) => Promise<ToolResult>
  submitSecret: (args: {
    tabId: Id
    botId: Id
    threadId: Id
    projectId: Id | null
    fields: Array<{ kind: "username" | "password" | "otp"; target: BrowserTarget }>
    secretName?: string
    submit: "none" | "enter" | "click"
    submitTarget?: BrowserTarget
    signal: AbortSignal
  }) => Promise<ToolResult>
  secretEntry: (args: { tabId: Id; secretName?: string; cancel: boolean }) => Promise<boolean>
  releaseTakeover: (tabId: Id) => Promise<boolean>
  releaseTakeoverForPerson: (args: { tabId: Id; personId: Id }) => Promise<"released" | "forbidden" | "not_found">
  holdTakeoverForPerson: (args: { tabId: Id; personId: Id }) => Promise<"held" | "forbidden" | "not_found">
  holdTakeover: (args: { tabId: Id; reason: string; runId?: Id }) => Promise<boolean>
  getWindowBounds: (args: { tabId: Id; botId: Id }) => Promise<WindowBounds | null>
  tabsForBot: (botId: Id | null) => Array<BrowserTabInfo & { ownerBotId: Id | null }>
  cancelTakeover: (args: { tabId: Id }) => boolean
  shutdown: () => Promise<void>
}

export type WindowBounds = {
  left: number
  top: number
  width: number
  height: number
  windowState: string
}

export type BrowserModule = {
  engine: BrowserEngine
  kernel: Kernel
}

export type BrowserSnapshotResult = {
  snapshot: BrowserSnapshot
  text: string
}

export type SnapshotElement = BrowserElement & { backendNodeId: number; sessionId: string; bounds: Array<number> }
