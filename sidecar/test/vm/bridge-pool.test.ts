import { expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createConnection, createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnTree } from "../../src/kernel/spawn"
import { MCP_LIMITS } from "../../src/mcp/connection"
import { BRIDGE_IDLE_POOL, connectMcpBridge } from "../../src/vm/bridge"
import { configureBridge } from "../../src/vm/configure-bridge"
import { machineConnection } from "../../src/vm/connection"
import { connectionKeyId, sealConnection } from "../../src/vm/sealed-connection"
import { fakeVmProvider } from "./fake-provider"

const listen = (server: Server, path: string) => new Promise<void>((resolve) => server.listen(path, () => resolve()))

type Fixture = { forwarded: () => number; client: () => Promise<string>; close: () => Promise<void> }

// Runs the real guest bridge behind a relay that forwards each host connection after forwardDelayMs,
// like the `container exec socat` forward into an Apple container guest.
const bridgeFixture = async (forwardDelayMs: number): Promise<Fixture> => {
  const root = mkdtempSync(join(tmpdir(), "touri-bridge-pool-"))
  const guestSocket = join(root, "guest.sock")
  const relayPath = join(root, "relay.sock")
  const hostSocket = join(root, "host.sock")
  const reservation = createServer()
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve))
  const address = reservation.address()
  if (!address || typeof address === "string") throw new Error("Missing test port")
  const guestPort = address.port
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  const node = Bun.which("node") ?? "node"
  const guest = Bun.spawn(
    [
      node,
      join(import.meta.dir, "../../src/vm/image/mcp-bridge.cjs"),
      guestSocket,
      String(guestPort),
      join(root, "pw"),
    ],
    { stdout: "ignore", stderr: "ignore" },
  )
  const peers = new Set<Socket>()
  const track = (socket: Socket) => {
    peers.add(socket)
    socket.on("close", () => peers.delete(socket))
    socket.on("error", () => {})
    return socket
  }
  let forwarded = 0
  const relay = createServer((socket) => {
    track(socket)
    const early: Buffer[] = []
    const hold = (chunk: Buffer) => early.push(chunk)
    socket.on("data", hold)
    const timer = setTimeout(() => {
      forwarded++
      const inner = track(createConnection(guestPort, "127.0.0.1"))
      inner.on("close", () => socket.destroy())
      socket.on("close", () => inner.destroy())
      socket.removeListener("data", hold)
      for (const chunk of early) inner.write(chunk)
      socket.on("data", (chunk) => inner.write(chunk))
      inner.on("data", (chunk) => socket.write(chunk))
    }, forwardDelayMs)
    socket.on("close", () => clearTimeout(timer))
  })
  const host = createServer((socket) => {
    track(socket)
    socket.once("data", () => socket.write("initialize-reply\n"))
  })
  await Promise.all([listen(relay, relayPath), listen(host, hostSocket)])
  for (let i = 0; i < 400 && !existsSync(guestSocket); i++) await Bun.sleep(25)
  const key = randomBytes(32)
  const token = randomBytes(32).toString("hex")
  const connection = machineConnection({ id: "pool", provider: "test", ports: [], authKeyId: connectionKeyId(key) })
  connection.bridge = { guestPort, socketPath: guestSocket, connectionFile: join(root, "connection.json") }
  writeFileSync(connection.bridge.connectionFile, sealConnection({ connection, token, key }), { mode: 0o600 })
  const provider = fakeVmProvider().provider
  provider.spawn = (input) =>
    spawnTree({ cmd: node, args: input.args ?? [], cwd: root, env: { PATH: "/usr/bin:/bin" } })
  await configureBridge({ provider, connection, key, signal: AbortSignal.timeout(3000) })
  const stop = connectMcpBridge({ port: 0, transport: `unix:${relayPath}`, token, socketPath: hostSocket })
  return {
    forwarded: () => forwarded,
    client: () => {
      const client = track(createConnection(guestSocket))
      const reply = new Promise<string>((resolve) => {
        let value = ""
        client.on("data", (chunk) => {
          value += chunk.toString()
          if (value.includes("\n")) resolve(value)
        })
        client.on("close", () => resolve(value || "closed"))
        setTimeout(() => resolve(value || "timeout"), 1500)
      })
      client.write(`${JSON.stringify({ role: "client" })}\n{"touriAuth":{}}\n`)
      return reply
    },
    close: async () => {
      stop()
      for (const peer of peers) peer.destroy()
      relay.close()
      host.close()
      guest.kill()
      await guest.exited
      rmSync(root, { recursive: true, force: true })
    },
  }
}

// Issue #3: while another VM boots, the per-connection forward can take longer than the auth deadline.
// Idle host connections must survive it and must not be recycled, which races the guest's pairing.
test("#3: a slow guest forward still fills the pool and idle host connections are not recycled", async () => {
  const bridge = await bridgeFixture(MCP_LIMITS.authMs + 500)
  try {
    await Bun.sleep(2 * MCP_LIMITS.authMs + 1000)
    expect(bridge.forwarded()).toBe(BRIDGE_IDLE_POOL)
    for (let index = 0; index < BRIDGE_IDLE_POOL; index++) expect(await bridge.client()).toBe("initialize-reply\n")
  } finally {
    await bridge.close()
  }
}, 30_000)

test("#3: concurrent MCP sessions beyond the idle pool still pair", async () => {
  const bridge = await bridgeFixture(0)
  try {
    await Bun.sleep(300)
    const replies = await Promise.all(Array.from({ length: BRIDGE_IDLE_POOL + 2 }, () => bridge.client()))
    expect(replies).toEqual(Array.from({ length: BRIDGE_IDLE_POOL + 2 }, () => "initialize-reply\n"))
  } finally {
    await bridge.close()
  }
}, 15_000)
