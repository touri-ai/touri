import type { StartTurnArgs } from "@touri/contracts"
import type { ChildProcess } from "./provider-io"

export type WarmLease = {
  child: ChildProcess
  reused: boolean
  preparedSession?: { externalSessionId: string; rolloutPath: string | null }
  release: (keep: boolean, sessionId?: string, preparedSession?: WarmLease["preparedSession"]) => void
}

// Only tool-free local sessions are retained. Task credentials and approvals never outlive their turn.
export const createWarmSessions = (idleMs = 5 * 60_000, limit = 4) => {
  const sessions = new Map<string, ReturnType<typeof createSession>>()
  const getKey = (args: StartTurnArgs): string | null => {
    if (!args.conversationOnly || args.execution) return null

    const env = Object.fromEntries(
      Object.entries(args.env).filter(([key]) => !["TMPDIR", "TMP", "TEMP", "TMPPREFIX"].includes(key)),
    )
    return `${args.bot.id}:${JSON.stringify([args.thread.id, args.bot, args.fingerprint, args.developerInstructions, env])}`
  }
  const acquire = (key: string | null, spawn: () => ChildProcess, temporary?: string): WarmLease => {
    if (key === null) {
      const child = spawn()
      return { child, reused: false, release: () => child.kill("SIGTERM") }
    }
    if (sessions.has(key)) return acquire(null, spawn, temporary)
    // Retain at most one idle connection per bot, including after settings or thread changes.
    Array.from(sessions.entries())
      .filter(([otherKey, session]) => otherKey.startsWith(`${key.split(":")[0]}:`) && session.isAvailable())
      .forEach(([, session]) => {
        session.stop()
      })
    // Bound retained children even when many conversations receive greetings.
    if (sessions.size >= limit)
      Array.from(sessions.values())
        .find((session) => session.isAvailable())
        ?.stop()
    if (sessions.size >= limit) return acquire(null, spawn, temporary)

    const cacheKey = key
    const session = createSession(
      spawn(),
      temporary,
      () => {
        if (cacheKey && sessions.get(cacheKey) === session) sessions.delete(cacheKey)
      },
      idleMs,
    )
    if (cacheKey) sessions.set(cacheKey, session)
    const lease = session.attach(false)
    return {
      ...lease,
      release: (keep, sessionId, prepared) => lease.release(keep && cacheKey !== null, sessionId, prepared),
    }
  }

  return {
    getKey,
    hasAvailable: (key: string | null, sessionId?: string): boolean => {
      const session = key ? sessions.get(key) : undefined
      return !!session?.isAvailable() && session.matches(sessionId)
    },
    getAvailable: (key: string | null, sessionId?: string): WarmLease | undefined => {
      const session = key ? sessions.get(key) : undefined
      if (!session?.isAvailable()) return undefined
      if (!session.matches(sessionId)) {
        session.stop()
        return undefined
      }
      return session.attach(true)
    },
    acquire,
    getLifetime: (temporary: string): Promise<unknown> | undefined =>
      Array.from(sessions.values()).find((session) => session.temporary === temporary)?.exited,
    stop: (): void =>
      Array.from(sessions.values()).forEach((session) => {
        session.stop()
      }),
  }
}

const createSession = (child: ChildProcess, temporary: string | undefined, onStop: () => void, idleMs: number) => {
  // Stream controllers and process state belong to this one connection's I/O lifecycle.
  let sink: {
    stdout: WritableStreamDefaultWriter<Uint8Array>
    stderr: WritableStreamDefaultWriter<Uint8Array>
  } | null = null
  let alive = true
  let timer: ReturnType<typeof setTimeout> | undefined
  let turns = 0
  let sessionId: string | undefined
  let preparedSession: WarmLease["preparedSession"]
  const detach = (): void => {
    void sink?.stdout.close().catch(() => undefined)
    void sink?.stderr.close().catch(() => undefined)
    sink = null
  }
  const stop = (): void => {
    if (!alive) return
    alive = false
    clearTimeout(timer)
    onStop()
    detach()
    child.kill("SIGTERM")
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000)
    killTimer.unref()
    void child.exited.finally(() => clearTimeout(killTimer)).catch(() => undefined)
  }
  const pump = async (stream: ReadableStream<Uint8Array>, kind: "stdout" | "stderr"): Promise<void> => {
    const reader = stream.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        await sink?.[kind].write(value)
      }
    } catch {
      stop()
    } finally {
      reader.releaseLock()
    }
  }
  // Drain buffered frames before reporting process exit to the active turn.
  const drained = Promise.resolve().then(() =>
    Promise.all([pump(child.stdout, "stdout"), pump(child.stderr, "stderr")]),
  )
  void child.exited.then(() => drained.then(stop), stop)

  return {
    temporary,
    exited: child.exited,
    isAvailable: () => alive && sink === null,
    matches: (expected?: string) => (expected ? sessionId === expected : !!preparedSession),
    stop,
    attach: (reused: boolean): WarmLease => {
      clearTimeout(timer)
      turns += 1
      const stdout = new TransformStream<Uint8Array, Uint8Array>()
      const stderr = new TransformStream<Uint8Array, Uint8Array>()
      sink = { stdout: stdout.writable.getWriter(), stderr: stderr.writable.getWriter() }

      return {
        child: { ...child, stdout: stdout.readable, stderr: stderr.readable },
        reused,
        ...(preparedSession ? { preparedSession } : {}),
        release: (keep, externalSessionId, prepared) => {
          sessionId = externalSessionId
          preparedSession = prepared
          if (!keep || turns >= 100) return stop()
          detach()
          timer = setTimeout(stop, idleMs)
          timer.unref()
        },
      }
    },
  }
}
