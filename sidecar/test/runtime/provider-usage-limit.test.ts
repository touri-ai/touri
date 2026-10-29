import { expect, test } from "bun:test"
import { classifyProviderError } from "../../src/runtime/utils"

test.each([
  "You've hit your 5-hour limit · resets 8pm (UTC)",
  "You’ve hit your weekly limit · resets tomorrow",
  "YOU'VE HIT YOUR SESSION LIMIT",
  "You've hit your 7-day limit",
  "usage limit reached",
  "rate limit exceeded",
  "HTTP 429",
])("provider quota diagnostic is classified as rate_limit: %s", (message) => {
  expect(classifyProviderError(message)).toBe("rate_limit")
})

test.each(["You've hit your file limit", "Execution limit exceeded", "Session cannot be resumed"])(
  "unrelated diagnostic remains unknown: %s",
  (message) => {
    expect(classifyProviderError(message)).toBe("unknown")
  },
)
