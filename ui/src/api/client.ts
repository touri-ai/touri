import { invoke } from "@tauri-apps/api/core"
import {
  type ApiRoutes,
  type Attachment,
  isErrorCode,
  isServerProtocolCompatible,
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
import { type ConnectionStatus, getConnectionErrorCode, getWhileActive, isSessionRejected } from "./connectionStatus"
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
  "GET /session",
  "GET /push",
  "PUT /push",
  "DELETE /push",
  "POST /push/test",
  "POST /threads/:id/notices",
  "GET /people",
  "POST /pairing-codes",
  "GET /invites",
  "POST /invites",
  "POST /invites/:id/resend",
  "GET /invites/:id/link",
  "DELETE /invites/:id",
  "DELETE /people/:id",
  "GET /email",
  "PUT /email",
  "DELETE /email",
  "POST /email/test",
  "GET /public-address",
  "PUT /public-address",
  "POST /auth/email",
  "POST /auth/email/redeem",
  "GET /workspace/activity",
  "GET /runs",
  "GET /groups",
  "GET /groups/:id/people",
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
  "GET /threads/:id/delete-preview",
  "DELETE /threads/:id",
  "POST /threads/delete",
  "GET /threads/:id/transcript",
  "GET /threads/:id/messages",
  "GET /threads/:id/goal",
  "POST /threads/:id/goal",
  "PATCH /threads/:id/goal",
  "POST /threads/:id/messages",
  "POST /threads/:id/prepare",
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
  "POST /browser/tabs/:id/takeover/session",
  "POST /browser/tabs/:id/takeover/frame",
  "POST /browser/tabs/:id/takeover/input",
  "DELETE /browser/tabs/:id/takeover/session",
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
  transport?: { signal?: AbortSignal },
) => Promise<ApiRoutes[K]["res"]>

export type UiApi = {
  updateEndpoint?: (endpoint: Endpoint) => void
  request: ApiRequest
  sendMessage?: (input: SendMessageInput) => Promise<{ message: Message; run: Run | null }>
  pendingMessages?: () => Message[]
  subscribe: (listener: (envelope: UiEventEnvelope) => void) => () => void
  subscribeConnection?: (listener: (connected: boolean, errorCode?: string) => void) => () => void
  getConnectionStatus?: () => ConnectionStatus
  subscribeConnectionStatus?: (listener: (status: ConnectionStatus) => void) => () => void
  retryConnection?: () => void
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
  const connectionListeners = new Set<(connected: boolean, errorCode?: string) => void>()
  // Browser transport callbacks own this local state and the listener/timer lifecycle.
  const statusListeners = new Set<(status: ConnectionStatus) => void>()
  let connectionStatus: ConnectionStatus = { state: "connecting", attempt: 0, retryAt: null }
  const setConnectionStatus = (
    state: ConnectionStatus["state"],
    attempt: number,
    retryAt: number | null,
    errorCode?: string,
  ): void => {
    connectionStatus = Object.assign({ state, attempt, retryAt }, errorCode ? { errorCode } : {})
    statusListeners.forEach((listener) => {
      listener(connectionStatus)
    })
  }
  const isDeviceOffline = (): boolean => navigator.onLine === false && (!endpoint.token || Boolean(endpoint.scope))
  let socket: WebSocket | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let connectionDeadline: ReturnType<typeof setTimeout> | undefined
  let attemptController: AbortController | undefined
  let delay = 250
  let openedBefore = false
  let disconnectedBefore = false
  let connecting = false
  let socketGeneration = 0
  let lastSeq = 0
  let incompatible = false
  const requireSession = (): void => {
    if (connectionStatus.state !== "session-expired") return

    throw new ApiError(401, "", "UNAUTHORIZED")
  }
  const requireCompatibleProtocol = (): void => {
    if (incompatible)
      throw new ApiError(
        503,
        t("Esta versão do aplicativo precisa de uma atualização para conversar com o servidor."),
        "SERVER_VERSION_MISMATCH",
      )
  }
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
  const refreshEndpoint = async (signal = AbortSignal.timeout(10_000)): Promise<void> => {
    if (!resolveEndpoint) return
    const generation = socketGeneration
    // Cache even the deadline rejection until native IPC settles, so a stalled call cannot grow waiters.
    recovering ??= getWhileActive(
      resolveEndpoint()
        .then((next) => {
          if (generation !== socketGeneration) return
          updateEndpoint(next)
        })
        .finally(() => {
          recovering = null
        }),
      AbortSignal.timeout(1000),
    )
    await getWhileActive(recovering, signal)
  }
  const websocketUrl = async (path: string, signal?: AbortSignal): Promise<string> => {
    requireSession()
    requireCompatibleProtocol()
    const response = await fetchImpl(`${endpoint.baseUrl}/api/v1/ws-ticket`, {
      method: "POST",
      headers: { ...authHeaders(endpoint.token), "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ path }),
      signal: signal ?? AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as { errorCode?: string } | null
      const error = new ApiError(response.status, t("Reconectando…"), detail?.errorCode)
      if (isSessionRejected(error)) pauseRejectedSession()
      throw error
    }
    const body = (await response.json()) as { ticket?: unknown }
    if (typeof body.ticket !== "string" || !body.ticket) throw new Error("Conexão indisponível")
    const url = new URL(endpoint.wsUrl)
    url.pathname = path
    url.search = ""
    url.searchParams.set("ticket", body.ticket)
    return url.toString()
  }
  const scheduleReconnect = (errorCode?: string): void => {
    if (timer || listeners.size === 0) return
    if (connectionStatus.state === "session-expired" || connectionStatus.state === "incompatible" || incompatible)
      return
    if (isDeviceOffline()) {
      setConnectionStatus("offline", connectionStatus.attempt, null)
      return
    }

    setConnectionStatus("unavailable", connectionStatus.attempt, Date.now() + delay, errorCode)
    timer = setTimeout(() => {
      timer = undefined
      void connect()
    }, delay)
    delay = Math.min(delay * 2, 1000)
  }
  const reconnectUnavailableService = (): void => {
    if (listeners.size === 0 || (disconnectedBefore && !socket)) return
    if (connectionStatus.state === "session-expired") return
    // Reads can fail before the event socket notices a stalled server.
    clearTimeout(connectionDeadline)
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
  const pauseRejectedSession = (): void => {
    if (connectionStatus.state === "session-expired") return
    // The local shell can rotate its service token on restart; remote pairing is a separate boundary.
    if (resolveEndpoint && endpoint.token && !endpoint.scope) {
      reconnectUnavailableService()
      return
    }

    socketGeneration += 1
    clearTimeout(timer)
    timer = undefined
    clearTimeout(connectionDeadline)
    attemptController?.abort()
    const previous = socket
    socket = null
    disconnectedBefore = true
    previous?.close()
    journal.disconnect()
    setConnectionStatus("session-expired", connectionStatus.attempt, null)
    connectionListeners.forEach((listener) => {
      listener(false, "UNAUTHORIZED")
    })
  }
  const connect = async (): Promise<void> => {
    if (connecting || socket || listeners.size === 0) return
    if (connectionStatus.state === "session-expired" || incompatible) return
    if (isDeviceOffline()) {
      pauseOfflineConnection()
      return
    }

    connecting = true
    setConnectionStatus(disconnectedBefore ? "unavailable" : "connecting", connectionStatus.attempt + 1, null)
    const generation = socketGeneration
    const controller = new AbortController()
    attemptController = controller
    connectionDeadline = setTimeout(() => {
      controller.abort()
      reconnectUnavailableService()
    }, 1000)
    try {
      if (openedBefore || delay > 250) await refreshEndpoint(controller.signal)
      if (generation !== socketGeneration || listeners.size === 0) return
      controller.signal.throwIfAborted()
      // Health is authenticated through the same relay/cookie boundary as normal reads.
      if (disconnectedBefore) await request("GET /health", {}, {}, { signal: controller.signal })
      const url = new URL(await websocketUrl("/api/v1/events", controller.signal))
      if (generation !== socketGeneration || listeners.size === 0) return
      controller.signal.throwIfAborted()
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
        clearTimeout(connectionDeadline)
        const reconnected = openedBefore || disconnectedBefore
        openedBefore = true
        disconnectedBefore = false
        delay = 250
        setConnectionStatus("connected", connectionStatus.attempt, null)
        journal.reconnect()
        if (reconnected)
          connectionListeners.forEach((listener) => {
            listener(true)
          })
      })
      const disconnected = (): void => {
        if (socket !== next) return
        clearTimeout(connectionDeadline)
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
    } catch (error) {
      clearTimeout(connectionDeadline)
      if (generation !== socketGeneration || listeners.size === 0) return
      if (isSessionRejected(error)) {
        pauseRejectedSession()
        return
      }
      journal.disconnect()
      disconnectedBefore = true
      if (error instanceof ApiError && error.errorCode === "SERVER_VERSION_MISMATCH")
        setConnectionStatus("incompatible", connectionStatus.attempt, null)
      connectionListeners.forEach((listener) => {
        if (error instanceof ApiError && error.errorCode === "SERVER_VERSION_MISMATCH") {
          listener(false, error.errorCode)
          return
        }
        listener(false)
      })
      scheduleReconnect(getConnectionErrorCode(error))
    } finally {
      connecting = false
      if (generation !== socketGeneration && listeners.size > 0) scheduleReconnect()
    }
  }
  const request: ApiRequest = async (route, input, pathValues = {}, transport = {}) => {
    requireSession()
    const [method, routePath] = String(route).split(" ")
    if (!method || !routePath) throw new Error(`invalid route ${String(route)}`)
    const path = replacePath(routePath, pathValues)
    const isGet = method === "GET"
    if (!isGet) requireCompatibleProtocol()
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
        signal: transport.signal
          ? AbortSignal.any([transport.signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
        ...(!isGet ? { body: JSON.stringify(input) } : {}),
      })
    }
    let response: Response
    try {
      response = await send()
    } catch {
      transport.signal?.throwIfAborted()
      // Only reads may be replayed. A lost mutation response may already have committed.
      if (!isGet) {
        reconnectUnavailableService()
        throw new ApiError(0, "", undefined, "TOURI-E1010")
      }
      try {
        await refreshEndpoint(transport.signal)
        response = await send()
      } catch {
        transport.signal?.throwIfAborted()
        reconnectUnavailableService()
        throw new ApiError(0, "", undefined, "TOURI-E1009")
      }
    }
    if (!response.ok) {
      const detail = await response.text()
      let message = detail
      let errorCode: string | undefined
      let code: RegisteredErrorCode | undefined
      let field: unknown
      try {
        const parsed = JSON.parse(detail) as { error?: unknown; errorCode?: unknown; code?: unknown; field?: unknown }
        if (typeof parsed.error === "string") message = parsed.error
        if (typeof parsed.errorCode === "string") errorCode = parsed.errorCode
        if (isErrorCode(parsed.code)) code = parsed.code
        field = parsed.field
      } catch {
        transport.signal?.throwIfAborted()
        // Keep the plain response body when it is not JSON.
      }
      const retryAfter = response.headers.get("Retry-After")
      const retryAt = retryAfter
        ? /^\d+$/.test(retryAfter)
          ? Date.now() + Number(retryAfter) * 1000
          : Date.parse(retryAfter)
        : undefined
      const error = new ApiError(response.status, message, errorCode, code, retryAt, field)
      if (isSessionRejected(error)) pauseRejectedSession()
      if (isGet && isServiceUnavailable(error)) reconnectUnavailableService()
      throw error
    }
    if (isBlobRoute(String(route))) return (await response.blob()) as ApiRoutes[typeof route]["res"]
    const result = await response.json()
    if (route === "GET /health") {
      incompatible = !isServerProtocolCompatible(result)
      requireCompatibleProtocol()
    }
    return result as ApiRoutes[typeof route]["res"]
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

  const retryConnection = (): void => {
    if (listeners.size === 0) return
    if (connectionStatus.state === "session-expired" || incompatible || isDeviceOffline()) return
    clearTimeout(timer)
    timer = undefined
    delay = 250
    if (socket) reconnectUnavailableService()
    attemptController?.abort()
    // An aborted fetch settles in a microtask; let it release the single in-flight attempt first.
    clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void connect()
    }, 0)
  }

  const retryVisibleConnection = (): void => {
    if (document.visibilityState === "hidden") return
    retryConnection()
  }

  const pauseOfflineConnection = (): void => {
    if (!isDeviceOffline() || connectionStatus.state === "session-expired") return

    socketGeneration += 1
    clearTimeout(timer)
    timer = undefined
    clearTimeout(connectionDeadline)
    attemptController?.abort()
    const previous = socket
    socket = null
    disconnectedBefore = true
    previous?.close()
    journal.disconnect()
    setConnectionStatus("offline", connectionStatus.attempt, null)
    connectionListeners.forEach((listener) => {
      listener(false)
    })
  }

  const subscribe = (listener: (envelope: UiEventEnvelope) => void): (() => void) => {
    if (listeners.size === 0) {
      window.addEventListener("online", retryConnection)
      window.addEventListener("offline", pauseOfflineConnection)
      document.addEventListener("visibilitychange", retryVisibleConnection)
    }
    listeners.add(listener)
    journal.watchDeadlines()
    for (const message of journal.messages())
      listener({ seq: 0, at: Date.now(), event: { type: "message.created", message } })
    void connect()
    return () => {
      listeners.delete(listener)
      if (listeners.size > 0) return
      socketGeneration += 1
      window.removeEventListener("online", retryConnection)
      window.removeEventListener("offline", pauseOfflineConnection)
      document.removeEventListener("visibilitychange", retryVisibleConnection)
      clearTimeout(connectionDeadline)
      attemptController?.abort()
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
      requireSession()
      requireCompatibleProtocol()
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
        const error = new ApiError(
          response.status,
          typeof detail?.error === "string" ? detail.error : t("Não foi possível anexar o arquivo"),
          detail?.errorCode,
        )
        if (isSessionRejected(error)) pauseRejectedSession()
        throw error
      }
      return ((await response.json()) as { attachment: Attachment }).attachment
    },
    updateEndpoint,
    sendMessage: journal.enqueue,
    pendingMessages: journal.messages,
    getConnectionStatus: () => connectionStatus,
    subscribeConnectionStatus: (listener) => {
      statusListeners.add(listener)
      listener(connectionStatus)
      return () => {
        statusListeners.delete(listener)
      }
    },
    retryConnection: () => {
      if (connectionStatus.state === "session-expired")
        setConnectionStatus("unavailable", connectionStatus.attempt, null)
      retryConnection()
    },
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
