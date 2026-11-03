export const startBrowserPerformanceMeasurement = (
  input: {
    scope?: BrowserMeasurementScope
    createObserver?: (onEntries: (entries: BrowserPerformanceEntry[]) => void) => MeasurementObserver
    startedAt?: number
    subscribeToClicks?: (onClick: (event: Pick<MouseEvent, "isTrusted" | "timeStamp">) => void) => void
    requestFrame?: (callback: FrameRequestCallback) => number
    getNow?: () => number
  } = {},
): void => {
  const scope = input.scope ?? (window as BrowserMeasurementScope)
  const getNow = input.getNow ?? (() => performance.now())
  const startedAt = input.startedAt ?? getNow()
  const createObserver =
    input.createObserver ??
    ((onEntries: (entries: BrowserPerformanceEntry[]) => void) =>
      new PerformanceObserver((list) => onEntries(list.getEntries())))
  // These bounded collectors live only for this synthetic browser interaction.
  const longTasks: number[] = []
  const events = new Map<number, number>()
  const warmupEvents: number[] = []
  const clickEvents: number[] = []
  let observedClicks = 0
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

  const recordEventEntries = (entries: BrowserPerformanceEntry[]): void => {
    entries.forEach((entry) => {
      if (entry.startTime < startedAt) {
        if (warmupEvents.length < 200) warmupEvents.push(entry.duration)
        return
      }

      const id = entry.interactionId
      if (id && (events.size < 200 || events.has(id))) events.set(id, Math.max(events.get(id) ?? 0, entry.duration))
    })
  }
  const eventObserver = createObserver(recordEventEntries)
  eventObserver.observe({ type: "event", durationThreshold: 16 })

  const subscribeToClicks =
    input.subscribeToClicks ??
    ((onClick: (event: Pick<MouseEvent, "isTrusted" | "timeStamp">) => void) =>
      document.addEventListener("click", onClick, { capture: true }))
  const requestFrame = input.requestFrame ?? ((callback: FrameRequestCallback) => requestAnimationFrame(callback))
  // Event Timing omits inputs below 16 ms. Measure real clicks through a paint too, so a fast
  // interval still has evidence; retain native samples whenever present, including slow inputs.
  subscribeToClicks((event) => {
    if (!event.isTrusted || event.timeStamp < startedAt || observedClicks >= 200) return
    observedClicks += 1
    requestFrame(() => requestFrame(() => clickEvents.push(getNow() - event.timeStamp)))
  })

  scope.getBrowserMeasurement = () => {
    // Read buffered native entries before selecting the source, so slow input cannot become fallback evidence.
    recordEventEntries(eventObserver.takeRecords?.() ?? [])
    const nativeEvents = Array.from(events.values())

    return {
      longTasks,
      events: nativeEvents.length ? nativeEvents : clickEvents,
      eventSource: nativeEvents.length ? "event-timing" : "click-to-paint",
      clickEvents,
      warmupEvents,
      cls: shifts.reduce((total, value) => total + value, 0),
      shiftSources,
    }
  }
}

export type BrowserMeasurement = {
  longTasks: number[]
  events: number[]
  eventSource: "event-timing" | "click-to-paint"
  clickEvents: number[]
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
type MeasurementObserver = {
  observe: (options: PerformanceObserverInit) => void
  takeRecords?: () => BrowserPerformanceEntry[]
}
