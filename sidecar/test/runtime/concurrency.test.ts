import { expect, test } from "bun:test"
import { getDefaultMaxConcurrentRuns } from "../../src/runtime/concurrency"

test("the default remains three and a valid environment limit is honored before saving settings", () => {
  expect(getDefaultMaxConcurrentRuns({})).toBe(3)
  expect(getDefaultMaxConcurrentRuns({ TOURI_MAX_CONCURRENT_RUNS: "2" })).toBe(2)
})

test.each(["0", "33", "1.5", "invalid", ""])("invalid environment limit %j falls back to three", (limit) => {
  const env = { TOURI_MAX_CONCURRENT_RUNS: limit }

  const result = getDefaultMaxConcurrentRuns(env)

  expect(result).toBe(3)
})
