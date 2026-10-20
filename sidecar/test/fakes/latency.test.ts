import { expect, test } from "bun:test"
import { getMaximum, getMedian, getPercentile } from "./latency"

test("latency percentiles ignore one isolated spike while preserving a median", () => {
  const samples = Array.from({ length: 19 }, (_, index) => index + 1).concat(500)

  expect(getPercentile(samples, 0.95)).toBe(19)
  expect(getMedian(samples)).toBe(10.5)
  expect(getMaximum(samples)).toBe(500)
  expect(samples).toEqual(Array.from({ length: 19 }, (_, index) => index + 1).concat(500))
})
