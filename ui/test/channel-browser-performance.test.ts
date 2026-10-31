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
    warmupEvents: [168],
    cls: 0.002,
    shiftSources: [""],
  })
})
