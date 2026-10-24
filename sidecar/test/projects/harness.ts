import type { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HostMethods, HostNotification, Kernel, ToolContext, ToolHandler, ToolResult } from "@touri/contracts"
import { createKernel, type KernelRuntime } from "../../src/kernel"
import { init } from "../../src/projects"
import { init as initStore } from "../../src/store"
import { createFakeHost, type FakeHostMethods } from "../fakes/fakeHost"

type Registration = { name: string; handler: ToolHandler }

type Harness = {
  root: string
  projectPath: string
  runtime: KernelRuntime
  host: ReturnType<typeof createFakeHost>
  notifyHost: (notification: Extract<HostNotification, { method: "app.willQuit" }>) => void
  tool: (name: string, args: unknown, projectId: string | null) => Promise<ToolResult>
  request: (path: string, init?: RequestInit) => Promise<Response>
  close: () => Promise<void>
}

let harnessQueue: Promise<void> = Promise.resolve()

const acquireHarness = async (): Promise<() => void> => {
  const previous = harnessQueue
  let release: () => void = () => undefined
  harnessQueue = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous
  return release
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null

const dispatchFake = async ({
  fake,
  method,
  params,
}: {
  fake: ReturnType<typeof createFakeHost>
  method: string
  params: unknown
}): Promise<unknown> => {
  if (method === "auth") return fake.methods.auth({ token: "test" })
  if (method === "keychain.get") return fake.methods["keychain.get"](params as HostMethods["keychain.get"]["params"])
  if (method === "keychain.set") return fake.methods["keychain.set"](params as HostMethods["keychain.set"]["params"])
  if (method === "keychain.delete")
    return fake.methods["keychain.delete"](params as HostMethods["keychain.delete"]["params"])
  if (method === "secret.prompt") return fake.methods["secret.prompt"](params as HostMethods["secret.prompt"]["params"])
  if (method === "notify") return fake.methods.notify(params as HostMethods["notify"]["params"])
  return {}
}

const startHost = async ({
  socketPath,
  fake,
}: {
  socketPath: string
  fake: ReturnType<typeof createFakeHost>
}): Promise<{
  server: ReturnType<typeof createServer>
  notifyHost: (notification: Extract<HostNotification, { method: "app.willQuit" }>) => void
}> => {
  const clients = new Set<Socket>()
  const server = createServer((socket) => {
    clients.add(socket)
    let buffer = ""
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8")
      let newline = buffer.indexOf("\n")
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf("\n")
        const parsed = asRecord(JSON.parse(line))
        if (!parsed || typeof parsed.id !== "number" || typeof parsed.method !== "string") continue
        void dispatchFake({ fake, method: parsed.method, params: parsed.params }).then((result) => {
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result })}\n`)
        })
      }
    })
    socket.on("close", () => clients.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  return {
    server,
    notifyHost: (notification) => {
      for (const client of clients) client.write(`${JSON.stringify(notification)}\n`)
    },
  }
}

const git = (cwd: string, args: Array<string>): void => {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
}

export const createHarness = async (): Promise<Harness> => {
  const release = await acquireHarness()
  const root = mkdtempSync(join(tmpdir(), "touri-wp5-"))
  const projectPath = join(root, "project")
  const hostPath = join(root, "host.sock")
  const appData = join(root, "app")
  writeFileSync(join(root, "placeholder"), "")
  mkdirSync(projectPath, { recursive: true })
  writeFileSync(join(projectPath, ".gitignore"), ".env\n.env.*\nignored/\n")
  writeFileSync(join(projectPath, ".env.example"), "MONGO_URL=mongodb://localhost\nREDIS_URL=redis://localhost\n")
  writeFileSync(
    join(projectPath, "package.json"),
    JSON.stringify({ engines: { node: ">=22.12" }, packageManager: "pnpm@10" }),
  )
  git(projectPath, ["init", "-q"])
  git(projectPath, ["config", "user.email", "test@example.com"])
  git(projectPath, ["config", "user.name", "Test"])
  git(projectPath, ["add", "."])
  git(projectPath, ["commit", "-qm", "fixture"])

  const fake = createFakeHost()
  const hostServer = await startHost({ socketPath: hostPath, fake })
  const previousSocket = process.env.TOURI_HOST_SOCK
  const previousToken = process.env.TOURI_HOST_TOKEN
  process.env.TOURI_HOST_SOCK = hostPath
  process.env.TOURI_HOST_TOKEN = "test"
  const runtime = createKernel({ appData })
  await initStore(runtime.kernel)
  const db = runtime.kernel.db as Database
  db.query(
    "INSERT INTO bots(id,name,provider,machine,access,approvals,home_dir,created_at,updated_at) VALUES ('bot-test','test','codex','local','full','never',?,1,1)",
  ).run(projectPath)
  db.query(
    "INSERT INTO threads(id,bot_id,kind,title,created_at,updated_at) VALUES ('thread-test','bot-test','chat','fixture',1,1)",
  ).run()
  db.query("UPDATE bots SET main_thread_id = 'thread-test' WHERE id = 'bot-test'").run()
  // This harness represents the human accepting credential release. Policy and
  // pending/denied approval paths use the real bridge in the security suite.
  runtime.kernel.services.provide("approvals.present", async () => ({ success: true, behavior: "allow" }))
  const registrations = new Map<string, Registration>()
  const kernel: Kernel = {
    ...runtime.kernel,
    registerTools: ({ tools }) => {
      for (const registration of tools) registrations.set(registration.name, registration)
      return { success: true, count: tools.length }
    },
  }
  await init(kernel)
  await runtime.kernel.callHost("notify", { title: "test", body: "test", threadId: null })
  const request = (path: string, init?: RequestInit): Promise<Response> =>
    fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1${path}`, {
      ...init,
      headers: {
        Authorization: "Bearer dev-ui-token",
        Origin: "tauri://localhost",
        ...(init?.headers ?? {}),
      },
    })
  const tool = async (name: string, args: unknown, projectId: string | null): Promise<ToolResult> => {
    db.query("UPDATE bots SET project_id = ? WHERE id = 'bot-test'").run(projectId)
    const registration = registrations.get(name)
    if (!registration) throw new Error(`Tool not registered: ${name}`)
    const controller = new AbortController()
    const ctx: ToolContext = {
      botId: "bot-test",
      threadId: "thread-test",
      runId: null,
      projectId,
      cwd: projectPath,
      signal: controller.signal,
    }
    return registration.handler({ ctx, args })
  }
  const close = async (): Promise<void> => {
    hostServer.notifyHost({ method: "app.willQuit", params: {} })
    await Bun.sleep(500)
    await runtime.stop()
    hostServer.server.close()
    if (previousSocket === undefined) delete process.env.TOURI_HOST_SOCK
    else process.env.TOURI_HOST_SOCK = previousSocket
    if (previousToken === undefined) delete process.env.TOURI_HOST_TOKEN
    else process.env.TOURI_HOST_TOKEN = previousToken
    rmSync(root, { recursive: true, force: true })
    release()
  }
  return { root, projectPath, runtime, host: fake, notifyHost: hostServer.notifyHost, tool, request, close }
}

export const createServerFixture = ({ projectPath }: { projectPath: string }): string => {
  const path = join(projectPath, "server.ts")
  const placeholder = `${String.fromCharCode(36)}{server.port}`
  const source = [
    "const server = Bun.serve({ port: 0, fetch: () => new Response('ok') }); console.log(`READY http://127.0.0.1:",
    placeholder,
    "`); setInterval(() => {}, 1000)\n",
  ].join("")
  writeFileSync(path, source)
  return path
}

export const createCrasherFixture = ({ projectPath }: { projectPath: string }): string => {
  const path = join(projectPath, "crasher.ts")
  writeFileSync(path, "process.exit(1)\n")
  return path
}

export type { FakeHostMethods }
