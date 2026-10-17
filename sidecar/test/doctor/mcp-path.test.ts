import { expect, test } from "bun:test"
import { socketPathCheck } from "../../src/cli/doctor"
import { mcpSocketPathCheck } from "../../src/doctor/mcp"
import { createAppPaths } from "../../src/kernel/paths"

test("doctor reports the long MCP socket path fallback as information", () => {
  const appData = `/tmp/${"data-".repeat(30)}`
  const cli = socketPathCheck(appData)
  expect(cli.level).toBe("ok")
  expect(cli.detail).toContain("short private temporary socket directory")
  expect(cli.detail).not.toContain(appData)
  const local = mcpSocketPathCheck(createAppPaths({ appData }))
  expect(local).toMatchObject({ status: "pass", ok: true, fix: null })
  expect(local.detail).toContain("pasta temporária privada")
  expect(local.detail).not.toContain(appData)
})

test("doctor keeps normal MCP socket paths healthy", () => {
  const appData = "/tmp/touri-path-fixture"
  expect(socketPathCheck(appData)).toMatchObject({ level: "ok", detail: "36 bytes" })
  expect(mcpSocketPathCheck(createAppPaths({ appData }))).toMatchObject({ status: "pass", ok: true })
})
