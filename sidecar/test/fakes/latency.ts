export const getPercentile = (samples: ReadonlyArray<number>, percentile: number): number => {
  if (samples.length === 0) return 0
  if (!Number.isFinite(percentile) || percentile < 0 || percentile > 1)
    throw new RangeError("Percentile must be between 0 and 1")

  const ordered = Array.from(samples).sort((first, second) => first - second)
  const index = Math.max(0, Math.min(ordered.length - 1, Math.ceil(percentile * ordered.length) - 1))

  return ordered[index] ?? 0
}

export const getMedian = (samples: ReadonlyArray<number>): number => {
  const ordered = Array.from(samples).sort((first, second) => first - second)
  const middle = Math.floor(ordered.length / 2)
  if (ordered.length === 0) return 0
  if (ordered.length % 2 === 1) return ordered[middle] ?? 0

  return ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2
}

export const getMaximum = (samples: ReadonlyArray<number>): number =>
  samples.reduce((maximum, sample) => Math.max(maximum, sample), 0)

export const measureCpuTime = <T>(operation: () => T): { value: T; cpuMs: number } => {
  // Process CPU time includes worker and garbage-collector threads, not just this event loop.
  const started = process.cpuUsage()
  const value = operation()
  const usage = process.cpuUsage(started)

  return { value, cpuMs: (usage.user + usage.system) / 1000 }
}

export const startEventLoopLagProbe = (intervalMs = 5) => {
  // The probe owns a bounded sample window and stops only when the caller stops it.
  const samples: Array<number> = []
  let expectedAt = performance.now() + intervalMs
  const timer = setInterval(() => {
    const actualAt = performance.now()
    if (samples.length < 10_000) samples.push(Math.max(0, actualAt - expectedAt))
    expectedAt = actualAt + intervalMs
  }, intervalMs)

  return {
    getSamples: () => Array.from(samples),
    stop: () => clearInterval(timer),
  }
}
