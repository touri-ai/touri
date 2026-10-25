import { expect, test } from "bun:test"
import { getBrowserSandboxCapability } from "./system-browser-capability"

test("a successful sandboxed browser probe enables the persistence regression", () => {
  expect(getBrowserSandboxCapability(0, "")).toEqual({ available: true })
})

test("an explicit sandbox capability failure explains the skipped integration", () => {
  expect(getBrowserSandboxCapability(1, "Failed to move to new namespace")).toEqual({
    available: false,
    reason: "Host cannot start the system browser with its sandbox enabled",
  })
})

test("unknown browser failures remain test failures", () => {
  expect(() => getBrowserSandboxCapability(1, "Unexpected startup failure")).toThrow(
    "System browser capability probe failed (exit 1)",
  )
  expect(() => getBrowserSandboxCapability(137, "")).toThrow("System browser capability probe failed (exit 137)")
})
