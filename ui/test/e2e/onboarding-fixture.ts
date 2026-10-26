import { execFile, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer, request as httpRequest, type Server } from "node:http"
import type { Socket } from "node:net"
import { tmpdir } from "node:os"
import { extname, join, resolve, sep } from "node:path"
import { promisify } from "node:util"
import type { Page } from "@playwright/test"

const root = resolve(import.meta.dirname, "../../..")
const ui = join(root, "ui/dist")
const listen = async (server: Server): Promise<number> => {
  for (const port of Array.from({ length: 100 }, (_, index) => 18800 + index)) {
    const accepted = await new Promise<boolean>((done) => {
      const fail = () => done(false)
      server.once("error", fail)
      server.listen(port, "127.0.0.1", () => {
        server.off("error", fail)
        done(true)
      })
    })
    if (accepted) return port
  }
  throw new Error("No free staging port")
}
const close = (server: Server) => new Promise<void>((done) => server.close(() => done()))

export const createOnboardingFixture = async ({ uiDirectory = ui }: { uiDirectory?: string } = {}) => {
  const reservation = createServer()
  const port = await listen(reservation)
  const remoteReservation = createServer()
  const remotePort = await listen(remoteReservation)
  await close(reservation)
  await close(remoteReservation)
  const base = `http://127.0.0.1:${port}`
  const remoteBase = `http://127.0.0.1:${remotePort}`
  const directory = await mkdtemp(join(tmpdir(), "touri-onboarding-e2e-"))
  const token = randomBytes(32).toString("hex")
  const remoteDirectory = join(directory, "remote")
  const remoteChild = spawn(
    "bun",
    [
      "sidecar/src/cli/main.ts",
      "serve",
      "--port",
      String(remotePort),
      "--data-dir",
      remoteDirectory,
      "--ui-dir",
      uiDirectory,
    ],
    {
      cwd: root,
      env: { ...process.env, TOURI_BROWSER_HEADLESS: "1", TOURI_DOCTOR_SKIP_PROVIDER_PROBES: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  let remoteReady = false
  remoteChild.stdout.on("data", (chunk) => {
    if (String(chunk).includes("pairing:")) remoteReady = true
  })
  remoteChild.stderr.resume()
  const child = spawn("bun", ["ui/test/e2e/onboarding-server.ts"], {
    cwd: root,
    env: {
      ...process.env,
      TOURI_APP_DATA: directory,
      TOURI_UI_TOKEN: token,
      TOURI_ONBOARDING_TEST_PORT: String(port),
      TOURI_ONBOARDING_LOCAL_URL: remoteBase,
      TOURI_BROWSER_HEADLESS: "1",
      TOURI_DOCTOR_SKIP_PROVIDER_PROBES: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let loaded = false
  child.stdout.on("data", (chunk) => {
    if (String(chunk).includes("ready\n")) loaded = true
  })
  child.stderr.resume()
  let mode: "local" | "server" = "local"
  const commands: string[] = []
  const sockets = new Set<Socket>()
  let remoteToken = ""
  let eventConnections = 0
  const getTarget = () => (mode === "server" ? { url: remoteBase, token: remoteToken } : { url: base, token })
  const api = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Touri-Client": "onboarding-test",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`Isolated request failed: ${response.status}`)
    return response.json()
  }
  const fixture = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname
    if (path.startsWith("/api/")) {
      const target = getTarget()
      const upstream = httpRequest(
        new URL(request.url ?? "/", target.url),
        {
          method: request.method,
          headers: {
            Authorization: `Bearer ${target.token}`,
            "X-Touri-Client": "onboarding-test",
            ...(request.headers["content-type"] ? { "Content-Type": request.headers["content-type"] } : {}),
          },
        },
        (received) => {
          response.writeHead(received.statusCode ?? 502, { "Content-Type": "application/json" })
          received.pipe(response)
        },
      )
      upstream.once("error", () => response.writeHead(503).end())
      request.pipe(upstream)
      return
    }
    const file = resolve(uiDirectory, `.${path === "/" ? "/index.html" : path}`)
    if (!file.startsWith(`${uiDirectory}${sep}`)) {
      response.writeHead(404).end()
      return
    }
    const types: Record<string, string> = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".png": "image/png",
      ".ico": "image/x-icon",
      ".woff2": "font/woff2",
    }
    try {
      response.writeHead(200, { "Content-Type": types[extname(file)] ?? "text/plain" })
      response.end(await readFile(file))
    } catch {
      response.writeHead(404).end()
    }
  })
  fixture.on("connection", (socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })
  fixture.on("upgrade", (request, socket, head) => {
    const target = getTarget()
    const upstream = httpRequest(new URL(request.url ?? "/", target.url), {
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": request.headers["sec-websocket-key"] ?? "",
        Authorization: `Bearer ${target.token}`,
        "X-Touri-Client": "onboarding-test",
      },
    })
    upstream.once("upgrade", (received, remote, upstreamHead) => {
      eventConnections += 1
      sockets.add(remote)
      remote.once("close", () => sockets.delete(remote))
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
  const dispose = async () => {
    for (const socket of sockets) socket.destroy()
    fixture.closeAllConnections()
    await close(fixture)
    for (const running of [child, remoteChild]) {
      if (running.exitCode !== null || running.signalCode !== null) continue
      await new Promise<void>((done) => {
        const timer = setTimeout(() => running.kill("SIGKILL"), 10_000)
        running.once("exit", () => {
          clearTimeout(timer)
          done()
        })
        running.kill("SIGTERM")
      })
    }
    await rm(directory, { recursive: true, force: true })
  }
  const ready = async () => {
    const deadline = performance.now() + 90_000
    while (performance.now() < deadline) {
      if (child.exitCode !== null || remoteChild.exitCode !== null) throw new Error("Isolated runtime exited")
      const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(300) }).catch(() => null)
      if (response?.ok && loaded && remoteReady) return
      await new Promise((done) => setTimeout(done, 100))
    }
    throw new Error("Isolated runtime did not start")
  }
  try {
    await ready()
  } catch (error) {
    await dispose()
    throw error
  }
  const relayPort = await listen(fixture)
  const url = `http://127.0.0.1:${relayPort}`
  const install = async (page: Page) => {
    await page.exposeBinding("__onboardingInvoke", async (_source, command: string, args: Record<string, unknown>) => {
      commands.push(command)
      if (command === "server_mode_status") return { mode, url: mode === "server" ? remoteBase : null }
      if (command === "sidecar_endpoint")
        return { baseUrl: url, wsUrl: `${url.replace("http:", "ws:")}/api/v1/events`, token }
      if (command === "server_mode_pair") {
        if (args.url !== remoteBase) throw new Error("SERVER_CONNECTION_FAILED")
        const response = await fetch(`${remoteBase}/pair`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: args.code, client: true, name: "Test app" }),
          signal: AbortSignal.timeout(5000),
        })
        if (!response.ok) throw new Error("SERVER_CODE_INVALID")
        const paired = (await response.json()) as { token?: string }
        if (!paired.token) throw new Error("SERVER_PAIR")
        remoteToken = paired.token
        mode = "server"
        return { mode, url: remoteBase }
      }
      return null
    })
    await page.addInitScript(() => {
      const native = window as typeof window & {
        __onboardingInvoke: (command: string, args: Record<string, unknown>) => Promise<unknown>
        __TAURI_INTERNALS__: unknown
        __TAURI_EVENT_PLUGIN_INTERNALS__: unknown
      }
      native.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
        transformCallback: () => 1,
        unregisterCallback: () => undefined,
        invoke: (command: string, args: Record<string, unknown> = {}) =>
          command.startsWith("plugin:event|")
            ? Promise.resolve(args.handler ?? null)
            : native.__onboardingInvoke(command, args),
      }
      native.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined }
      localStorage.setItem("touri.appearance.v1", "light")
      const observer = new MutationObserver(() => {
        if (!document.querySelector(".setup-welcome h1")) return
        performance.mark("onboarding-welcome")
        observer.disconnect()
      })
      observer.observe(document, { childList: true, subtree: true })
    })
  }
  const getCode = async () => {
    const result = await promisify(execFile)(
      "bun",
      ["sidecar/src/cli/main.ts", "pair", "--data-dir", remoteDirectory],
      { cwd: root, encoding: "utf8", timeout: 15_000 },
    )
    const code = /Pairing code: ([A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4})/.exec(result.stdout)?.[1]
    if (!code) throw new Error("The isolated server did not create a pairing code")
    return code
  }
  const pairDesktop = async () => {
    const pairing = await api("/onboarding/pair-code", "POST", {})
    const response = await fetch(`${base}/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: pairing.code, client: true, name: "Synthetic phone" }),
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) throw new Error("Synthetic phone pairing failed")
    const device = (await response.json()) as { token: string }

    return (path: string, method = "GET", body?: unknown) =>
      fetch(`${base}/api/v1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${device.token}`,
          "Content-Type": "application/json",
          "X-Touri-Client": "onboarding-test",
          "X-Forwarded-Host": "local.example.ts.net:8445",
          "X-Forwarded-Proto": "https",
          Origin: "https://local.example.ts.net:8445",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      })
  }
  return {
    url,
    base: remoteBase,
    directory,
    api,
    install,
    dispose,
    commands,
    getCode,
    pairDesktop,
    get eventConnections() {
      return eventConnections
    },
  }
}
