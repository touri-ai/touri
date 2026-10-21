type Capture<T> = {
  generation: number
  pending: boolean
  expiresAt: number
  result: Promise<T | null>
}

/** Share one bounded capture per target; a slow reader never schedules another capture. */
export const createSharedPreviewSource = <T>({ now = Date.now, intervalMs = 800 } = {}) => {
  const captures = new Map<string, Capture<T>>()

  const capture = async ({
    target,
    generation,
    isCurrent,
    read,
  }: {
    target: string
    generation: number
    isCurrent: () => boolean
    read: () => Promise<T | null>
  }): Promise<T | null> => {
    if (!isCurrent()) return null
    const previous = captures.get(target)
    if (previous?.pending && previous.generation !== generation) return null
    if (previous && (previous.pending || previous.expiresAt > now())) {
      const result = await previous.result

      return previous.generation === generation && isCurrent() ? result : null
    }
    if (!previous && captures.size >= 32) {
      captures.forEach((entry, key) => {
        if (!entry.pending && entry.expiresAt <= now()) captures.delete(key)
      })
      if (captures.size >= 32) return null
    }

    const current: Capture<T> = {
      generation,
      pending: true,
      expiresAt: 0,
      result: Promise.resolve(null),
    }
    // Capture lifecycle is local to this source; identity fences late completions after cleanup.
    current.result = Promise.resolve()
      .then(read)
      .then((result) => (captures.get(target) === current && isCurrent() ? result : null))
      .catch(() => null)
      .finally(() => {
        current.pending = false
        current.expiresAt = now() + intervalMs
      })
    captures.set(target, current)

    return current.result
  }

  return { capture, clear: () => captures.clear() }
}
