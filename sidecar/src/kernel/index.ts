import { randomBytes } from "node:crypto"
import { join } from "node:path"
import type { HostNotification, Kernel, RouteModule, SidecarHandshake, UiEvent } from "@touri/contracts"
import type { ServerWebSocket } from "bun"
import { retryDeletedBrowserSessionKeys } from "../browser/sessionVault"
import { compressBufferedResponse } from "../cli/web/compression"
import { getHostIdentity } from "../platform/host"
import { stopBotHomeWriter } from "../store/bot-home"
import { touriVersion } from "../version"
import { getFileIoStats } from "./async-files"
import { createBackgroundTask, getMeasuredStage, yieldBackground } from "./background-task"
import { createStorageMaintenance } from "./data-maintenance"
import { openDatabase, SCHEMA_VERSION } from "./db"
import { bindDeviceSession, type DeviceSession, deviceSession, socketDeviceContext } from "./device-session"
import { errorResponse, normalizeErrorBody } from "./errors"
import { createEventBus, type EventSocketData } from "./event-bus"
import {
  atomicWriteFile,
  attachmentMime,
  ensurePrivateDirectory,
  rasterMime,
  readBoundedFile,
  removePrivateFile,
} from "./files"
import { historyMigrationStatus, startHistoryBackfill } from "./history-backfill"
import { createHostClient } from "./host-client"
import { newId } from "./ids"
import { createLogger } from "./log"
import { createAppPaths } from "./paths"
import {
  createPerformanceDiagnostics,
  createPerformanceStageTracker,
  type PerformanceStageRunner,
  type PerformanceStageTracker,
} from "./performance"
import { createRedactor } from "./redact"
import { createRouteRegistry } from "./routes"
import { createServices } from "./services"
import { buildChildEnv, createShellEnv } from "./shell-env"
import { spawnTree } from "./spawn"
import { createSlowStatementTracker } from "./sqlite-performance"
import { createToolRegistry } from "./tool-registry"
import { createSocketTickets, socketEndpoint } from "./ws-tickets"

export type WebInterceptArgs = { request: Request; url: URL; clientIp: string | null }

export type WebMode = {
  hostname: string
  port: number
  intercept: (args: WebInterceptArgs) => Promise<Response | null>
  host: (deps: { publish: Kernel["publish"]; log: Kernel["log"] }) => Kernel["callHost"]
}

export type KernelRuntime = {
  kernel: Kernel
  runStage: PerformanceStageRunner
  handshake: SidecarHandshake
  stop: () => Promise<void>
  emitHostNotification: (notification: HostNotification) => void
}

type KernelSocketData = (
  | EventSocketData
  | { channel: "desktop"; id: string }
  | { channel: "machine-presence"; release: () => void }
) & { session?: DeviceSession }

export { buildChildEnv }

const version = touriVersion
export const allowedOrigins = new Set(["tauri://localhost", "http://tauri.localhost", "http://localhost:1420"])

export const isAllowedOrigin = (origin: string | null): origin is string =>
  origin !== null && allowedOrigins.has(origin)

const NATIVE_CLIENT_HEADER = "x-touri-client"
const API_PREFIXES = ["/api/v1", "/api"] as const

const apiPrefixOf = (pathname: string): string | null =>
  API_PREFIXES.find((prefix) => pathname.startsWith(`${prefix}/`)) ?? null

const isNativeClient = (request: Request): boolean =>
  request.headers.get("origin") === null && request.headers.has(NATIVE_CLIENT_HEADER)

const corsHeaders = (origin: string | null): Record<string, string> =>
  isAllowedOrigin(origin)
    ? {
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods": "GET, HEAD, POST, PATCH, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Expose-Headers": "Content-Type",
        Vary: "Origin",
      }
    : {}

const jsonResponse = (status: number, body: unknown, origin: string | null = null): Response =>
  Response.json(normalizeErrorBody(body, status), {
    status,
    headers: { "Cache-Control": "no-store", ...corsHeaders(origin) },
  })

const bearer = (request: Request): string | null => {
  const header = request.headers.get("authorization")
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null
}

const authFailure = ({
  request,
  url,
  token,
  port,
  authenticatedTicket,
}: {
  request: Request
  url: URL
  token: string
  port: number
  authenticatedTicket: boolean
}): Response | null => {
  const origin = request.headers.get("origin")
  if (url.searchParams.has("token") || (!authenticatedTicket && bearer(request) !== token))
    return jsonResponse(401, { errorCode: "UNAUTHORIZED", error: "Invalid bearer token" }, origin)
  if (!isAllowedOrigin(origin) && !isNativeClient(request))
    return jsonResponse(403, { errorCode: "FORBIDDEN", error: "Invalid Origin" }, origin)
  if (request.headers.get("host") !== `127.0.0.1:${port}`)
    return jsonResponse(421, { errorCode: "MISDIRECTED_REQUEST", error: "Invalid Host" }, origin)
  return null
}

const corsPreflight = (request: Request, port: number): Response => {
  const origin = request.headers.get("origin")
  if (!isAllowedOrigin(origin)) return jsonResponse(403, { errorCode: "FORBIDDEN", error: "Invalid Origin" }, origin)
  if (request.headers.get("host") !== `127.0.0.1:${port}`)
    return jsonResponse(421, { errorCode: "MISDIRECTED_REQUEST", error: "Invalid Host" }, origin)
  return new Response(null, { status: 204, headers: corsHeaders(origin) })
}

/** The public fixture token is only valid under `bun test`; any other launch without a token is unreachable. */
const developmentUiToken = (): string =>
  process.env.NODE_ENV === "test" ? "dev-ui-token" : randomBytes(32).toString("hex")

const parseBody = async (request: Request): Promise<unknown> => {
  if (["GET", "HEAD"].includes(request.method)) return {}
  const text = await request.text()
  if (!text) return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

export const createKernel = ({
  appData,
  web,
  stageTracker = createPerformanceStageTracker(),
}: {
  appData?: string
  web?: WebMode
  stageTracker?: PerformanceStageTracker
} = {}): KernelRuntime => {
  const paths = appData === undefined ? createAppPaths() : createAppPaths({ appData })
  for (const directory of [
    paths.appData,
    paths.runDir,
    paths.botsDir,
    paths.attachmentsDir,
    paths.projectsDir,
    paths.browserDir,
    paths.sessionsDir,
    paths.importsDir,
    paths.logsDir,
  ]) {
    ensurePrivateDirectory({ root: paths.appData, path: directory })
  }
  ensurePrivateDirectory({ root: paths.appData, path: join(paths.runDir, "mcp-tokens") })

  const redactor = createRedactor()
  const log = createLogger({ paths, redact: redactor.redact })
  const slowStatements = createSlowStatementTracker({
    log,
    getStage: () => stageTracker.getCurrentStage() ?? "unattributed",
  })
  const database = openDatabase({ filename: paths.db, slowStatements })
  const services = createServices()
  const tools = createToolRegistry()
  const recentErrors: Array<{ code: string; at: number }> = []
  services.provide("diagnostics.errors", () =>
    recentErrors.filter((item) => Date.now() - item.at <= 24 * 60 * 60_000).map((item) => ({ ...item })),
  )
  const routes = createRouteRegistry((code) => {
    recentErrors.push({ code, at: Date.now() })
    if (recentErrors.length > 500) recentErrors.shift()
  })
  const bus = createEventBus(database, stageTracker.run, { deferRecovery: true })
  const notifications = new Set<(notification: HostNotification) => void>()
  const socketHost = createHostClient({
    socketPath: process.env.TOURI_HOST_SOCK ?? join(paths.runDir, "host.sock"),
    token: process.env.TOURI_HOST_TOKEN ?? "",
    onNotification: (notification) => {
      for (const listener of notifications) listener(notification)
    },
  })
  const host = web ? { callHost: web.host({ publish: bus.publish, log }), close: () => undefined } : socketHost
  const processSpawn = (input: Parameters<typeof spawnTree>[0]) => spawnTree(input)
  const shell = createShellEnv({ spawn: processSpawn })

  routes.registerRoutes({
    name: "kernel",
    routes: [
      {
        method: "POST",
        path: "/ui/errors",
        handler: async ({ body }) => {
          if (!body || typeof body !== "object") return { status: 400, json: { errorCode: "INVALID_ARGS" } }
          const report = body as Record<string, unknown>
          if (
            !["area", "message", "stack", "componentStack"].every(
              (key) => typeof report[key] === "string" && report[key].length <= 16_000,
            )
          )
            return { status: 400, json: { errorCode: "INVALID_ARGS" } }
          log({
            level: "error",
            module: "ui",
            msg: "Falha de renderização",
            data: {
              code: "TOURI-E1000",
              area: report.area,
              message: report.message,
              stack: report.stack,
              componentStack: report.componentStack,
            },
          })
          return { status: 200, json: { ok: true } }
        },
      },
      {
        method: "GET",
        path: "/health",
        handler: async () => ({
          status: 200,
          json: {
            ok: true,
            version,
            schemaVersion: SCHEMA_VERSION,
            draining: services.use("runtime.isDraining")?.() ?? false,
            ...getHostIdentity(),
            historyMigration: historyMigrationStatus(database),
            eventLoop: diagnostics.getSnapshot(),
          },
        }),
      },
    ],
  })

  const tickets = createSocketTickets()
  const liveSockets = new Set<ServerWebSocket<KernelSocketData>>()
  const eventSockets = new WeakMap<ServerWebSocket<KernelSocketData>, Parameters<typeof bus.add>[0]>()
  const pendingRequests = new Set<AbortController>()
  const sseRequests = new Set<AbortController>()
  const diagnostics = createPerformanceDiagnostics({
    log,
    stageTracker,
    slowStatements,
    getContext: () => ({
      activeRuns: (
        database.query("SELECT count(*) AS count FROM runs WHERE status IN ('starting', 'running')").get() as {
          count: number
        }
      ).count,
      fileIo: getFileIoStats(),
      sseClients: sseRequests.size,
      websocketClients: liveSockets.size,
    }),
  })
  const getRequestTemplate = (request: Request): string => {
    const pathname = new URL(request.url).pathname
    const prefix = apiPrefixOf(pathname)
    if (prefix === null) return "unmatched"
    if (request.method === "POST" && pathname === `${prefix}/ws-ticket`) return "/ws-ticket"
    if (socketEndpoint(pathname)) {
      if (pathname.endsWith("/presence/socket")) return "/bots/:id/machine/presence/socket"
      if (pathname.endsWith("/socket")) return "/desktop/:id/socket"
      return "/events"
    }

    return routes.getTemplate(request.method, pathname.slice(prefix.length)) ?? "unmatched"
  }
  const revocationTask = createBackgroundTask(
    "device_revocation",
    async () => {
      const measure = getMeasuredStage("device_revocation", stageTracker.run)
      let scanned = 0
      for (const socket of liveSockets) {
        measure(() => {
          if (!socket.data.session || socket.data.session.active()) return

          if (socket.data.channel === "machine-presence") socket.data.release()
          if (socket.data.channel === "desktop") services.use("vm.desktop")?.close(socket.data.id)
          socket.close(4003, "Acesso do dispositivo encerrado")
          liveSockets.delete(socket)
        })
        scanned += 1
        if (scanned % 50 === 0) await yieldBackground()
        if (revocationTask.isStopped()) return
      }
      for (const controller of pendingRequests) {
        measure(() => {
          const session = deviceSession(controller.signal)
          if (session && !session.active()) controller.abort()
        })
        scanned += 1
        if (scanned % 50 === 0) await yieldBackground()
        if (revocationTask.isStopped()) return
      }
    },
    stageTracker.run,
  )
  const revocationTimer = setInterval(() => {
    void revocationTask.run().catch(() => undefined)
  }, 250)
  revocationTimer.unref()
  const uiToken = process.env.TOURI_UI_TOKEN || developmentUiToken()
  const server = Bun.serve<KernelSocketData>({
    hostname: web?.hostname ?? "127.0.0.1",
    port: web?.port ?? 0,
    // Login source discovery and credential reads each have a five-second vault deadline.
    idleTimeout: 30,
    maxRequestBodySize: 32 * 1024 * 1024,
    error: (error) => {
      const failure = errorResponse(error)
      log({ level: "error", module: "kernel", msg: "Falha na solicitação HTTP", data: { code: failure.json.code } })
      return jsonResponse(failure.status, failure.json)
    },
    fetch: diagnostics.observeFetch<KernelSocketData>(async (request, bunServer) => {
      const url = new URL(request.url)
      const desktopId = /^\/api\/v1\/desktop\/([a-f0-9]{48})\/socket$/.exec(url.pathname)?.[1]
      const presenceBotId = /^\/api\/v1\/bots\/([a-zA-Z0-9-]+)\/machine\/presence\/socket$/.exec(url.pathname)?.[1]
      const isWebSocket =
        (url.pathname === "/api/v1/events" || desktopId !== undefined || presenceBotId !== undefined) &&
        request.headers.get("upgrade")?.toLowerCase() === "websocket"
      if (url.searchParams.has("token")) return jsonResponse(401, { errorCode: "UNAUTHORIZED" })
      const ticketValue = isWebSocket ? url.searchParams.get("ticket") : null
      const ticket = ticketValue ? tickets.consume(ticketValue, url.pathname) : null
      if (ticketValue && !ticket) return jsonResponse(401, { errorCode: "UNAUTHORIZED" })
      if (ticket?.session) bindDeviceSession(request.signal, ticket.session)
      const early = web
        ? await web.intercept({ request, url, clientIp: bunServer.requestIP(request)?.address ?? null })
        : null
      if (early) return early
      if (!web && request.method === "OPTIONS") return corsPreflight(request, bunServer.port ?? 0)
      const session = deviceSession(request.signal)
      const failure = web
        ? null
        : authFailure({
            request,
            url,
            token: uiToken,
            port: bunServer.port ?? 0,
            authenticatedTicket: ticket !== null,
          })
      if (failure) return failure
      if (!web && isWebSocket && !ticket) return jsonResponse(401, { errorCode: "UNAUTHORIZED" })
      if (request.method === "POST" && url.pathname === "/api/v1/ws-ticket") {
        const origin = request.headers.get("origin")
        const body = await parseBody(request)
        const path = body && typeof body === "object" && "path" in body ? body.path : null
        if (typeof path !== "string" || !socketEndpoint(path))
          return jsonResponse(400, { errorCode: "INVALID_ARGS" }, origin)
        const person = session?.person
        if (
          person?.role === "member" &&
          !services.use("work.authorizeSocket")?.({ personId: person.id, role: person.role, path })
        )
          return jsonResponse(403, { errorCode: "FORBIDDEN" }, origin)
        const value = tickets.mint(path, session)
        return value
          ? jsonResponse(201, { ticket: value }, origin)
          : jsonResponse(429, { errorCode: "RATE_LIMITED" }, origin)
      }
      if (isWebSocket) {
        const person = session?.person
        if (
          person?.role === "member" &&
          !services.use("work.authorizeSocket")?.({ personId: person.id, role: person.role, path: url.pathname })
        )
          return jsonResponse(404, { errorCode: "NOT_FOUND" })
        const since = desktopId || presenceBotId ? 0 : Number(url.searchParams.get("since") ?? 0)
        if (!desktopId && (!Number.isSafeInteger(since) || since < 0))
          return jsonResponse(400, { errorCode: "INVALID_CURSOR", error: "Sequência inválida" })
        if (desktopId && !socketDeviceContext.run(session, () => services.use("vm.desktop")?.claim(desktopId)))
          return jsonResponse(410, { errorCode: "DESKTOP_EXPIRED", error: "Conexão da tela expirada" })
        let release: (() => void) | undefined
        if (presenceBotId) {
          const vm = services.use("vm.runtime")
          if (!vm?.holdViewer || services.use("store.api")?.getBot({ botId: presenceBotId })?.machine !== "vm")
            return jsonResponse(404, { errorCode: "NOT_FOUND" })
          try {
            const releaseViewer = vm.holdViewer(presenceBotId)
            let released = false
            release = () => {
              if (!released) {
                released = true
                releaseViewer()
              }
            }
          } catch {
            return jsonResponse(409, { errorCode: "MACHINE_ERROR" })
          }
        }
        const upgraded = bunServer.upgrade(request, {
          data: {
            ...(release
              ? { channel: "machine-presence", release }
              : desktopId
                ? { channel: "desktop", id: desktopId }
                : { channel: "events", since }),
            ...(session ? { session } : {}),
          },
        })
        if (!upgraded) release?.()
        if (!upgraded && desktopId) services.use("vm.desktop")?.close(desktopId)
        return upgraded
          ? undefined
          : jsonResponse(400, { errorCode: "WS_UPGRADE_FAILED", error: "WebSocket upgrade failed" })
      }
      const prefix = apiPrefixOf(url.pathname)
      if (prefix !== null && url.pathname === `${prefix}/events`) bunServer.timeout(request, 0)
      if (prefix === null)
        return jsonResponse(404, { errorCode: "NOT_FOUND", error: "Route not found" }, request.headers.get("origin"))
      const body = await parseBody(request)
      if (body === null)
        return jsonResponse(
          400,
          { errorCode: "INVALID_JSON", error: "Request body is not valid JSON" },
          request.headers.get("origin"),
        )
      const controller = new AbortController()
      const abortRequest = () => controller.abort()
      request.signal.addEventListener("abort", abortRequest, { once: true })
      if (request.signal.aborted) controller.abort()
      if (session) bindDeviceSession(controller.signal, session)
      pendingRequests.add(controller)
      const finish = () => {
        pendingRequests.delete(controller)
        sseRequests.delete(controller)
        controller.signal.removeEventListener("abort", finish)
        request.signal.removeEventListener("abort", abortRequest)
      }
      const response = await routes.handle({
        method: request.method,
        pathname: url.pathname.slice(prefix.length) || "/",
        query: url.searchParams,
        body,
        signal: controller.signal,
      })
      if ("stream" in response) {
        if (response.mime === "text/event-stream" && !controller.signal.aborted) sseRequests.add(controller)
        controller.signal.addEventListener("abort", finish, { once: true })
        const reader = response.stream.getReader()
        const stream = new ReadableStream<Uint8Array>({
          async pull(out) {
            try {
              const item = await reader.read()
              if (item.done) {
                finish()
                out.close()
              } else out.enqueue(item.value)
            } catch (error) {
              finish()
              out.error(error)
            }
          },
          async cancel() {
            finish()
            controller.abort()
            await reader.cancel()
          },
        })
        return new Response(stream, {
          status: response.status,
          headers: {
            "Content-Type": response.mime,
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
            "X-Content-Type-Options": "nosniff",
            ...corsHeaders(request.headers.get("origin")),
          },
        })
      }
      finish()
      if ("file" in response) {
        const bytes = readBoundedFile({
          root: paths.appData,
          path: response.file,
          maxBytes: url.pathname.includes("/attachments/") ? 15 * 1024 * 1024 : 64 * 1024 * 1024,
        })
        return new Response(new Uint8Array(bytes), {
          status: response.status,
          headers: {
            "Content-Type": attachmentMime(bytes),
            "Content-Disposition": rasterMime(bytes) ? "inline" : "attachment",
            "Content-Security-Policy": "sandbox; default-src 'none'",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
            ...corsHeaders(request.headers.get("origin")),
          },
        })
      }
      const json = jsonResponse(response.status, response.json, request.headers.get("origin"))
      return web ? compressBufferedResponse(request, json) : json
    }, getRequestTemplate),
    websocket: {
      // Presence follows connection lifetime even when hidden WebViews suspend timers.
      idleTimeout: 0,
      maxPayloadLength: 1_048_576,
      backpressureLimit: 8_388_608,
      closeOnBackpressureLimit: true,
      open: (socket) => {
        if (socket.data.session && !socket.data.session.active()) {
          socket.close(4003, "Acesso encerrado")
          return
        }
        liveSockets.add(socket)
        if (socket.data.channel === "desktop") services.use("vm.desktop")?.open(socket.data.id, socket)
        else if (socket.data.channel === "events") {
          const guarded = {
            get readyState() {
              return socket.readyState
            },
            sendText: (text: string) => {
              if (socket.data.session && !socket.data.session.active()) {
                socket.close(4003, "Acesso encerrado")
                return 0
              }
              return socket.sendText(text)
            },
            close: (code?: number, reason?: string) => socket.close(code, reason),
          }
          eventSockets.set(socket, guarded)
          const person = socket.data.session?.person
          const filter = person
            ? (event: UiEvent) =>
                services.use("work.visibleEvent")?.({ personId: person.id, role: person.role, event }) ?? false
            : undefined
          bus.add(guarded, socket.data.since, filter)
        }
      },
      message: (socket, data) => {
        if (socket.data.session && !socket.data.session.active()) {
          socket.close(4003, "Acesso encerrado")
          return
        }
        if (socket.data.channel === "desktop") services.use("vm.desktop")?.message(socket.data.id, data)
      },
      close: (socket, code) => {
        liveSockets.delete(socket)
        if (socket.data.channel === "desktop") services.use("vm.desktop")?.close(socket.data.id, code)
        else if (socket.data.channel === "machine-presence") socket.data.release()
        else {
          const guarded = eventSockets.get(socket)
          if (guarded) bus.remove(guarded)
          eventSockets.delete(socket)
        }
      },
    },
  })

  const stopHistoryBackfill = startHistoryBackfill(
    database,
    () => {
      log({ level: "error", module: "store", msg: "Atualização do histórico adiada; será retomada automaticamente" })
    },
    stageTracker.run,
  )

  const kernel: Kernel = {
    paths,
    services,
    spawnTree: processSpawn,
    db: database,
    publish: (event: UiEvent) => bus.publish(event),
    subscribe: bus.subscribe,
    registerRoutes: (module: RouteModule) => routes.registerRoutes(module),
    registerTools: tools.registerTools,
    callHost: host.callHost,
    onHostNotification: (listener) => {
      notifications.add(listener)
      return () => notifications.delete(listener)
    },
    redact: redactor.redact,
    addRedactionValue: redactor.addRedactionValue,
    shellEnv: shell.shellEnv,
    newId,
    log,
  }

  const storageMaintenance = createStorageMaintenance({
    database,
    appData: paths.appData,
    publishResync: () => kernel.publish({ type: "transcript.resync" }),
    retryDeletedBrowserSessionKeys: (signal) =>
      retryDeletedBrowserSessionKeys(
        {
          db: database,
          callHost: kernel.callHost,
          log: kernel.log,
          redact: kernel.redact,
        },
        signal,
      ),
    onError: () =>
      kernel.log({ level: "error", module: "store", msg: "Compactação adiada; será retomada automaticamente" }),
    log: kernel.log,
    runStage: stageTracker.run,
  })
  services.provide("storage.maintenance", storageMaintenance)

  const handshakePath = join(paths.runDir, "handshake.json")
  atomicWriteFile({
    root: paths.appData,
    path: handshakePath,
    content: JSON.stringify({ port: server.port ?? 0, token: uiToken, pid: process.pid, version }),
  })

  let stopPromise: Promise<void> | undefined
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise
    stopPromise = (async () => {
      diagnostics.stop()
      clearInterval(revocationTimer)
      revocationTask.dispose()
      for (const controller of pendingRequests) controller.abort()
      for (const socket of liveSockets) socket.close(1001, "Servidor encerrado")
      liveSockets.clear()
      server.stop(true)
      const store = services.use("store.api")
      if (store && !store.closeStreamWriterIfIdle?.()) await store.flushWritesAsync?.({ stopping: true })
      stopHistoryBackfill()
      storageMaintenance.dispose({ closing: true })
      services.use("vm.desktop")?.dispose()
      services.use("doctor")?.dispose()
      const homeWriterStopped = stopBotHomeWriter(kernel)
      if (homeWriterStopped) await homeWriterStopped
      removePrivateFile({ root: paths.appData, path: handshakePath })
      shell.dispose()
      host.close()
      bus.stop()
      database.close()
    })()
    return stopPromise
  }

  return {
    kernel,
    runStage: stageTracker.run,
    handshake: {
      type: "touri-sidecar-ready",
      port: server.port ?? 0,
      pid: process.pid,
      version,
      schemaVersion: SCHEMA_VERSION,
    },
    stop,
    emitHostNotification: (notification) => {
      for (const listener of notifications) listener(notification)
    },
  }
}
