import { afterEach, expect, test } from "bun:test"
import type { ChildProcess } from "../../src/runtime/provider-io"
import { createWarmSessions } from "../../src/runtime/warm-session"

const pools = new Set<ReturnType<typeof createWarmSessions>>()
afterEach(() => {
  pools.forEach((pool) => {
    pool.stop()
  })
  pools.clear()
})

const getPool = (idleMs = 60_000, limit = 4) => {
  const pool = createWarmSessions(idleMs, limit)
  pools.add(pool)
  return pool
}

const getChild = () => {
  // These controllers model a single external process lifecycle.
  let resolveExit: (result: { code: number; signal: string | null }) => void = () => undefined
  let stdout: ReadableStreamDefaultController<Uint8Array> | undefined
  let stderr: ReadableStreamDefaultController<Uint8Array> | undefined
  let alive = true
  const signals: string[] = []
  const exit = () => {
    if (!alive) return
    alive = false
    stdout?.close()
    stderr?.close()
    resolveExit({ code: 0, signal: null })
  }
  const child: ChildProcess = {
    success: true,
    pid: 0,
    pgid: 0,
    stdin: new WritableStream(),
    stdout: new ReadableStream({
      start: (controller) => {
        stdout = controller
      },
    }),
    stderr: new ReadableStream({
      start: (controller) => {
        stderr = controller
      },
    }),
    extra: [],
    exited: new Promise((resolve) => {
      resolveExit = resolve
    }),
    kill: (signal) => {
      signals.push(signal)
      exit()
    },
  }

  return { child, signals, exit, send: (text: string) => stdout?.enqueue(new TextEncoder().encode(text)) }
}

test("retains one tool-free process and delivers text to the next turn", async () => {
  const pool = getPool()
  const process = getChild()
  const first = pool.acquire("thread-settings", () => process.child, "/fixtures/temp")
  first.release(true, "native-session")

  const second = pool.getAvailable("thread-settings", "native-session")
  expect(second?.reused).toBe(true)
  process.send("first token\n")
  const text = second ? new TextDecoder().decode((await second.child.stdout.getReader().read()).value) : ""

  expect(text).toBe("first token\n")
  expect(process.signals).toEqual([])
  expect(pool.getLifetime("/fixtures/temp")).toBe(process.child.exited)
  second?.release(true, "native-session")
})

test("a dead session is discarded and the next turn starts a fresh process", async () => {
  const pool = getPool()
  const firstProcess = getChild()
  const first = pool.acquire("thread-settings", () => firstProcess.child)
  first.release(true, "native-session")

  firstProcess.exit()
  await firstProcess.child.exited
  await Bun.sleep(0)
  const secondProcess = getChild()
  const second = pool.acquire("thread-settings", () => secondProcess.child)

  expect(second.reused).toBe(false)
  expect(second.child.stdin).toBe(secondProcess.child.stdin)
})

test("native session changes, failed turns and task processes cannot reuse a retained connection", () => {
  const pool = getPool()
  const process = getChild()
  pool.acquire("thread-settings", () => process.child).release(true, "old-session")

  expect(pool.getAvailable("thread-settings", "different-session")).toBeUndefined()
  expect(process.signals).toEqual(["SIGTERM"])
  const failed = getChild()
  pool.acquire("failed-thread", () => failed.child).release(false)
  expect(pool.getAvailable("failed-thread", "native-session")).toBeUndefined()
  expect(failed.signals).toEqual(["SIGTERM"])
  const task = getChild()
  pool.acquire(null, () => task.child).release(true, "task-session")
  expect(task.signals).toEqual(["SIGTERM"])
})

test("idle expiry and capacity bound retained processes", async () => {
  const pool = getPool(20, 1)
  const first = getChild()
  pool.acquire("first", () => first.child).release(true, "session-one")
  const second = getChild()

  pool.acquire("second", () => second.child).release(true, "session-two")
  expect(first.signals).toEqual(["SIGTERM"])
  await Bun.sleep(40)

  expect(second.signals).toEqual(["SIGTERM"])
  expect(pool.getAvailable("second", "session-two")).toBeUndefined()
})

test("a prepared native session can serve the first user message before it has been persisted", () => {
  const pool = getPool()
  const process = getChild()
  const prepared = { externalSessionId: "prepared-session", rolloutPath: null }
  pool.acquire("bot:settings", () => process.child).release(true, prepared.externalSessionId, prepared)

  const firstTurn = pool.getAvailable("bot:settings")

  expect(firstTurn?.reused).toBe(true)
  expect(firstTurn?.preparedSession).toEqual(prepared)
  firstTurn?.release(true, prepared.externalSessionId)
  expect(pool.hasAvailable("bot:settings", prepared.externalSessionId)).toBe(true)
  expect(pool.hasAvailable("bot:settings")).toBe(false)
})

test("switching conversations recycles the same bot's idle provider", () => {
  const pool = getPool()
  const old = getChild()
  pool.acquire("bot:old-thread", () => old.child).release(true, "old-session")
  const next = getChild()

  pool.acquire("bot:next-thread", () => next.child).release(true, "next-session")

  expect(old.signals).toEqual(["SIGTERM"])
  expect(next.signals).toEqual([])
})
