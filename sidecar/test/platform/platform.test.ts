import { expect, test } from "bun:test"
import { join, posix } from "node:path"
import { createAppPaths, resolveMcpSocketPath } from "../../src/kernel/paths"
import { ociEngine } from "../../src/platform"
import * as linux from "../../src/platform/linux"
import * as macos from "../../src/platform/macos"
import { connectionOptions, mcpEndpoint, resolveMcpEndpoint } from "../../src/platform/transport"
import * as windows from "../../src/platform/windows"

test("data paths follow each platform and XDG/AppData overrides", () => {
  expect(linux.defaultDataRoot("/test-home", {})).toBe("/test-home/.local/share/touri")
  expect(linux.defaultDataRoot("/test-home", { TOURI_HEADLESS: "1" })).toBe("/test-home/.touri")
  expect(linux.defaultDataRoot("/test-home", { XDG_DATA_HOME: "/data" })).toBe("/data/touri")
  expect(windows.defaultDataRoot("C:\\Users\\test", { APPDATA: "D:\\Data" })).toBe("D:\\Data\\touri")
  expect(macos.defaultDataRoot("/test-home")).toBe(posix.join("/test-home", "Library", "Application Support", "touri"))
})
test("prefer rootless Podman on Linux and Docker Desktop on Windows", () => {
  const which = (name: string) => name
  expect(ociEngine("linux", which)).toBe("podman")
  expect(ociEngine("win32", which)).toBe("docker")
  expect(ociEngine("darwin", which)).toBeNull()
  expect(ociEngine("linux", () => null)).toBeNull()
})
test("bridge TCP endpoint validation forbids remote hosts and URL credentials", () => {
  expect(connectionOptions("tcp://127.0.0.1:4321")).toEqual({ host: "127.0.0.1", port: 4321 })
  for (const value of [
    "tcp://example.test:12",
    "tcp://localhost:12",
    "tcp://127.0.0.1:0",
    "tcp://user@127.0.0.1:12",
    "tcp://127.0.0.1:12/path",
  ])
    expect(() => connectionOptions(value)).toThrow()
  expect(connectionOptions("/run/touri/host.sock")).toEqual({ path: "/run/touri/host.sock" })
})
test("Windows MCP discovery accepts only validated loopback endpoints", () => {
  expect(mcpEndpoint("run", "win32", () => JSON.stringify("tcp://127.0.0.1:4321"))).toBe("tcp://127.0.0.1:4321")
  for (const value of ["tcp://example.test:4321", "tcp://127.0.0.1:0", "file.sock", {}, null])
    expect(() => mcpEndpoint("run", "win32", () => JSON.stringify(value))).toThrow()
  expect(mcpEndpoint("a", "linux")).toMatch(/a[/\\]mcp\.sock$/)
})

test("Linux process identity handles parenthesized names and refuses malformed/reused PIDs", () => {
  const fields = ["S", "7", ...Array(17).fill("0"), "123456"]
  const stat = `42 (process (with) spaces) ${fields.join(" ")}`
  expect(linux.parseProcessIdentity(42, stat)).toEqual({ startTime: "linux:123456", parentPid: 7, alive: true })
  expect(linux.parseProcessIdentity(43, stat)).toBeNull()
  expect(linux.parseProcessIdentity(42, "42 (broken) S 7")).toBeNull()
  expect(linux.parseProcessIdentity(42, stat.replace(") S", ") Z"))?.alive).toBe(false)
})

test("Unix MCP discovery preserves the short socket fallback for long data paths", () => {
  const paths = createAppPaths({ appData: join("/tmp", "data-".repeat(30)) })
  for (const platform of ["darwin", "linux"] as const) {
    const endpoint = mcpEndpoint(paths.runDir, platform)
    expect(endpoint).toBe(resolveMcpSocketPath(paths, { platform }))
    expect(Buffer.byteLength(endpoint)).toBeLessThan(platform === "darwin" ? 104 : 108)
  }
  if (process.platform !== "win32") expect(resolveMcpEndpoint(paths)).toBe(resolveMcpSocketPath(paths))
})
