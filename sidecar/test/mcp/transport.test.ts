import type { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createKernel } from "../../src/kernel"
import { createAppPaths } from "../../src/kernel/paths"
import { createMcpSocket } from "../../src/mcp/socket"
import { connectionOptions, mcpEndpoint, mcpEndpointFile, resolveMcpEndpoint } from "../../src/platform/transport"
import { init as initStore } from "../../src/store"

test("Windows MCP loopback discovery keeps per-thread auth and typed response IDs", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-mcp-transport-"))
  const runtime = createKernel({ appData: root })
  const transport = createMcpSocket({ kernel: runtime.kernel, registrations: new Map(), transport: "tcp" })
  const clients: ReturnType<typeof createConnection>[] = []
  try {
    await initStore(runtime.kernel)
    const db = runtime.kernel.db as Database
    db.query(
      "INSERT INTO bots(id,name,provider,access,approvals,home_dir,created_at,updated_at) VALUES ('bot','fixture','codex','full','never',?,1,1)",
    ).run(root)
    db.exec("INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('thread','bot','fixture',1,1)")
    await transport.listen()
    writeFileSync(join(root, "run", "mcp-tokens", "thread"), "fixture-token")
    const endpoint = mcpEndpoint(runtime.kernel.paths.runDir, "win32")
    expect(endpoint).toBe(transport.socketPath)
    expect(connectionOptions(endpoint)).toMatchObject({ host: "127.0.0.1" })
    const denied = createConnection(connectionOptions(endpoint))
    clients.push(denied)
    denied.on("error", () => {})
    const closed = new Promise<void>((resolve) => denied.once("close", () => resolve()))
    denied.write(`${JSON.stringify({ touriAuth: { thread: "thread", token: "wrong" } })}\n`)
    await closed
    const client = createConnection(connectionOptions(endpoint))
    clients.push(client)
    const frames: Array<{ id: number | string; result?: unknown }> = []
    let buffer = ""
    client.setEncoding("utf8")
    client.on("data", (chunk) => {
      buffer += chunk
      while (buffer.includes("\n")) {
        const at = buffer.indexOf("\n")
        frames.push(JSON.parse(buffer.slice(0, at)))
        buffer = buffer.slice(at + 1)
      }
    })
    // A fragmented auth frame followed by two requests in one write.
    client.write('{"touriAuth":')
    client.write(
      `${JSON.stringify({ thread: "thread", token: "fixture-token" })}}\n${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n${JSON.stringify({ jsonrpc: "2.0", id: "1", method: "initialize", params: {} })}\n`,
    )
    const deadline = Date.now() + 5000
    while (frames.length < 2 && Date.now() < deadline) await Bun.sleep(10)
    expect(frames.map((frame) => frame.id)).toEqual([1, "1"])
    expect(frames[0]?.result).toEqual({})
    expect(frames[1]?.result).toMatchObject({ serverInfo: { name: "touri" } })
    const revoked = new Promise<void>((resolve) => client.once("close", () => resolve()))
    writeFileSync(join(root, "run", "mcp-tokens", "thread"), "replacement-token")
    client.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" })}\n`)
    await revoked
  } finally {
    for (const client of clients) client.destroy()
    await transport.close()
    expect(existsSync(mcpEndpointFile(runtime.kernel.paths.runDir))).toBe(false)
    await runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(process.platform === "win32")(
  "Unix discovery connects to the private socket with a long data path",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "touri-mcp-long-"))
    const paths = createAppPaths({ appData: join(root, "data-".repeat(30)) })
    const runtime = createKernel({ appData: paths.appData })
    const transport = createMcpSocket({ kernel: runtime.kernel, registrations: new Map() })
    let client: ReturnType<typeof createConnection> | undefined
    try {
      await transport.listen()
      const endpoint = resolveMcpEndpoint(paths)
      expect(endpoint).toBe(transport.socketPath)
      expect(mcpEndpoint(paths.runDir)).toBe(endpoint)
      expect(endpoint).not.toBe(join(paths.runDir, "mcp.sock"))
      expect(statSync(endpoint).mode & 0o777).toBe(0o600)
      client = createConnection(connectionOptions(endpoint))
      await new Promise<void>((resolve, reject) => {
        client?.once("connect", resolve)
        client?.once("error", reject)
      })
      expect(client.readyState).toBe("open")
    } finally {
      client?.destroy()
      await transport.close()
      await runtime.stop()
      rmSync(root, { recursive: true, force: true })
      rmSync(dirname(transport.socketPath), { recursive: true, force: true })
    }
  },
)
