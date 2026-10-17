import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHostClient } from "../../src/kernel/host-client"

test("host client authenticates over NDJSON and reconnects after a socket closes", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-host-"))
  const socketPath = join(root, "host.sock")
  mkdirSync(root, { recursive: true })
  const methods: Array<string> = []
  let connectionCount = 0
  const server = createServer((socket) => {
    connectionCount += 1
    let buffer = ""
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8")
      let newline = buffer.indexOf("\n")
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf("\n")
        const request = JSON.parse(line) as { id: number; method: string }
        methods.push(request.method)
        const result =
          request.method === "auth" ? { ok: true } : request.method === "keychain.get" ? { value: "fixture" } : {}
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`)
        if (request.method === "keychain.get" && connectionCount === 1) socket.end()
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  const client = createHostClient({ socketPath, token: "host-token", onNotification: () => undefined })
  try {
    const first = await client.callHost("keychain.get", { account: "global/API_KEY" })
    await Bun.sleep(20)
    const second = await client.callHost("keychain.get", { account: "global/API_KEY" })
    expect(first).toEqual({ success: true, value: { value: "fixture" } })
    expect(second).toEqual({ success: true, value: { value: "fixture" } })
    expect(methods).toEqual(["auth", "keychain.get", "auth", "keychain.get"])
    expect(connectionCount).toBe(2)
  } finally {
    client.close()
    server.close()
    rmSync(root, { recursive: true, force: true })
  }
})

for (const errorCode of ["VAULT_ACCESS_REQUIRED", "VAULT_TIMEOUT", "VAULT_CANCELLED", "VAULT_UNAVAILABLE"] as const)
  test(`host client preserves native ${errorCode} as a typed failure`, async () => {
    const root = mkdtempSync(join(tmpdir(), "touri-host-vault-"))
    const socketPath = join(root, "host.sock")
    const server = createServer((socket) => {
      let buffer = ""
      socket.on("data", (chunk) => {
        buffer += chunk.toString()
        let newline = buffer.indexOf("\n")
        while (newline >= 0) {
          const request = JSON.parse(buffer.slice(0, newline)) as { id: number; method: string }
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf("\n")
          socket.write(
            `${JSON.stringify({
              id: request.id,
              ...(request.method === "auth"
                ? { result: { ok: true } }
                : { error: { code: -32603, message: errorCode } }),
            })}\n`,
          )
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    const client = createHostClient({ socketPath, token: "test-token", onNotification: () => {} })
    try {
      expect(await client.callHost("keychain.get", { account: "bot/test/login" })).toEqual({
        success: false,
        errorCode,
        error: errorCode,
      })
    } finally {
      client.close()
      server.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
