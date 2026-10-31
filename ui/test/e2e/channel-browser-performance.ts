export const startBrowserPerformanceMeasurement = (
  input: {
    scope?: BrowserMeasurementScope
    createObserver?: (onEntries: (entries: BrowserPerformanceEntry[]) => void) => MeasurementObserver
    startedAt?: number
  } = {},
): void => {
  const scope = input.scope ?? (window as BrowserMeasurementScope)
  const startedAt = input.startedAt ?? performance.now()
  const createObserver =
    input.createObserver ??
    ((onEntries: (entries: BrowserPerformanceEntry[]) => void) =>
      new PerformanceObserver((list) => onEntries(list.getEntries())))
  // These bounded collectors live only for this synthetic browser interaction.
  const longTasks: number[] = []
  const events = new Map<number, number>()
  const warmupEvents: number[] = []
  const shifts: number[] = []
  const shiftSources: string[] = []
  const observer = createObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.startTime < startedAt) return
      if (entry.entryType === "longtask" && longTasks.length < 200) longTasks.push(entry.duration)
      if (entry.entryType !== "layout-shift" || entry.hadRecentInput || shifts.length >= 200) return

      shifts.push(entry.value ?? 0)
      shiftSources.push(
        (entry.sources ?? [])
          .map(({ node }) => node?.getAttribute?.("class") ?? node?.nodeName ?? "unknown")
          .join(", "),
      )
    })
  })
  observer.observe({ entryTypes: ["longtask", "layout-shift"] })
  const eventObserver = createObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.startTime < startedAt) {
        if (warmupEvents.length < 200) warmupEvents.push(entry.duration)
        return
      }

      const id = entry.interactionId
      if (id && (events.size < 200 || events.has(id))) events.set(id, Math.max(events.get(id) ?? 0, entry.duration))
    })
  })
  eventObserver.observe({ type: "event", durationThreshold: 16 })
  scope.getBrowserMeasurement = () => ({
    longTasks,
    events: Array.from(events.values()),
    warmupEvents,
    cls: shifts.reduce((total, value) => total + value, 0),
    shiftSources,
  })
}

export type BrowserMeasurement = {
  longTasks: number[]
  events: number[]
  warmupEvents: number[]
  cls: number
  shiftSources: string[]
}
export type BrowserMeasurementScope = { getBrowserMeasurement?: () => BrowserMeasurement }
export type BrowserPerformanceEntry = Pick<PerformanceEntry, "entryType" | "startTime" | "duration"> & {
  interactionId?: number
  value?: number
  hadRecentInput?: boolean
  sources?: Array<{ node?: Element }>
}
type MeasurementObserver = { observe: (options: PerformanceObserverInit) => void }
