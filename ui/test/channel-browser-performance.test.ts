import { expect, test, vi } from "vitest"
import {
  type BrowserMeasurementScope,
  type BrowserPerformanceEntry,
  startBrowserPerformanceMeasurement,
} from "./e2e/channel-browser-performance"

test("late warmup entries stay outside the measured interval while current interactions remain aggregated", () => {
  const scope: BrowserMeasurementScope = {}
  const createObserver = vi.fn((_onEntries: (entries: BrowserPerformanceEntry[]) => void) => ({ observe: vi.fn() }))

  startBrowserPerformanceMeasurement({ scope, createObserver, startedAt: 100 })

  const onRenderingEntries = createObserver.mock.calls[0]?.[0]
  const onInteractionEntries = createObserver.mock.calls[1]?.[0]
  if (!onRenderingEntries || !onInteractionEntries || !scope.getBrowserMeasurement)
    throw new Error("Browser measurement observers were not registered")

  onRenderingEntries([
    { entryType: "longtask", startTime: 99, duration: 56 },
    { entryType: "longtask", startTime: 100, duration: 52 },
    { entryType: "layout-shift", startTime: 99, duration: 0, value: 0.4 },
    { entryType: "layout-shift", startTime: 101, duration: 0, value: 0.002 },
    { entryType: "layout-shift", startTime: 102, duration: 0, value: 0.3, hadRecentInput: true },
  ])
  onInteractionEntries([
    { entryType: "event", startTime: 99, duration: 168, interactionId: 1 },
    { entryType: "event", startTime: 100, duration: 24, interactionId: 2 },
    { entryType: "event", startTime: 101, duration: 32, interactionId: 2 },
  ])

  expect(scope.getBrowserMeasurement()).toEqual({
    longTasks: [52],
    events: [32],
    eventSource: "event-timing",
    clickEvents: [],
    warmupEvents: [168],
    cls: 0.002,
    shiftSources: [""],
  })
})

test("fast trusted clicks keep paint evidence when native Event Timing omits their durations", () => {
  const { scope, recordClick } = startClickMeasurement()

  recordClick({ isTrusted: true, timeStamp: 110 })

  expect(scope.getBrowserMeasurement?.()).toMatchObject({
    events: [10],
    clickEvents: [10],
    eventSource: "click-to-paint",
  })
})

test("slow native interactions remain the budget samples even when clicks paint quickly", () => {
  const { scope, recordClick, createObserver } = startClickMeasurement()

  recordClick({ isTrusted: true, timeStamp: 110 })
  createObserver.mock.calls[1]?.[0]([{ entryType: "event", startTime: 110, duration: 160, interactionId: 2 }])

  expect(scope.getBrowserMeasurement?.()).toMatchObject({
    events: [160],
    clickEvents: [10],
    eventSource: "event-timing",
  })
})

test("untrusted and warmup clicks cannot create measured paint evidence", () => {
  const { scope, recordClick, requestFrame } = startClickMeasurement()

  recordClick({ isTrusted: false, timeStamp: 110 })
  recordClick({ isTrusted: true, timeStamp: 99 })

  expect(scope.getBrowserMeasurement?.().events).toEqual([])
  expect(requestFrame).not.toHaveBeenCalled()
})

test("an interval without input retains empty evidence", () => {
  const { scope } = startClickMeasurement()

  const measurement = scope.getBrowserMeasurement?.()

  expect(measurement?.events).toEqual([])
  expect(measurement?.clickEvents).toEqual([])
})

test("click measurement work stops at the bounded sample limit", () => {
  const { scope, recordClick, requestFrame } = startClickMeasurement()

  Array.from({ length: 201 }).forEach(() => {
    recordClick({ isTrusted: true, timeStamp: 110 })
  })

  expect(scope.getBrowserMeasurement?.().clickEvents).toHaveLength(200)
  expect(requestFrame).toHaveBeenCalledTimes(400)
})

const startClickMeasurement = () => {
  const scope: BrowserMeasurementScope = {}
  const subscribeToClicks = vi.fn((_onClick: (event: Pick<MouseEvent, "isTrusted" | "timeStamp">) => void) => {})
  const requestFrame = vi.fn((callback: FrameRequestCallback) => {
    callback(120)
    return 0
  })
  const createObserver = vi.fn((_onEntries: (entries: BrowserPerformanceEntry[]) => void) => ({ observe: vi.fn() }))

  startBrowserPerformanceMeasurement({ scope, createObserver, subscribeToClicks, requestFrame, startedAt: 100 })

  return {
    scope,
    createObserver,
    requestFrame,
    recordClick: (event: Pick<MouseEvent, "isTrusted" | "timeStamp">) => subscribeToClicks.mock.calls[0]?.[0](event),
  }
}
