import { expect, test } from "bun:test"
import { DEFAULT_GROUP_TURN_TIMEOUT_MS, groupTurnTimeoutMs } from "../../src/groups/runtime"

test("a channel turn is not cut after two minutes", () => {
  expect(groupTurnTimeoutMs(0)).toBe(DEFAULT_GROUP_TURN_TIMEOUT_MS)
  expect(DEFAULT_GROUP_TURN_TIMEOUT_MS).toBeGreaterThanOrEqual(60 * 60_000)
})

test("a configured cap never drops below one hour", () => {
  expect(groupTurnTimeoutMs(120_000)).toBe(60 * 60_000)
  expect(groupTurnTimeoutMs(3 * 60 * 60_000)).toBe(3 * 60 * 60_000)
})
