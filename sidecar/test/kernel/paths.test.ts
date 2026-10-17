import { expect, test } from "bun:test"
import { join } from "node:path"
import type { Kernel } from "@touri/contracts"
import { createAppPaths, resolveMcpSocketPath } from "../../src/kernel/paths"
import { createMcpSocket } from "../../src/mcp/socket"

test("MCP uses a short socket path for a long data directory", () => {
  const paths = createAppPaths({ appData: join("/tmp", "data-".repeat(30)) })
  const socket = createMcpSocket({ kernel: { paths } as Kernel, registrations: new Map() })
  expect(Buffer.byteLength(socket.socketPath)).toBeLessThan(104)
  expect(socket.socketPath).not.toBe(join(paths.runDir, "mcp.sock"))
})

test("normal MCP socket paths are unchanged", () => {
  const paths = createAppPaths({ appData: "/tmp/touri-path-fixture" })
  const socket = createMcpSocket({ kernel: { paths } as Kernel, registrations: new Map() })
  expect(socket.socketPath).toBe(join(paths.runDir, "mcp.sock"))
})

test.each([
  { platform: "darwin" as const, limit: 104 },
  { platform: "linux" as const, limit: 108 },
])("MCP socket paths fit the platform byte limit on $platform", ({ platform, limit }) => {
  const suffixBytes = Buffer.byteLength("/run/mcp.sock")
  const short = createAppPaths({ appData: `/${"a".repeat(limit - suffixBytes - 2)}` })
  const full = createAppPaths({ appData: `${short.appData}a` })
  expect(Buffer.byteLength(join(short.runDir, "mcp.sock"))).toBe(limit - 1)
  expect(resolveMcpSocketPath(short, { platform })).toBe(join(short.runDir, "mcp.sock"))
  expect(Buffer.byteLength(join(full.runDir, "mcp.sock"))).toBe(limit)
  expect(Buffer.byteLength(resolveMcpSocketPath(full, { platform }))).toBeLessThan(limit)
})

test("MCP counts UTF-8 bytes rather than characters", () => {
  const paths = createAppPaths({ appData: `/tmp/${"é".repeat(45)}` })
  expect(join(paths.runDir, "mcp.sock").length).toBeLessThan(104)
  expect(resolveMcpSocketPath(paths, { platform: "darwin" })).not.toBe(join(paths.runDir, "mcp.sock"))
})

test("MCP fallback is stable, private to the data directory, and short even with a long TMPDIR", () => {
  const appData = join("/tmp", "data-".repeat(30))
  const paths = createAppPaths({ appData })
  const options = { tempDir: "/tmp/socket-fixture" }
  const socketPath = resolveMcpSocketPath(paths, options)
  expect(socketPath).toStartWith("/tmp/socket-fixture/touri-")
  expect(resolveMcpSocketPath(createAppPaths({ appData: join(appData, ".") }), options)).toBe(socketPath)
  expect(resolveMcpSocketPath(createAppPaths({ appData: `${appData}other` }), options)).not.toBe(socketPath)
  const fallback = resolveMcpSocketPath(paths, { tempDir: join("/tmp", "temp-".repeat(30)) })
  expect(fallback).toStartWith("/tmp/touri-")
  expect(Buffer.byteLength(fallback)).toBeLessThan(104)
})
