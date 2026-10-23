import type { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createConnection, createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Kernel, Run, ToolRegistration } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { init, stop } from "../../src/mcp"
import { init as initNotify } from "../../src/notify"
import { init as initStore } from "../../src/store"
import { createFixtureStore } from "./store-fixture"

type RpcResponse = { jsonrpc: "2.0"; id: number; result?: unknown; error?: { code: number; message: string } }
type JsonObject = Record<string, unknown>

const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null

const rootPath = (): string => mkdtempSync(join(tmpdir(), "touri-wp4-"))

const seedDatabase = ({
  kernel,
  root,
  projectId = null,
  browserEnabled = 1,
  computerUse = 0,
  provider = "codex",
}: {
  kernel: Kernel
  root: string
  projectId?: string | null
  browserEnabled?: number
  computerUse?: number
  provider?: "codex" | "claude"
}): void => {
  const database = kernel.db as Database
  if (projectId) {
    database
      .query(
        `INSERT INTO projects (id, name, path, data_dir, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(projectId, "Fixture project", join(root, "project"), join(root, "project-data"), Date.now(), Date.now())
  }
  database
    .query(
      `INSERT INTO bots (id, name, provider, project_id, home_dir, browser_enabled, computer_use, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "bot-mark",
      "mark",
      provider,
      projectId,
      join(root, "bots", "bot-mark"),
      browserEnabled,
      computerUse,
      Date.now(),
      Date.now(),
    )
  database
    .query(
      `INSERT INTO threads (id, bot_id, kind, title, created_at, updated_at)
       VALUES (?, ?, 'chat', ?, ?, ?)`,
    )
    .run("thread-mark", "bot-mark", "Fixture thread", Date.now(), Date.now())
  database
    .query(
      `INSERT INTO messages (id, thread_id, role, kind, text, parts_json, created_at, updated_at)
       VALUES (?, ?, 'user', 'text', ?, ?, ?, ?)`,
    )
    .run(
      "fixture-message",
      "thread-mark",
      "Fixture search hit",
      JSON.stringify([{ type: "text", text: "Fixture search hit" }]),
      Date.now(),
      Date.now(),
    )
}

const writeToken = ({ root, threadId, token }: { root: string; threadId: string; token: string }): void => {
  const directory = join(root, "run", "mcp-tokens")
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  writeFileSync(join(directory, threadId), token, { mode: 0o600 })
}

const registerNoop = (kernel: Kernel, names: Array<string>): void => {
  const tools: Array<ToolRegistration> = names.map((name) => ({
    name,
    group: name.startsWith("browser_") ? "browser" : name.startsWith("computer_") ? "computer" : "process",
    handler: async () => ({ success: true, content: [{ type: "text", text: "ok" }] }),
  }))
  const result = kernel.registerTools({ tools })
  expect(result.success).toBe(true)
}

const connectClient = async ({
  root,
  threadId,
  token,
}: {
  root: string
  threadId: string
  token: string
}): Promise<{ socket: Socket; request: (method: string, params?: unknown) => Promise<RpcResponse> }> => {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const candidate = createConnection(join(root, "run", "mcp.sock"))
    candidate.once("connect", () => resolve(candidate))
    candidate.once("error", reject)
  })
  socket.setEncoding("utf8")
  let buffer = ""
  let nextId = 1
  const pending = new Map<number, (response: RpcResponse) => void>()
  socket.on("data", (chunk: string) => {
    buffer += chunk
    let newline = buffer.indexOf("\n")
    while (newline >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      try {
        const message: unknown = JSON.parse(line)
        if (isObject(message) && typeof message.id === "number")
          pending.get(message.id)?.(message as unknown as RpcResponse)
      } catch {
        return
      }
      newline = buffer.indexOf("\n")
    }
  })
  socket.write(`${JSON.stringify({ touriAuth: { thread: threadId, token } })}\n`)
  const request = (method: string, params?: unknown): Promise<RpcResponse> => {
    const id = nextId++
    return new Promise((resolve) => {
      pending.set(id, resolve)
      const message: JsonObject = { jsonrpc: "2.0", id, method }
      if (params !== undefined) message.params = params
      socket.write(`${JSON.stringify(message)}\n`)
    })
  }
  return { socket, request }
}

const closeClient = async (socket: Socket): Promise<void> => {
  await new Promise<void>((resolve) => {
    socket.once("close", () => resolve())
    socket.end()
    socket.destroy()
  })
}

const initialize = async (request: (method: string, params?: unknown) => Promise<RpcResponse>): Promise<void> => {
  const result = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "fixture", version: "1" },
  })
  expect(result.error).toBeUndefined()
}

const waitForClose = async (socket: Socket): Promise<void> => {
  if (socket.destroyed) return
  await new Promise<void>((resolve) => {
    socket.once("close", () => resolve())
    setTimeout(resolve, 500)
  })
}

const createFakeHost = async (path: string, onNotify: (params: unknown) => void): Promise<Server> => {
  const server = createServer((socket) => {
    let buffer = ""
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf("\n")
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        try {
          const message: unknown = JSON.parse(line)
          if (isObject(message) && typeof message.id === "number") {
            socket.write(
              `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: message.method === "auth" ? { ok: true } : {} })}\n`,
              () => {
                if (message.method === "notify") onNotify(message.params)
              },
            )
          }
        } catch {
          socket.destroy()
          return
        }
        newline = buffer.indexOf("\n")
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(path, resolve))
  return server
}

test("auth maps the session to a context and filters tools by bot capabilities", async () => {
  const root = rootPath()
  const runtime = createKernel({ appData: root })
  const token = "a".repeat(64)
  writeToken({ root, threadId: "thread-mark", token })
  seedDatabase({ kernel: runtime.kernel, root, browserEnabled: 0, computerUse: 0 })
  runtime.kernel.services.provide("store.api", createFixtureStore({ root }))
  try {
    await init(runtime.kernel)
    registerNoop(runtime.kernel, ["browser_open", "process_start", "computer_screenshot", "preview_open"])
    const client = await connectClient({ root, threadId: "thread-mark", token })
    try {
      await initialize(client.request)
      const listed = await client.request("tools/list", {})
      const tools = (listed.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)
      expect(tools).toContain("history_search")
      expect(tools).toContain("history_read")
      expect(tools).toContain("notify_user")
      // Unlinked callers can obtain an actionable Preview setup error.
      expect(tools).toContain("preview_open")
      const preview = await client.request("tools/call", { name: "preview_open", arguments: {} })
      expect(preview.error).toBeUndefined()
      expect(JSON.stringify(preview.result)).toContain("ok")
      expect(tools.some((name) => name.startsWith("browser_"))).toBe(false)
      expect(tools.some((name) => name.startsWith("process_"))).toBe(false)
      expect(tools.some((name) => name.startsWith("computer_"))).toBe(false)
      const search = await client.request("tools/call", { name: "history_search", arguments: { query: "campaign" } })
      expect(JSON.stringify(search.result)).toContain("Review the campaign")
      const history = await client.request("tools/call", {
        name: "history_read",
        arguments: { threadId: "thread-mark" },
      })
      expect(JSON.stringify(history.result)).toContain("Fixture search hit")
    } finally {
      await closeClient(client.socket)
    }
  } finally {
    await stop({ kernel: runtime.kernel })
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test("wrong, absent, and cross-thread credentials close the MCP connection", async () => {
  const root = rootPath()
  const runtime = createKernel({ appData: root })
  const token = "b".repeat(64)
  writeToken({ root, threadId: "thread-mark", token })
  seedDatabase({ kernel: runtime.kernel, root })
  const database = runtime.kernel.db as Database
  database
    .query(
      `INSERT INTO threads (id, bot_id, kind, title, created_at, updated_at)
       VALUES ('thread-other', 'bot-mark', 'chat', 'Other', ?, ?)`,
    )
    .run(Date.now(), Date.now())
  writeToken({ root, threadId: "thread-other", token: "other-token" })
  try {
    await init(runtime.kernel)
    for (const auth of [
      { thread: "thread-mark", value: "wrong" },
      { thread: "thread-other", value: token },
    ]) {
      const socket = await new Promise<Socket>((resolve, reject) => {
        const candidate = createConnection(join(root, "run", "mcp.sock"))
        candidate.once("connect", () => resolve(candidate))
        candidate.once("error", reject)
      })
      socket.write(`${JSON.stringify({ touriAuth: { thread: auth.thread, token: auth.value } })}\n`)
      await waitForClose(socket)
      expect(socket.destroyed).toBe(true)
    }
    const absent = await new Promise<Socket>((resolve, reject) => {
      const candidate = createConnection(join(root, "run", "mcp.sock"))
      candidate.once("connect", () => resolve(candidate))
      candidate.once("error", reject)
    })
    absent.write(`${JSON.stringify({ notAuth: true })}\n`)
    await waitForClose(absent)
    expect(absent.destroyed).toBe(true)
  } finally {
    await stop({ kernel: runtime.kernel })
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test("experimental, provider, project, browser, and computer filters follow the catalog metadata", async () => {
  const root = rootPath()
  const runtime = createKernel({ appData: root })
  const token = "f".repeat(64)
  writeToken({ root, threadId: "thread-mark", token })
  seedDatabase({
    kernel: runtime.kernel,
    root,
    projectId: "project-fixture",
    browserEnabled: 1,
    computerUse: 1,
    provider: "claude",
  })
  const database = runtime.kernel.db as Database
  database
    .query("INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)")
    .run("experimentalTools", "true", Date.now())
  try {
    await init(runtime.kernel)
    registerNoop(runtime.kernel, [
      "browser_hover",
      "computer_frontmost",
      "process_start",
      "secret_list",
      "preview_open",
      "approval_prompt",
    ])
    const client = await connectClient({ root, threadId: "thread-mark", token })
    try {
      await initialize(client.request)
      const listed = await client.request("tools/list", {})
      const tools = (listed.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)
      expect(tools).toContain("browser_hover")
      expect(tools.includes("computer_frontmost")).toBe(
        process.platform === "darwin" && process.env.TOURI_HEADLESS !== "1",
      )
      expect(tools).toContain("process_start")
      expect(tools).toContain("secret_list")
      expect(tools).toContain("preview_open")
      expect(tools).toContain("approval_prompt")
    } finally {
      await closeClient(client.socket)
    }
  } finally {
    await stop({ kernel: runtime.kernel })
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test("tools validate arguments, enforce ownership, and redact audit arguments", async () => {
  const root = rootPath()
  const runtime = createKernel({ appData: root })
  const token = "c".repeat(64)
  writeToken({ root, threadId: "thread-mark", token })
  seedDatabase({ kernel: runtime.kernel, root })
  runtime.kernel.services.provide("store.api", createFixtureStore({ root }))
  runtime.kernel.addRedactionValue("fixture-secret")
  const database = runtime.kernel.db as Database
  database
    .query(
      `INSERT INTO runs (id, thread_id, bot_id, provider, trigger, status, queued_at)
       VALUES (?, ?, ?, ?, 'user', 'running', ?)`,
    )
    .run("run-fixture", "thread-mark", "bot-mark", "codex", Date.now())
  runtime.kernel.services.provide(
    "runtime.activeRun",
    (): Run => ({
      id: "run-fixture",
      threadId: "thread-mark",
      botId: "bot-mark",
      provider: "codex",
      trigger: "user",
      requestMessageId: null,
      replyMessageId: null,
      externalTurnId: null,
      status: "running",
      errorClass: null,
      errorMessage: null,
      usage: null,
      routineRunId: null,
      queuedAt: Date.now(),
      startedAt: Date.now(),
      finishedAt: null,
    }),
  )
  try {
    await init(runtime.kernel)
    const client = await connectClient({ root, threadId: "thread-mark", token })
    try {
      await initialize(client.request)
      const invalid = await client.request("tools/call", { name: "history_search", arguments: { query: "x" } })
      const invalidResult = invalid.result as { isError: boolean; content: Array<{ text: string }> }
      expect(invalidResult.isError).toBe(true)
      expect(invalidResult.content[0]?.text).toContain("INVALID_ARGS")
      expect(invalidResult.content[0]?.text).toContain("schema path:")

      await client.request("tools/call", { name: "history_search", arguments: { query: "fixture-secret" } })
      const audit = database
        .query("SELECT run_id, args_json, ok, error_code FROM tool_calls ORDER BY created_at ASC")
        .all() as Array<{ run_id: string | null; args_json: string; ok: number; error_code: string | null }>
      expect(audit).toHaveLength(2)
      expect(audit[0]?.run_id).toBe("run-fixture")
      expect(audit[0]?.error_code).toBe("INVALID_ARGS")
      expect(audit.map((row) => row.args_json).join(" ")).not.toContain("fixture-secret")
    } finally {
      await closeClient(client.socket)
    }
  } finally {
    await stop({ kernel: runtime.kernel })
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test("notify_user saves notifications and rate-limits per bot", async () => {
  const root = rootPath()
  const hostPath = join(root, "run", "host.sock")
  mkdirSync(join(root, "run"), { recursive: true })
  const delivered = Promise.withResolvers<unknown>()
  const host = await createFakeHost(hostPath, delivered.resolve)
  const previousSocket = process.env.TOURI_HOST_SOCK
  const previousToken = process.env.TOURI_HOST_TOKEN
  process.env.TOURI_HOST_SOCK = hostPath
  process.env.TOURI_HOST_TOKEN = "host-fixture-token"
  const runtime = createKernel({ appData: root })
  const token = "d".repeat(64)
  writeToken({ root, threadId: "thread-mark", token })
  seedDatabase({ kernel: runtime.kernel, root })
  ;(runtime.kernel.db as Database)
    .query("UPDATE bots SET access = 'full', approvals = 'never' WHERE id = 'bot-mark'")
    .run()
  await initStore(runtime.kernel)
  await initNotify(runtime.kernel)
  try {
    await init(runtime.kernel)
    const client = await connectClient({ root, threadId: "thread-mark", token })
    try {
      await initialize(client.request)
      const first = await client.request("tools/call", {
        name: "notify_user",
        arguments: { title: "Fixture", body: "Done" },
      })
      const second = await client.request("tools/call", {
        name: "notify_user",
        arguments: { title: "Fixture", body: "Again" },
      })
      const notification = await delivered.promise

      expect(notification).toMatchObject({ kind: "notice", title: "mark: Fixture", body: "Done" })
      expect((first.result as { isError: boolean }).isError).toBe(false)
      expect((second.result as { content: Array<{ text: string }> }).content[0]?.text).toContain("RATE_LIMITED")
    } finally {
      await closeClient(client.socket)
    }
  } finally {
    await stop({ kernel: runtime.kernel })
    runtime.stop()
    await new Promise<void>((resolve) => host.close(() => resolve()))
    if (previousSocket === undefined) delete process.env.TOURI_HOST_SOCK
    else process.env.TOURI_HOST_SOCK = previousSocket
    if (previousToken === undefined) delete process.env.TOURI_HOST_TOKEN
    else process.env.TOURI_HOST_TOKEN = previousToken
    rmSync(root, { recursive: true, force: true })
  }
})
