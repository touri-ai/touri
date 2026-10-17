import { Database } from "bun:sqlite"
import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Kernel, McpServer, VmRuntime } from "@touri/contracts"
import { createRouteRegistry } from "../../src/kernel/routes"
import { createServices } from "../../src/kernel/services"
import { attachedServers, registerAttachedMcpRoutes } from "../../src/mcp/attached"
import { mcpPrerequisites } from "../../src/mcp/prerequisites"
import { createFixtureStore } from "./store-fixture"

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0)) close()
})

const fixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-connect-tools-"))
  const db = new Database(":memory:")
  db.exec(
    "CREATE TABLE bot_mcp_servers (bot_id TEXT, name TEXT, config_json TEXT, PRIMARY KEY (bot_id, name)); CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT)",
  )
  const services = createServices()
  const store = createFixtureStore({ root })
  services.provide("store.api", store)
  const bot = store.getBot({ botId: "bot-mark" })
  if (!bot) throw new Error("Missing catalog bot")
  const routes = createRouteRegistry()
  const kernel = {
    db,
    services,
    registerRoutes: routes.registerRoutes,
    shellEnv: async () => ({ ...process.env, HOME: root }),
    redact: (value: string) => value,
    log: () => undefined,
  } as unknown as Kernel
  registerAttachedMcpRoutes(kernel)
  cleanup.push(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  const request = async (path: string, body?: unknown) => {
    const response = await routes.handle({
      method: body ? "POST" : "GET",
      pathname: path,
      query: new URLSearchParams(),
      body,
      signal: new AbortController().signal,
    })
    if (!("json" in response)) throw new Error("Expected JSON response")
    return { status: response.status, json: async () => response.json }
  }
  return { root, runtime: { kernel }, bot, request }
}

test("connection tests list every tool page without saving or changing an existing connection", async () => {
  const f = await fixture()
  const pages: Array<string | undefined> = []
  const httpFetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request("https://example.test/mcp", init)
    if (request.method !== "POST") return new Response(null, { status: 405 })
    const q = (await request.json()) as {
      id?: number
      method: string
      params?: { protocolVersion?: string; cursor?: string }
    }
    if (q.id === undefined) return new Response(null, { status: 202 })
    if (q.method === "tools/list") pages.push(q.params?.cursor)
    return Response.json({
      jsonrpc: "2.0",
      id: q.id,
      result:
        q.method === "initialize"
          ? {
              protocolVersion: q.params?.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
            }
          : q.params?.cursor
            ? { tools: [{ name: "write_file", inputSchema: { type: "object" } }] }
            : {
                tools: [{ name: "read_file", annotations: { readOnlyHint: true }, inputSchema: { type: "object" } }],
                nextCursor: "page-2",
              },
    })
  }
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(httpFetch as typeof fetch)
  cleanup.push(() => {
    fetchMock.mockRestore()
  })
  const server: McpServer = { name: "catalog", transport: "http", url: "https://example.test/mcp", tools: [] }
  const response = await f.request(`/bots/${f.bot.id}/mcp/test`, server)
  expect(response.status).toBe(200)
  const result = (await response.json()) as { server: McpServer }
  expect(result.server.tools.map((tool) => [tool.name, tool.policy])).toEqual([
    ["read_file", "always_allow"],
    ["write_file", "needs_approval"],
  ])
  expect(attachedServers(f.runtime.kernel, f.bot.id)).toEqual([])
  const previous: McpServer = {
    ...server,
    url: "https://example.test/previous",
    tools: [{ name: "previous", description: "", policy: "blocked" }],
  }
  ;(f.runtime.kernel.db as import("bun:sqlite").Database)
    .query("INSERT INTO bot_mcp_servers(bot_id,name,config_json) VALUES(?,?,?)")
    .run(f.bot.id, server.name, JSON.stringify(previous))
  expect((await f.request(`/bots/${f.bot.id}/mcp/test`, server)).status).toBe(200)
  expect(attachedServers(f.runtime.kernel, f.bot.id)[0]).toMatchObject(previous)
  expect(pages).toEqual([undefined, "page-2", undefined, "page-2"])
})

test("connection tests support HTTP and an empty tool listing without attaching", async () => {
  const f = await fixture()
  const httpFetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request("https://example.test/mcp", init)
    if (request.method !== "POST") return new Response(null, { status: 405 })
    const q = (await request.json()) as { id?: number; method: string; params?: { protocolVersion?: string } }
    if (q.id === undefined) return new Response(null, { status: 202 })
    return Response.json({
      jsonrpc: "2.0",
      id: q.id,
      result:
        q.method === "initialize"
          ? {
              protocolVersion: q.params?.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
            }
          : { tools: [] },
    })
  }
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(httpFetch as typeof fetch)
  cleanup.push(() => {
    fetchMock.mockRestore()
  })
  const response = await f.request(`/bots/${f.bot.id}/mcp/test`, {
    name: "empty",
    transport: "http",
    url: "https://example.test/mcp",
    tools: [],
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ server: { name: "empty", tools: [] } })
  expect(attachedServers(f.runtime.kernel, f.bot.id)).toEqual([])
})

test("connection tests return actionable failures and reject invalid or missing bots without saving", async () => {
  const f = await fixture()
  const server = {
    name: "missing",
    transport: "stdio",
    command: "touri-qa-command-does-not-exist",
    args: [],
    tools: [],
  }
  const response = await f.request(`/bots/${f.bot.id}/mcp/test`, server)
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ code: "TOURI-E1012", errorCode: "MCP_EXECUTABLE_NOT_FOUND" })
  expect((await f.request(`/bots/${f.bot.id}/mcp/test`, { ...server, args: "invalid" })).status).toBe(400)
  expect((await f.request("/bots/missing-bot/mcp/test", server)).status).toBe(404)
  expect((await f.request("/bots/missing-bot/mcp/prerequisites")).status).toBe(404)
  expect(attachedServers(f.runtime.kernel, f.bot.id)).toEqual([])
})

test("preparation detects only file presence without returning credentials or personal paths", async () => {
  const f = await fixture()
  const environment = await f.runtime.kernel.shellEnv()
  f.runtime.kernel.shellEnv = async () => ({ ...environment, HOME: f.root })
  const directory = join(f.root, ".gmail-mcp")
  mkdirSync(directory)
  const first = await f.request(`/bots/${f.bot.id}/mcp/prerequisites`)
  expect(await first.json()).toEqual({
    prerequisites: { machine: "local", status: "checked", node: true, oauthKeys: false, credentials: false },
  })
  writeFileSync(join(directory, "gcp-oauth.keys.json"), "fixture-key-contents")
  mkdirSync(join(directory, "credentials.json"))
  const partial = await f.request(`/bots/${f.bot.id}/mcp/prerequisites`)
  expect(await partial.json()).toMatchObject({ prerequisites: { oauthKeys: true, credentials: false } })
  rmSync(join(directory, "credentials.json"), { recursive: true })
  writeFileSync(join(directory, "credentials.json"), "fixture-credential-contents")
  const complete = await f.request(`/bots/${f.bot.id}/mcp/prerequisites`)
  expect(await complete.json()).toEqual({
    prerequisites: { machine: "local", status: "checked", node: true, oauthKeys: true, credentials: true },
  })
  expect(attachedServers(f.runtime.kernel, f.bot.id)).toEqual([])
})

test("preparation checks the guest machine and releases its lease without booting it", async () => {
  const f = await fixture()
  let released = 0
  let inspected = 0
  const vm = {
    acquire: async (input: Parameters<VmRuntime["acquire"]>[0]) => {
      expect(input).toMatchObject({ botId: f.bot.id, runningOnly: true })
      return async () => {
        released++
      }
    },
    exec: async (input: Parameters<VmRuntime["exec"]>[0]) => {
      inspected++
      expect(input.botId).toBe(f.bot.id)
      const child = Bun.spawn([input.command, ...(input.args ?? [])], {
        env: { ...process.env, HOME: f.root },
        stdout: "pipe",
        stderr: "pipe",
      })
      return {
        success: true as const,
        stdout: await new Response(child.stdout).text(),
        stderr: "",
        code: await child.exited,
      }
    },
  } as unknown as VmRuntime
  f.runtime.kernel.services.provide("vm.runtime", vm)
  expect(await mcpPrerequisites(f.runtime.kernel, { ...f.bot, machine: "vm" })).toEqual({
    machine: "vm",
    status: "checked",
    node: true,
    oauthKeys: false,
    credentials: false,
  })
  expect(released).toBe(1)
  vm.acquire = async () => {
    throw new Error("Stopped")
  }
  expect(await mcpPrerequisites(f.runtime.kernel, { ...f.bot, machine: "vm" })).toMatchObject({ status: "unavailable" })
  expect(await mcpPrerequisites(f.runtime.kernel, { ...f.bot, machine: "cloud" })).toMatchObject({
    status: "unavailable",
    machine: "cloud",
  })
  expect(inspected).toBe(1)
})

test("preparation reports missing Node.js and cloud connections never run host commands", async () => {
  const f = await fixture()
  f.runtime.kernel.shellEnv = async () => ({ PATH: "", HOME: f.root })
  expect(await mcpPrerequisites(f.runtime.kernel, f.bot)).toMatchObject({ status: "checked", node: false })
  f.bot.machine = "cloud"
  const response = await f.request(`/bots/${f.bot.id}/mcp/test`, {
    name: "cloud",
    transport: "stdio",
    command: "node",
    args: [],
    tools: [],
  })
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ code: "TOURI-E1001" })
  expect(attachedServers(f.runtime.kernel, f.bot.id)).toEqual([])
})
