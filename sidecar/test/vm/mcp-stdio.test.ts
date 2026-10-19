import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createConnection, createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createKernel } from "../../src/kernel"
import { authenticateMcp } from "../../src/mcp/auth"
import { createRunMcpToken } from "../../src/mcp/run-token"
import { createMcpSocket } from "../../src/mcp/socket"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

const fixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-mcp-guest-"))
  const runtime = createKernel({ appData: root })
  const db = runtime.kernel.db as Database
  db.query(
    "INSERT INTO bots (id, name, provider, machine, home_dir, created_at, updated_at) VALUES ('bot', 'VM', 'codex', 'vm', ?, 1, 1)",
  ).run(root)
  db.query(
    "INSERT INTO threads (id, bot_id, kind, title, created_at, updated_at) VALUES ('thread', 'bot', 'chat', 'VM', 1, 1)",
  ).run()
  const host = createMcpSocket({ kernel: runtime.kernel, registrations: new Map() })
  await host.listen()
  const sockets = new Set<Socket>()
  // Fake only the guest relay. Authentication and MCP initialize run on the real host socket.
  const guestPath = join(root, "guest.sock")
  const relay = createServer((client) => {
    sockets.add(client)
    client.on("close", () => sockets.delete(client))
    client.on("error", () => {})
    let buffer = Buffer.alloc(0)
    const hello = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      const end = buffer.indexOf(10)
      if (end < 0) return
      expect(JSON.parse(buffer.subarray(0, end).toString())).toEqual({ role: "client" })
      client.pause()
      client.removeListener("data", hello)
      const upstream = createConnection(host.socketPath)
      sockets.add(upstream)
      upstream.on("error", () => client.destroy())
      upstream.on("close", () => {
        sockets.delete(upstream)
        client.destroy()
      })
      client.on("close", () => upstream.destroy())
      upstream.on("connect", () => {
        upstream.write(buffer.subarray(end + 1))
        client.pipe(upstream)
        upstream.pipe(client)
        client.resume()
      })
    }
    client.on("data", hello)
  })
  await new Promise<void>((resolve) => relay.listen(guestPath, resolve))
  const children: Array<ReturnType<typeof Bun.spawn>> = []
  const launch = (path: string, viaEnv = false) => {
    const child = Bun.spawn({
      cmd: ["node", join(import.meta.dir, "../../src/vm/image/mcp-stdio.cjs"), "thread", ...(viaEnv ? [] : [path])],
      env: {
        ...process.env,
        TOURI_RUN_DIR: root,
        TOURI_MCP_SOCK: guestPath,
        ...(viaEnv ? { TOURI_MCP_TOKEN_FILE: path } : {}),
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    children.push(child)
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`)
    return child
  }
  cleanups.push(async () => {
    for (const child of children) child.kill()
    await Promise.all(children.map((child) => child.exited))
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => relay.close(() => resolve()))
    await host.close()
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, runtime, db, launch }
}

test.each([false, true])("guest shim retries a delayed per-run write and authenticates (env: %s)", async (viaEnv) => {
  const f = await fixture()
  const credential = await createRunMcpToken(f.runtime.kernel, "thread", "private-run-token")
  const path = join(f.root, `thread.${credential.tokenId}.token`)
  const child = f.launch(path, viaEnv)
  await Bun.sleep(200)
  writeFileSync(path, "private-run-token", { mode: 0o600 })
  const reader = child.stdout.getReader()
  let response = ""
  while (!response.includes("\n")) {
    const chunk = await reader.read()
    if (chunk.done) break
    response += new TextDecoder().decode(chunk.value)
  }
  expect(JSON.parse(response).result.serverInfo.name).toBe("touri")
  // Release closes an authenticated, still-running shim and removes host authorization.
  credential.revoke()
  expect(await child.exited).toBe(0)
  reader.releaseLock()
  expect(
    authenticateMcp({
      kernel: f.runtime.kernel,
      database: f.db,
      tokenDir: join(f.root, "run/mcp-tokens"),
      line: JSON.stringify({
        touriAuth: { thread: "thread", token: "private-run-token", tokenId: credential.tokenId },
      }),
    }).success,
  ).toBe(false)
})

test("missing guest token exits within a bounded wait with a clear diagnostic and no secret", async () => {
  const f = await fixture()
  const started = Date.now()
  const child = f.launch(join(f.root, `thread.${"a".repeat(32)}.token`))
  expect(await child.exited).toBe(1)
  expect(Date.now() - started).toBeGreaterThanOrEqual(1900)
  expect(Date.now() - started).toBeLessThan(4000)
  expect(await new Response(child.stdout).text()).toBe("")
  expect(await new Response(child.stderr).text()).toContain(
    "touri MCP startup failed: token_unavailable (unable to read per-run token",
  )
})

test("host rejects the wrong per-run token and the guest explains an initialize disconnect", async () => {
  const f = await fixture()
  const credential = await createRunMcpToken(f.runtime.kernel, "thread", "right-token")
  const path = join(f.root, `thread.${credential.tokenId}.token`)
  writeFileSync(path, "wrong-token")
  const child = f.launch(path)
  expect(await child.exited).toBe(1)
  const stderr = await new Response(child.stderr).text()
  expect(stderr).toMatch(
    /touri MCP startup failed: (bridge_closed|socket_error) \(bridge (closed before the initialize response|connection failed)/,
  )
  expect(await new Response(child.stdout).text()).toBe("")
  expect(stderr).not.toContain("wrong-token")
  credential.revoke()
})

test("guest shim refuses a shared thread token or a path outside its run directory", async () => {
  const f = await fixture()
  for (const path of [join(f.root, "thread.token"), `/tmp/thread.${"a".repeat(32)}.token`]) {
    const child = f.launch(path)
    expect(await child.exited).toBe(1)
    expect(await new Response(child.stderr).text()).toContain("a per-run token file")
  }
})

test("a new host cannot authenticate a persisted credential from before app_restart", async () => {
  const f = await fixture()
  const credential = await createRunMcpToken(f.runtime.kernel, "thread", "old-run-token")
  const otherHost = { ...f.runtime.kernel }
  const line = JSON.stringify({ touriAuth: { thread: "thread", token: "old-run-token", tokenId: credential.tokenId } })
  const args = { line, database: f.db, tokenDir: join(f.root, "run/mcp-tokens") }
  expect(authenticateMcp({ ...args, kernel: f.runtime.kernel }).success).toBe(true)
  expect(authenticateMcp({ ...args, kernel: otherHost }).success).toBe(false)
  credential.revoke()
})
