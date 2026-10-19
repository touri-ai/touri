export type RateLimiter = {
  check: (source?: string) => { allowed: true } | { allowed: false; retryAfterSeconds: number }
  recordFailure: (source?: string) => void
  reset: (source?: string) => void
}

export type ActionLimiter = {
  check: (source: string) => { allowed: true } | { allowed: false; retryAfterSeconds: number }
  record: (source: string) => void
}

/** Successful admin actions are rate-limited too; source storage remains bounded. */
export const createActionLimiter = ({
  maxActions,
  windowMs,
  now = Date.now,
}: {
  maxActions: number
  windowMs: number
  now?: () => number
}): ActionLimiter => {
  const actions = new Map<string, Array<number>>()
  const current = (source: string): Array<number> => {
    const cutoff = now() - windowMs
    for (const [key, times] of actions) {
      while (times.length > 0 && (times[0] ?? 0) <= cutoff) times.shift()
      if (times.length === 0) actions.delete(key)
    }
    return actions.get(source) ?? []
  }
  return {
    check: (source) => {
      const times = current(source)
      if (!actions.has(source) && actions.size >= 4096)
        return { allowed: false, retryAfterSeconds: Math.ceil(windowMs / 1000) }
      if (times.length < maxActions) return { allowed: true }
      const oldest = times[0] ?? now()
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now()) / 1000)) }
    },
    record: (source) => {
      const times = current(source)
      if (times.length >= maxActions || (!actions.has(source) && actions.size >= 4096)) return
      actions.set(source, [...times, now()])
    },
  }
}

/** Independent failure windows; the table itself is bounded too. */
export const createRateLimiter = ({
  maxFailures,
  windowMs,
  now = Date.now,
}: {
  maxFailures: number
  windowMs: number
  now?: () => number
}): RateLimiter => {
  const sources = new Map<string, Array<number>>()
  const failuresFor = (source: string): Array<number> => {
    const cutoff = now() - windowMs
    for (const [key, failures] of sources) {
      while (failures.length > 0 && (failures[0] ?? 0) <= cutoff) failures.shift()
      if (!failures.length) sources.delete(key)
    }
    return sources.get(source) ?? []
  }
  return {
    check: (source = "default") => {
      const failures = failuresFor(source)
      if (!sources.has(source) && sources.size >= 4096)
        return { allowed: false, retryAfterSeconds: Math.ceil(windowMs / 1000) }
      if (failures.length < maxFailures) return { allowed: true }
      const oldest = failures[0] ?? now()
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now()) / 1000)) }
    },
    recordFailure: (source = "default") => {
      const failures = failuresFor(source)
      if (failures.length >= maxFailures || (!sources.has(source) && sources.size >= 4096)) return
      failures.push(now())
      sources.set(source, failures)
    },
    reset: (source = "default") => {
      sources.delete(source)
    },
  }
}
