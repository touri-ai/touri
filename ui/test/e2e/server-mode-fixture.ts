import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer, request as httpRequest, type Server } from "node:http"
import type { Socket } from "node:net"
import { tmpdir } from "node:os"
import { extname, join, resolve, sep } from "node:path"
import type { Page } from "@playwright/test"

const root = resolve(import.meta.dirname, "../../..")
const uiDirectory = join(root, "ui/dist")
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms))
const portOf = (server: Server): number => {
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Test listener has no loopback port")
  return address.port
}
const listen = (server: Server) =>
  new Promise<void>((done, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      done()
    })
  })
const close = (server: Server) => new Promise<void>((done) => server.close(() => done()))

/** Browser substitute for native IPC/relay only. Pairing, REST, tickets and events use a real server. */
export const createServerModeFixture = async ({ initialMode = "local" }: { initialMode?: "local" | "server" } = {}) => {
  // Playwright's global setup builds this worktree's UI before any server fixture starts.
  const dataDir = await mkdtemp(join(tmpdir(), "touri-server-mode-"))
  const reservation = createServer()
  await listen(reservation)
  const serverPort = portOf(reservation)
  await close(reservation)
  const serverUrl = `http://127.0.0.1:${serverPort}`
  const relayToken = randomBytes(32).toString("hex")
  const sockets = new Set<Socket>()
  const eventSockets = new Set<Socket>()
  let child: ChildProcess | null = null
  let remoteToken = ""
  let mode: "local" | "server" = initialMode
  let eventStreamPaused = false
  let eventConnections = 0
  let snapshotReads = 0
  let connectionTests = 0
  let localReturns = 0
  const commands: string[] = []
  const fixture = createServer()
  let relayUrl = ""

  const stop = async () => {
    const running = child
    child = null
    if (!running || running.exitCode !== null || running.signalCode !== null) return
    await new Promise<void>((done) => {
      const timeout = setTimeout(() => running.kill("SIGKILL"), 10_000)
      running.once("exit", () => {
        clearTimeout(timeout)
        done()
      })
      running.kill("SIGTERM")
    })
  }
  const dispose = async () => {
    for (const socket of sockets) socket.destroy()
    for (const socket of eventSockets) socket.destroy()
    await close(fixture)
    await stop()
    await rm(dataDir, { recursive: true, force: true })
  }
  const code = () => {
    const result = spawnSync("bun", ["run", "touri", "pair", "--data-dir", dataDir], {
      cwd: root,
      encoding: "utf8",
      timeout: 15_000,
    })
    const found = /Pairing code: ([A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4})/.exec(result.stdout ?? "")
    if (result.status !== 0 || !found?.[1]) throw new Error("The isolated pairing CLI did not create a code")
    return found[1]
  }
  const pair = async (value: string) => {
    const response = await fetch(`${serverUrl}/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: serverUrl },
      body: JSON.stringify({ code: value, name: "Desktop test", client: true }),
      redirect: "error",
    })
    const body = (await response.json()) as { token?: string }
    if (!response.ok || !body.token) throw new Error("The real server rejected the pairing code")
    remoteToken = body.token
  }
  const api = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${serverUrl}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${remoteToken}`,
        "X-Touri-Client": "desktop-test",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`Isolated server request failed (${method} ${path}: ${response.status})`)
    return response.json()
  }

  fixture.on("connection", (socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })
  fixture.on("request", async (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname
    if (path.startsWith("/api/v1/")) {
      if (request.headers.authorization !== `Bearer ${relayToken}`) {
        response.writeHead(401).end()
        return
      }
      if (path === "/api/v1/bots" && request.method === "GET") snapshotReads++
      const upstream = httpRequest(
        new URL(request.url ?? "/", serverUrl),
        {
          method: request.method,
          headers: {
            Authorization: `Bearer ${remoteToken}`,
            "X-Touri-Client": "desktop-test",
            ...(request.headers["content-type"] ? { "Content-Type": request.headers["content-type"] } : {}),
          },
        },
        (received) => {
          response.writeHead(received.statusCode ?? 502, {
            "Content-Type": received.headers["content-type"] ?? "application/json",
            "Cache-Control": "no-store",
          })
          received.pipe(response)
        },
      )
      upstream.once("error", () => {
        if (!response.headersSent) response.writeHead(503, { "Content-Type": "application/json" })
        response.end(JSON.stringify({ errorCode: "SERVER_OFFLINE", error: "Servidor de teste indisponível" }))
      })
      request.pipe(upstream)
      return
    }
    const candidate = resolve(uiDirectory, `.${path === "/" ? "/index.html" : path}`)
    if (!candidate.startsWith(`${uiDirectory}${sep}`)) {
      response.writeHead(404).end()
      return
    }
    const types: Record<string, string> = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".woff2": "font/woff2",
    }
    try {
      const bytes = await readFile(extname(path) ? candidate : join(uiDirectory, "index.html"))
      response.writeHead(200, { "Content-Type": types[extname(path)] ?? "text/html", "Cache-Control": "no-store" })
      response.end(bytes)
    } catch {
      response.writeHead(404).end()
    }
  })
  fixture.on("upgrade", (request, socket, head) => {
    const target = new URL(request.url ?? "/", serverUrl)
    if (eventStreamPaused || target.pathname !== "/api/v1/events" || !target.searchParams.get("ticket")) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n")
      return
    }
    const upstream = httpRequest(target, {
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": request.headers["sec-websocket-key"] ?? "",
        Authorization: `Bearer ${remoteToken}`,
        "X-Touri-Client": "desktop-test",
      },
    })
    upstream.once("upgrade", (received, remote, upstreamHead) => {
      eventConnections++
      eventSockets.add(remote)
      remote.once("close", () => eventSockets.delete(remote))
      const headers = Object.entries(received.headers)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\r\n")
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers}\r\n\r\n`)
      if (upstreamHead.length) socket.write(upstreamHead)
      if (head.length) remote.write(head)
      socket.pipe(remote)
      remote.pipe(socket)
      socket.once("close", () => remote.destroy())
      remote.once("close", () => socket.destroy())
      remote.once("error", () => socket.destroy())
      socket.once("error", () => remote.destroy())
    })
    upstream.once("response", () => socket.destroy())
    upstream.once("error", () => socket.destroy())
    upstream.end()
  })

  try {
    child = spawn(
      "bun",
      [
        "run",
        "touri",
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        String(serverPort),
        "--data-dir",
        dataDir,
        "--ui-dir",
        uiDirectory,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          TOURI_APP_DATA: dataDir,
          TOURI_BROWSER_HEADLESS: "1",
          TOURI_DOCTOR_SKIP_PROVIDER_PROBES: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    child.stdout?.resume()
    child.stderr?.resume()
    let started = false
    for (let attempt = 0; attempt < 300; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error("The isolated touri server exited during startup")
      started = await fetch(`${serverUrl}/pair`, { signal: AbortSignal.timeout(500) })
        .then((r) => r.ok)
        .catch(() => false)
      if (started) break
      await wait(100)
    }
    if (!started) throw new Error("The isolated touri server did not become ready")
    await pair(code())
    await listen(fixture)
    relayUrl = `http://127.0.0.1:${portOf(fixture)}`
  } catch (error) {
    await dispose()
    throw error
  }

  const install = async (page: Page) => {
    await page.exposeBinding("__serverModeInvoke", async (_source, command: string, args: Record<string, unknown>) => {
      commands.push(command)
      switch (command) {
        case "sidecar_endpoint":
          return { baseUrl: relayUrl, wsUrl: `${relayUrl.replace("http:", "ws:")}/api/v1/events`, token: relayToken }
        case "server_mode_status":
          return { mode, url: mode === "server" ? serverUrl : null }
        case "server_mode_pair":
          if (args.url !== serverUrl || typeof args.code !== "string") throw new Error("Unexpected pairing target")
          await pair(args.code)
          mode = "server"
          return { mode, url: serverUrl }
        case "server_mode_test":
          await api("/health")
          connectionTests++
          return { ok: true }
        case "server_mode_local":
          mode = "local"
          localReturns++
          return { mode, url: null }
        case "notification_permission":
          return "granted"
        default:
          return null
      }
    })
    await page.addInitScript(() => {
      const callbacks = new Map<number, (value: unknown) => void>()
      let id = 0
      const native = window as unknown as Record<string, unknown>
      native.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
        transformCallback: (callback: (value: unknown) => void) => {
          callbacks.set(++id, callback)
          return id
        },
        unregisterCallback: (value: number) => callbacks.delete(value),
        invoke: (command: string, args: Record<string, unknown> = {}) => {
          if (command.startsWith("plugin:event|")) return Promise.resolve(args.handler ?? null)
          return (native.__serverModeInvoke as (command: string, args: Record<string, unknown>) => Promise<unknown>)(
            command,
            args,
          )
        },
      }
      native.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
        unregisterListener: (_event: string, value: number) => callbacks.delete(value),
      }
      localStorage.setItem("touri.appearance.v1", "light")
    })
  }

  return {
    serverUrl,
    relayUrl,
    code,
    api,
    install,
    dispose,
    get commands() {
      return commands
    },
    get eventConnections() {
      return eventConnections
    },
    get snapshotReads() {
      return snapshotReads
    },
    get connectionTests() {
      return connectionTests
    },
    get localReturns() {
      return localReturns
    },
    pauseEvents() {
      eventStreamPaused = true
      for (const socket of eventSockets) socket.destroy()
    },
    resumeEvents() {
      eventStreamPaused = false
    },
  }
}
