import { invoke } from "@tauri-apps/api/core"
import {
  type ApiRoutes,
  type Attachment,
  isErrorCode,
  type Message,
  type RegisteredErrorCode,
  type Run,
  type SendMessageInput,
  type ServerModeStatus,
  type TauriCommands,
  type UiEventEnvelope,
} from "@touri/contracts"
import { maxAttachmentBytes } from "../attachmentFiles"
import { ApiError, isServiceUnavailable } from "../errors"
import { t } from "../i18n"
import { scopedStorageKey } from "../storageScope"
import { createSendJournal } from "./sendJournal"

export type Endpoint = { baseUrl: string; wsUrl: string; token: string; scope?: string }

/** In a plain browser the server authenticates with an httpOnly cookie, so no token is sent. */
export const webEndpoint = (location: Pick<Location, "protocol" | "host">): Endpoint => ({
  baseUrl: "",
  wsUrl: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/v1/events`,
  token: "",
})

const authHeaders = (token: string): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {})

export const apiRouteKeys = [
  "GET /workspace/activity",
  "GET /runs",
  "GET /groups",
  "POST /groups",
  "PATCH /groups/:id",
  "DELETE /groups/:id",
  "GET /groups/:id/threads",
  "POST /groups/:id/threads",
  "GET /cloud/account",
  "POST /cloud/pair",
  "POST /cloud/pair/poll",
  "DELETE /cloud/account",
  "POST /cloud/bots/:id/park",
  "POST /cloud/bots/:id/wake",
  "PUT /cloud/bots/:id/key",
  "GET /health",
  "GET /session",
  "POST /ui/errors",
  "POST /reports/history",
  "GET /reports",
  "POST /reports/preview",
  "POST /reports/:id/deliver",
  "POST /reports/:id/saved",
  "GET /doctor",
  "GET /doctor/storage",
  "POST /doctor/storage/compact",
  "GET /storage/bot-deletions",
  "GET /bots",
  "POST /bots",
  "PATCH /bots/:id",
  "DELETE /bots/:id",
  "GET /bots/:id/mcp",
  "GET /bots/:id/mcp/prerequisites",
  "POST /bots/:id/mcp/test",
  "PUT /bots/:id/mcp/:name",
  "DELETE /bots/:id/mcp/:name",
  "PATCH /bots/:id/mcp/:name/tools/:tool",
  "GET /bots/:id/grants",
  "DELETE /bots/:id/grants/:grant",
  "GET /providers/opencode/models",
  "GET /provider-profiles",
  "GET /bots/:id/provider-login",
  "PUT /bots/:id/provider-login",
  "DELETE /bots/:id/provider-login",
  "GET /bots/:id/provider-login/flow",
  "POST /bots/:id/provider-login/flow",
  "GET /machines",
  "POST /machines/service/start",
  "POST /bots/:id/machine/stop",
  "GET /bots/:id/images",
  "GET /bots/:id/files",
  "GET /bots/:id/files/content",
  "POST /bots/:id/machine/shell",
  "POST /bots/:id/machine/restart",
  "POST /bots/:id/machine/intent",
  "POST /bots/:id/machine/reset",
  "POST /bots/:id/desktop",
  "POST /bots/:id/desktop/return",
  "POST /desktop/:id/text",
  "DELETE /desktop/:id",
  "GET /bots/:id/threads",
  "POST /threads",
  "PATCH /threads/:id",
  "GET /threads/:id/transcript",
  "GET /threads/:id/messages",
  "GET /threads/:id/goal",
  "POST /threads/:id/goal",
  "PATCH /threads/:id/goal",
  "POST /threads/:id/messages",
  "POST /runs/:id/cancel",
  "POST /runs/:id/retry",
  "POST /approvals/:id",
  "GET /search",
  "POST /attachments",
  "GET /attachments/:id",
  "GET /attachments/:id/content",
  "GET /routines",
  "POST /routines",
  "PATCH /routines/:id",
  "DELETE /routines/:id",
  "POST /routines/:id/run",
  "GET /routine-runs",
  "GET /mcp/tools",
  "GET /projects",
  "GET /projects/discover",
  "GET /folders",
  "POST /folders",
  "POST /projects",
  "GET /projects/:id/git",
  "GET /projects/:id/secrets",
  "PUT /projects/:id/secrets/:name",
  "DELETE /projects/:id/secrets/:name",
  "GET /projects/:id/processes",
  "PUT /projects/:id/processes/:name",
  "POST /processes/:id/start",
  "POST /processes/:id/stop",
  "POST /processes/:id/restart",
  "GET /processes/:id/logs",
  "GET /previews",
  "GET /browser/tabs",
  "GET /bots/:id/browser-preview",
  "POST /browser/tabs/:id/takeover",
  "POST /browser/secret-entry/:id",
  "POST /computer/grants",
  "POST /computer/kill",
  "POST /imports/legacy",
  "GET /imports/:id",
  "GET /recovery",
  "POST /recovery/:id/dismiss",
  "GET /notifications",
  "GET /notifications/pending",
  "POST /notifications/:id/dismiss",
  "POST /notifications/dismiss-all",
  "POST /threads/:id/respond",
  "POST /bots/:id/messages",
  "GET /settings",
  "GET /api-models",
  "POST /api-models",
  "POST /api-models/models",
  "POST /api-models/test",
  "POST /api-models/:id/test",
  "PATCH /api-models/:id/browser-decisions",
  "DELETE /api-models/:id",
  "PATCH /settings",
] as const satisfies ReadonlyArray<keyof ApiRoutes>

export type ApiRequest = <K extends keyof ApiRoutes>(
  route: K,
  input: ApiRoutes[K]["req"],
  pathValues?: Record<string, string>,
) => Promise<ApiRoutes[K]["res"]>

export type UiApi = {
  updateEndpoint?: (endpoint: Endpoint) => void
  request: ApiRequest
  sendMessage?: (input: SendMessageInput) => Promise<{ message: Message; run: Run | null }>
  pendingMessages?: () => Message[]
  subscribe: (listener: (envelope: UiEventEnvelope) => void) => () => void
  subscribeConnection?: (listener: (connected: boolean) => void) => () => void
  /**
   * Resolves once the event stream knows where live delivery starts. A snapshot loaded after this
   * misses nothing, so the cold-start resync is not loaded a second time.
   */
  cursorReady?: () => Promise<void>
  isMock: boolean
  uploadAttachment?: (file: File) => Promise<Attachment>
  websocketUrl?: (path: string) => string | Promise<string>
}

export type TauriInvoke = <K extends keyof TauriCommands>(
  command: K,
  args: TauriCommands[K]["args"],
) => Promise<TauriCommands[K]["result"] | null>

const isEndpoint = (value: unknown): value is Endpoint => {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.baseUrl === "string" &&
    typeof candidate.wsUrl === "string" &&
    typeof candidate.token === "string" &&
    candidate.token.length > 0
  )
}

export const resolveSidecarEndpoint = async (invokeCommand: TauriInvoke): Promise<Endpoint> => {
  const endpoint = await invokeCommand("sidecar_endpoint", {})
  if (!isEndpoint(endpoint)) throw new Error("sidecar_endpoint returned no connection information")
  return endpoint
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const replacePath = (path: string, pathValues: Record<string, string>): string =>
  path.replace(/:([a-zA-Z0-9_]+)/g, (_, name: string) => encodeURIComponent(pathValues[name] ?? `:${name}`))

const isBlobRoute = (route: string): boolean => route === "GET /attachments/:id" || route === "GET /bots/:id/images"

/** Never hold the first load back for long when the event socket cannot open. */
const CURSOR_WAIT_MS = 3_000

const parseEvent = (value: unknown): UiEventEnvelope | null => {
  if (typeof value !== "object" || value === null) return null
  const record = value as Record<string, unknown>
  if (!Number.isSafeInteger(record.seq) || Number(record.seq) < 1 || typeof record.at !== "number") return null
  if (typeof record.event !== "object" || record.event === null) return null
  return value as UiEventEnvelope
}

export const createApiClient = ({
  endpoint: initialEndpoint,
  resolveEndpoint,
  fetchImpl = fetch,
}: {
  endpoint: Endpoint
  resolveEndpoint?: () => Promise<Endpoint>
  fetchImpl?: FetchLike
}): UiApi => {
  let endpoint = initialEndpoint
  const storageScope = scopedStorageKey("", initialEndpoint.scope ?? null)
  const updateEndpoint = (next: Endpoint): void => {
    // Token/port refreshes retain their journal. Switching destinations needs a new client.
    if (scopedStorageKey("", next.scope ?? null) !== storageScope) throw new Error("SERVER_DESTINATION_CHANGED")
    endpoint = next
  }
  const listeners = new Set<(event: UiEventEnvelope) => void>()
  const connectionListeners = new Set<(connected: boolean) => void>()
  let socket: WebSocket | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let delay = 250
  let openedBefore = false
  let disconnectedBefore = false
  let connecting = false
  let socketGeneration = 0
  let lastSeq = 0
  let cursorKnown = false
  let cursorWaiters: Array<() => void> = []
  const settleCursor = (): boolean => {
    cursorKnown = true
    const waiters = cursorWaiters
    cursorWaiters = []
    for (const resolve of waiters) resolve()
    return waiters.length > 0
  }
  let recovering: Promise<void> | null = null
  const refreshEndpoint = async (): Promise<void> => {
    if (!resolveEndpoint) return
    recovering ??= resolveEndpoint()
      .then((next) => {
        updateEndpoint(next)
      })
      .finally(() => {
        recovering = null
      })
    await recovering
  }
  const websocketUrl = async (path: string): Promise<string> => {
    const response = await fetchImpl(`${endpoint.baseUrl}/api/v1/ws-ticket`, {
      method: "POST",
      headers: { ...authHeaders(endpoint.token), "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ path }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new ApiError(response.status, "Não foi possível conectar")
    const body = (await response.json()) as { ticket?: unknown }
    if (typeof body.ticket !== "string" || !body.ticket) throw new Error("Conexão indisponível")
    const url = new URL(endpoint.wsUrl)
    url.pathname = path
    url.search = ""
    url.searchParams.set("ticket", body.ticket)
    return url.toString()
  }
  const scheduleReconnect = (): void => {
    if (timer || listeners.size === 0) return
    timer = setTimeout(() => {
      timer = undefined
      void connect()
    }, delay)
    delay = Math.min(delay * 2, 5000)
  }
  const reconnectUnavailableService = (): void => {
    if (listeners.size === 0 || (disconnectedBefore && !socket)) return
    // Reads can fail before the event socket notices a stalled server.
    const previous = socket
    socket = null
    disconnectedBefore = true
    previous?.close()
    journal.disconnect()
    connectionListeners.forEach((listener) => {
      listener(false)
    })
    scheduleReconnect()
  }
  const connect = async (): Promise<void> => {
    if (connecting || socket || listeners.size === 0) return
    connecting = true
    const generation = socketGeneration
    try {
      if (openedBefore || delay > 250) await refreshEndpoint()
      if (generation !== socketGeneration || listeners.size === 0) return
      const url = new URL(await websocketUrl("/api/v1/events"))
      if (generation !== socketGeneration || listeners.size === 0) return
      url.searchParams.set("since", String(lastSeq))
      const next = new WebSocket(url)
      socket = next
      next.addEventListener("message", (event: MessageEvent<string>) => {
        if (socket !== next) return
        try {
          const frame = JSON.parse(event.data) as unknown
          if (
            typeof frame === "object" &&
            frame !== null &&
            "type" in frame &&
            frame.type === "resync" &&
            "lastSeq" in frame &&
            Number.isSafeInteger(frame.lastSeq) &&
            Number(frame.lastSeq) >= 0
          ) {
            const cold = !cursorKnown
            lastSeq = Number(frame.lastSeq)
            // A cold start begins at the head; the snapshot waiting on cursorReady covers history.
            if (settleCursor() && cold) return
            listeners.forEach((listener) => {
              listener({ seq: 0, at: Date.now(), event: { type: "transcript.resync" } })
            })
            return
          }
          const envelope = parseEvent(frame)
          if (!envelope) {
            disconnected()
            return
          }
          settleCursor()
          if (envelope.seq <= lastSeq) return
          if (envelope.seq !== lastSeq + 1) {
            disconnected()
            return
          }
          if (envelope.event.type === "message.created" || envelope.event.type === "message.updated")
            journal.acknowledge(envelope.event.message)
          listeners.forEach((listener) => {
            listener(envelope)
          })
          lastSeq = envelope.seq
        } catch {
          disconnected()
        }
      })
      next.addEventListener("open", () => {
        if (socket !== next) return
        const reconnected = openedBefore || disconnectedBefore
        openedBefore = true
        disconnectedBefore = false
        delay = 250
        journal.reconnect()
        if (reconnected)
          connectionListeners.forEach((listener) => {
            listener(true)
          })
      })
      const disconnected = (): void => {
        if (socket !== next) return
        journal.disconnect()
        disconnectedBefore = true
        socket = null
        next.close()
        connectionListeners.forEach((listener) => {
          listener(false)
        })
        scheduleReconnect()
      }
      next.addEventListener("close", disconnected)
      next.addEventListener("error", disconnected)
    } catch {
      if (generation !== socketGeneration || listeners.size === 0) return
      journal.disconnect()
      disconnectedBefore = true
      connectionListeners.forEach((listener) => {
        listener(false)
      })
      scheduleReconnect()
    } finally {
      connecting = false
    }
  }
  const request: ApiRequest = async (route, input, pathValues = {}) => {
    const [method, routePath] = String(route).split(" ")
    if (!method || !routePath) throw new Error(`invalid route ${String(route)}`)
    const path = replacePath(routePath, pathValues)
    const isGet = method === "GET"
    const query = isGet
      ? Object.entries(input as Record<string, unknown>)
          .filter(([, value]) => value !== undefined && value !== null && value !== "")
          .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
          .join("&")
      : ""
    const send = (): Promise<Response> => {
      const url = `${endpoint.baseUrl}/api/v1${path}${query ? `?${query}` : ""}`
      const headers = { ...authHeaders(endpoint.token), ...(!isGet ? { "Content-Type": "application/json" } : {}) }
      return fetchImpl(url, {
        method,
        headers,
        credentials: "same-origin",
        signal: AbortSignal.timeout(30_000),
        ...(!isGet ? { body: JSON.stringify(input) } : {}),
      })
    }
    let response: Response
    try {
      response = await send()
    } catch {
      // Only reads may be replayed. A lost mutation response may already have committed.
      if (!isGet) throw new ApiError(0, "", undefined, "TOURI-E1010")
      try {
        await refreshEndpoint()
        response = await send()
      } catch {
        reconnectUnavailableService()
        throw new ApiError(0, "", undefined, "TOURI-E1009")
      }
    }
    if (!response.ok) {
      const detail = await response.text()
      let message = detail
      let errorCode: string | undefined
      let code: RegisteredErrorCode | undefined
      try {
        const parsed = JSON.parse(detail) as { error?: unknown; errorCode?: unknown; code?: unknown }
        if (typeof parsed.error === "string") message = parsed.error
        if (typeof parsed.errorCode === "string") errorCode = parsed.errorCode
        if (isErrorCode(parsed.code)) code = parsed.code
      } catch {
        // Keep the plain response body when it is not JSON.
      }
      const retryAfter = response.headers.get("Retry-After")
      const retryAt = retryAfter
        ? /^\d+$/.test(retryAfter)
          ? Date.now() + Number(retryAfter) * 1000
          : Date.parse(retryAfter)
        : undefined
      const error = new ApiError(response.status, message, errorCode, code, retryAt)
      if (isGet && isServiceUnavailable(error)) reconnectUnavailableService()
      throw error
    }
    if (isBlobRoute(String(route))) return (await response.blob()) as ApiRoutes[typeof route]["res"]
    return (await response.json()) as ApiRoutes[typeof route]["res"]
  }

  const journal = createSendJournal({
    request,
    storage: localStorage,
    scope: initialEndpoint.scope ?? null,
    emit: (event) =>
      listeners.forEach((listener) => {
        listener({ seq: 0, at: Date.now(), event })
      }),
  })
  journal.stop()

  const subscribe = (listener: (envelope: UiEventEnvelope) => void): (() => void) => {
    listeners.add(listener)
    journal.watchDeadlines()
    for (const message of journal.messages())
      listener({ seq: 0, at: Date.now(), event: { type: "message.created", message } })
    void connect()
    return () => {
      listeners.delete(listener)
      if (listeners.size > 0) return
      socketGeneration += 1
      clearTimeout(timer)
      timer = undefined
      const previous = socket
      socket = null
      previous?.close()
      journal.disconnect()
      journal.stop()
    }
  }

  return {
    request,
    uploadAttachment: async (file) => {
      if (file.size > maxAttachmentBytes) throw new Error(t("Escolha um arquivo de até 15 MB"))
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "")
        reader.onerror = () => reject(new Error("Não foi possível ler o arquivo"))
        reader.readAsDataURL(file)
      })
      const response = await fetchImpl(`${endpoint.baseUrl}/api/v1/attachments`, {
        method: "POST",
        headers: { ...authHeaders(endpoint.token), "Content-Type": "application/json" },
        credentials: "same-origin",
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ name: file.name, dataBase64 }),
      })
      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as { error?: unknown; errorCode?: string } | null
        throw new ApiError(
          response.status,
          typeof detail?.error === "string" ? detail.error : t("Não foi possível anexar o arquivo"),
          detail?.errorCode,
        )
      }
      return ((await response.json()) as { attachment: Attachment }).attachment
    },
    updateEndpoint,
    sendMessage: journal.enqueue,
    pendingMessages: journal.messages,
    subscribe,
    cursorReady: () =>
      cursorKnown
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            let fallback: ReturnType<typeof setTimeout> | undefined
            const done = (): void => {
              clearTimeout(fallback)
              cursorWaiters = cursorWaiters.filter((waiter) => waiter !== done)
              resolve()
            }
            fallback = setTimeout(done, CURSOR_WAIT_MS)
            cursorWaiters.push(done)
          }),
    isMock: false,
    websocketUrl,
    subscribeConnection: (listener) => {
      connectionListeners.add(listener)
      return () => {
        connectionListeners.delete(listener)
      }
    },
  }
}

const postJson = async (path: string, body: unknown): Promise<boolean> =>
  (
    await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  ).ok

type WebHandlers = {
  [K in keyof TauriCommands]?: (args: TauriCommands[K]["args"]) => Promise<TauriCommands[K]["result"] | null>
}

const webHandlers: WebHandlers = {
  secret_save: async ({ account, value }) => ((await postJson("/api/v1/host/secret", { account, value })) ? {} : null),
  open_external: async ({ url }) => {
    window.open(url, "_blank", "noopener")
    return {}
  },
}

/** Browser stand-ins for the few desktop-only commands that make sense on a server. */
export const createWebInvoke = (): TauriInvoke => async (command, args) => webHandlers[command]?.(args) ?? null

export const createTauriInvoke = (): TauriInvoke => async (command, args) => {
  if (!("__TAURI_INTERNALS__" in window)) return createWebInvoke()(command, args)
  if (command === "secret_save") {
    const mode = await invoke<ServerModeStatus>("server_mode_status", {})
    if (mode.mode === "server") {
      const endpoint = await invoke<Endpoint>("sidecar_endpoint", {})
      if (!isEndpoint(endpoint)) throw new Error("SERVER_CONNECTION_FAILED")
      const response = await fetch(`${endpoint.baseUrl}/api/v1/host/secret`, {
        method: "POST",
        headers: { ...authHeaders(endpoint.token), "Content-Type": "application/json" },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) throw new Error("SERVER_CONNECTION_FAILED")
      return {} as TauriCommands[typeof command]["result"]
    }
  }
  return invoke<TauriCommands[typeof command]["result"]>(command, args)
}
