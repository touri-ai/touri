import { expect, test } from "bun:test"
import { createServer, type Socket } from "node:net"
import { createHostClient } from "../../src/kernel/host-client"

type Request = { id: number; method: string; params: { token?: string; account?: string } }
const fixture = async (handle: (socket: Socket, request: Request) => void, requestTimeoutMs = 1000) => {
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    socket.on("error", () => {})
    socket.setEncoding("utf8")
    let buffer = ""
    socket.on("data", (chunk) => {
      buffer += chunk
      while (buffer.includes("\n")) {
        const at = buffer.indexOf("\n")
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        handle(socket, JSON.parse(line))
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const client = createHostClient({
    socketPath: `tcp://127.0.0.1:${(server.address() as { port: number }).port}`,
    token: "fixture-token",
    onNotification: () => {},
    requestTimeoutMs,
  })
  return {
    client,
    close: async () => {
      client.close()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
const reply = (socket: Socket, id: number, result: unknown) => socket.write(`${JSON.stringify({ id, result })}\n`)

test("loopback authenticates once before concurrent calls and correlates out-of-order UTF-8 replies", async () => {
  const methods: string[] = []
  let finishSlow: (() => void) | undefined
  const { client, close } = await fixture((socket, request) => {
    methods.push(request.method)
    if (request.method === "auth") {
      expect(request.params.token).toBe("fixture-token")
      setTimeout(() => reply(socket, request.id, { ok: true }), 20)
    } else if (request.params.account === "slow") finishSlow = () => reply(socket, request.id, { value: "slow" })
    else {
      const bytes = Buffer.from(`${JSON.stringify({ id: request.id, result: { value: "café" } })}\n`)
      const split = bytes.indexOf(Buffer.from("é")) + 1
      socket.write(bytes.subarray(0, split))
      setTimeout(() => socket.write(bytes.subarray(split)), 5)
    }
  })
  try {
    const slow = client.callHost("keychain.get", { account: "slow" })
    const fast = client.callHost("keychain.get", { account: "fast" })
    expect(await fast).toEqual({ success: true, value: { value: "café" } })
    expect(methods).toEqual(["auth", "keychain.get", "keychain.get"])
    expect(finishSlow).toBeDefined()
    finishSlow?.()
    expect(await slow).toEqual({ success: true, value: { value: "slow" } })
  } finally {
    await close()
  }
})

test("failed auth never sends a privileged request", async () => {
  const methods: string[] = []
  const { client, close } = await fixture((socket, request) => {
    methods.push(request.method)
    socket.write(`${JSON.stringify({ id: request.id, error: { message: "Invalid token" } })}\n`)
  })
  try {
    expect(await client.callHost("keychain.get", { account: "fixture" })).toMatchObject({
      success: false,
      errorCode: "HOST_UNAVAILABLE",
    })
    expect(methods).toEqual(["auth"])
  } finally {
    await close()
  }
})

test.each(["timeout", "oversized"])("loopback rejects a %s response without leaving callers pending", async (mode) => {
  const { client, close } = await fixture((socket, request) => {
    if (request.method === "auth") reply(socket, request.id, { ok: true })
    else if (mode === "oversized") socket.write("x".repeat(1_048_577))
  }, 100)
  try {
    expect(await client.callHost("keychain.get", { account: "fixture" })).toMatchObject({
      success: false,
      errorCode: "HOST_UNAVAILABLE",
    })
  } finally {
    await close()
  }
})
