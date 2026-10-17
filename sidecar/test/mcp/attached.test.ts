import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, McpServer, Thread } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { init as initMcp, stop as stopMcp } from "../../src/mcp"
import { attachedServers, discoverMcpTools, resolveAttachedMcp, validateMcpServer } from "../../src/mcp/attached"
import { composeDeveloperInstructions } from "../../src/runtime/instructions"
import { init as initStore } from "../../src/store"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})
const fixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-r3-mcp-"))
  const runtime = createKernel({ appData: root })
  await initStore(runtime.kernel)
  await initMcp(runtime.kernel)
  cleanup.push(async () => {
    await stopMcp({ kernel: runtime.kernel })
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  const request = (path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: "Bearer dev-ui-token", "x-touri-client": "r3", "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  const bot = ((await (await request("/bots", { name: "mail", provider: "claude" })).json()) as { bot: Bot }).bot
  return { root, runtime, request, bot }
}

test("P2 stdio MCP saves verified tools for one bot, persists, and overrides imaginary SOUL capabilities", async () => {
  const f = await fixture()
  const script = join(f.root, "gmail.mjs")
  writeFileSync(
    script,
    `import readline from 'node:readline'; readline.createInterface({input:process.stdin}).on('line', line => { const q=JSON.parse(line); if(q.id===undefined)return; const result=q.method==='initialize'?{protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:q.method==='tools/list'?{tools:[{name:'search_threads',description:'Search test mail',inputSchema:{type:'object'}}]}:{}; process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n'); });`,
  )
  const config: McpServer = {
    name: "gmail",
    transport: "stdio",
    command: process.execPath,
    args: [script],
    tools: [{ name: "imaginary", description: "" }],
  }
  const saved = await fetch(`http://127.0.0.1:${f.runtime.handshake.port}/api/v1/bots/${f.bot.id}/mcp/gmail`, {
    method: "PUT",
    headers: { Authorization: "Bearer dev-ui-token", "x-touri-client": "r3", "Content-Type": "application/json" },
    body: JSON.stringify(config),
  })
  expect(saved.status).toBe(200)
  expect(attachedServers(f.runtime.kernel, f.bot.id)[0]?.tools.map((tool) => tool.name)).toEqual(["search_threads"])
  const other = ((await (await f.request("/bots", { name: "other", provider: "codex" })).json()) as { bot: Bot }).bot
  expect(attachedServers(f.runtime.kernel, other.id)).toEqual([])
  const attached = await resolveAttachedMcp(f.runtime.kernel, f.bot)
  const thread = f.runtime.kernel.services.use("store.api")?.getThread({ threadId: f.bot.mainThreadId ?? "" }) as Thread
  const instructions = await composeDeveloperInstructions({
    kernel: f.runtime.kernel,
    bot: { ...f.bot, instructions: "I have Gmail get_thread/get_message/list_labels", mcpServers: attached },
    thread,
    cwd: f.bot.homeDir,
  })
  expect(instructions).toContain("External MCP servers and verified tools: gmail: search_threads.")
  expect(instructions).toContain("Never promise unconnected tools")
  const none = await composeDeveloperInstructions({ kernel: f.runtime.kernel, bot: other, thread, cwd: other.homeDir })
  expect(none).toContain("External MCP servers and verified tools: (none connected)")
  expect(none).toContain("Touri tools attached to this bot: history_search, history_read, notify_user")
})

test("P2 HTTP MCP discovers actual tools and disconnected servers are omitted from turn capabilities", async () => {
  const f = await fixture()
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 })
      const q = (await request.json()) as { method: string; id?: number; params?: { protocolVersion?: string } }
      if (q.id === undefined) return new Response(null, { status: 202 })
      return Response.json({
        jsonrpc: "2.0",
        id: q.id,
        result:
          q.method === "initialize"
            ? {
                protocolVersion: q.params?.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: "http-test", version: "1" },
              }
            : { tools: [{ name: "get_thread", inputSchema: { type: "object" } }] },
      })
    },
  })
  cleanup.push(async () => {
    server.stop(true)
  })
  const config: McpServer = {
    name: "mail-http",
    transport: "http",
    url: `http://127.0.0.1:${server.port}/mcp`,
    tools: [],
  }
  expect((await discoverMcpTools(f.runtime.kernel, f.bot, config)).tools.map((tool) => tool.name)).toEqual([
    "get_thread",
  ])
  ;(f.runtime.kernel.db as import("bun:sqlite").Database)
    .query("INSERT INTO bot_mcp_servers(bot_id,name,config_json) VALUES(?,?,?)")
    .run(f.bot.id, config.name, JSON.stringify(config))
  server.stop(true)
  expect(await resolveAttachedMcp(f.runtime.kernel, f.bot)).toEqual([])
})

test("MCP config rejects reserved names, embedded credentials and invalid transports", () => {
  expect(() => validateMcpServer({ name: "touri", transport: "stdio", command: "node", args: [] })).toThrow()
  expect(() =>
    validateMcpServer({ name: "mail", transport: "http", url: "https://user:password@example.com/mcp" }),
  ).toThrow()
  expect(() => validateMcpServer({ name: "mail", transport: "stdio", command: "node", args: "--bad" })).toThrow()
})

test("F025: missing local executables have a stable actionable error after HTTP normalization, including retries", async () => {
  const f = await fixture()
  for (let i = 0; i < 2; i++) {
    const response = await fetch(
      `http://127.0.0.1:${f.runtime.handshake.port}/api/v1/bots/${f.bot.id}/mcp/qa-command`,
      {
        method: "PUT",
        headers: { Authorization: "Bearer dev-ui-token", "x-touri-client": "r3", "Content-Type": "application/json" },
        body: JSON.stringify({ transport: "stdio", command: "touri-qa-command-does-not-exist", args: [] }),
      },
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      code: "TOURI-E1012",
      errorCode: "MCP_EXECUTABLE_NOT_FOUND",
      error: expect.stringContaining("executável"),
    })
    expect(attachedServers(f.runtime.kernel, f.bot.id)).toEqual([])
  }
})

test("F025: unreachable HTTP MCP connections explain what to check", async () => {
  const f = await fixture()
  const server = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 503 }) })
  cleanup.push(async () => {
    server.stop(true)
  })
  const response = await fetch(`http://127.0.0.1:${f.runtime.handshake.port}/api/v1/bots/${f.bot.id}/mcp/unavailable`, {
    method: "PUT",
    headers: { Authorization: "Bearer dev-ui-token", "x-touri-client": "r3", "Content-Type": "application/json" },
    body: JSON.stringify({ transport: "http", url: `http://127.0.0.1:${server.port}/mcp` }),
  })
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    code: "TOURI-E1013",
    errorCode: "MCP_CONNECTION_FAILED",
    error: expect.stringContaining("comando, os argumentos ou a URL"),
  })
  expect(attachedServers(f.runtime.kernel, f.bot.id)).toEqual([])
})
