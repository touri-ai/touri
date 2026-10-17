import { expect, test } from "bun:test"
import { toolCatalog, validateToolArgs } from "@touri/contracts"
import { target } from "../../src/browser"

test("compiled tool validators accept valid args and report the schema path", () => {
  expect(toolCatalog.tools).toHaveLength(52)
  expect(validateToolArgs({ name: "history_search", args: { query: "accentuação" } })).toEqual({
    success: true,
    args: { query: "accentuação", limit: 10 },
  })
  const invalid = validateToolArgs({ name: "history_search", args: { query: "x" } })
  expect(invalid.success).toBe(false)
  if (!invalid.success) {
    expect(invalid.errorCode).toBe("INVALID_ARGS")
    expect(invalid.error).toContain("schema path:")
  }
})

test("browser targets accept snapshot ref shorthand and still reject invalid arguments", () => {
  for (const input of ["4.43", { ref: "4.43" }, { kind: "ref", ref: "4.43" }]) {
    expect(
      validateToolArgs({ name: "browser_click", args: { tabId: `t_${"0".repeat(26)}`, target: input } }).success,
    ).toBe(true)
    expect(target(input)).toEqual({ kind: "ref", ref: "4.43" })
  }
  expect(
    validateToolArgs({ name: "browser_click", args: { tabId: `t_${"0".repeat(26)}`, target: "invalid" } }).success,
  ).toBe(false)
  const numeric = validateToolArgs({ name: "browser_click", args: { tabId: `t_${"0".repeat(26)}`, target: 4.43 } })
  expect(numeric).toMatchObject({ success: false, error: expect.stringContaining("sempre entre aspas") })
})

test("browser timeoutMs sent as a string or out of range is normalized instead of rejected", () => {
  const tabId = `t_${"0".repeat(26)}`
  const timeoutOf = (name: string, timeoutMs: unknown, extra: Record<string, unknown> = {}): unknown => {
    const result = validateToolArgs({ name, args: { tabId, ...extra, timeoutMs } })
    return result.success ? (result.args as { timeoutMs: number }).timeoutMs : result
  }
  expect(timeoutOf("browser_snapshot", "30000")).toBe(30000)
  expect(timeoutOf("browser_snapshot", 120000)).toBe(30000)
  expect(timeoutOf("browser_screenshot", 100)).toBe(500)
  expect(timeoutOf("browser_evaluate", 2000, { expression: "1" })).toBe(2000)
  expect(validateToolArgs({ name: "browser_open", args: { url: "https://x.com", timeoutMs: "30000" } })).toMatchObject({
    success: true,
  })
  expect(validateToolArgs({ name: "browser_list_tabs", args: { timeoutMs: 1500 } }).success).toBe(true)
  expect(validateToolArgs({ name: "browser_snapshot", args: { tabId, timeoutMs: "soon" } }).success).toBe(false)
})
