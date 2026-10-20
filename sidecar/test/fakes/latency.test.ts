import { afterEach, expect, test } from "bun:test"
import { getMaximum, getMedian, getPercentile, startEventLoopLagProbe } from "./latency"

const cleanups = new Set<() => void>()
afterEach(() => {
  cleanups.forEach((cleanup) => {
    cleanup()
  })
  cleanups.clear()
})

test("latency percentiles ignore one isolated spike while preserving a median", () => {
  const samples = Array.from({ length: 19 }, (_, index) => index + 1).concat(500)

  expect(getPercentile(samples, 0.95)).toBe(19)
  expect(getMedian(samples)).toBe(10.5)
  expect(getMaximum(samples)).toBe(500)
  expect(samples).toEqual(Array.from({ length: 19 }, (_, index) => index + 1).concat(500))
})

test("latency readers return zero for empty input", () => {
  expect(getPercentile([], 0.99)).toBe(0)
  expect(getMedian([])).toBe(0)
  expect(getMaximum([])).toBe(0)
})

test.each([-0.01, 1.01, Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY])(
  "percentile %s is rejected outside the finite unit interval",
  (percentile) => {
    expect(() => getPercentile([1, 2, 3], percentile)).toThrow(RangeError)
  },
)

test("an odd-length median uses the middle sorted sample without changing the input", () => {
  const samples = [9, 1, 5]

  const median = getMedian(samples)

  expect(median).toBe(5)
  expect(samples).toEqual([9, 1, 5])
})

test("p99 selects the 99th ordered sample out of 100", () => {
  const samples = Array.from({ length: 100 }, (_, index) => 100 - index)

  expect(getPercentile(samples, 0.99)).toBe(99)
  expect(getPercentile(samples, 0)).toBe(1)
  expect(getPercentile(samples, 1)).toBe(100)
  expect(samples[0]).toBe(100)
})

test("the event-loop lag probe returns independent snapshots and stops collecting", async () => {
  const probe = startEventLoopLagProbe(1)
  cleanups.add(probe.stop)

  await Bun.sleep(20)
  const first = probe.getSamples()
  await Bun.sleep(20)
  const second = probe.getSamples()
  probe.stop()
  probe.stop()
  const stopped = probe.getSamples()
  await Bun.sleep(20)

  expect(first.length).toBeGreaterThan(0)
  expect(second.length).toBeGreaterThan(first.length)
  expect(probe.getSamples()).not.toBe(stopped)
  expect(probe.getSamples()).toEqual(stopped)
  expect(stopped.every((lag) => Number.isFinite(lag) && lag >= 0)).toBe(true)
})
