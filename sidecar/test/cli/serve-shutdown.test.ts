import { afterEach, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { Subprocess } from "bun"
import { registerServeShutdown } from "../../src/cli/serveShutdown"

let child: Subprocess<"ignore", "pipe", "pipe"> | undefined
afterEach(() => {
  child?.kill("SIGKILL")
  child = undefined
})

test.each(["SIGTERM", "SIGINT"] as const)("a second %s skips drain and interrupts immediately", async (signal) => {
  const f = getFixture()

  f.signals.emit(signal)
  await Bun.sleep(0)
  expect(f.getShutdownCount()).toBe(0)
  f.signals.emit(signal)
  await Bun.sleep(0)

  expect(f.getShutdownCount()).toBe(1)
  expect(f.getFinishCount()).toBe(1)
  expect(f.exits).toEqual([0])
  expect(f.logs).toContain("Segundo sinal recebido; interrompendo o encerramento gradual.")
  expect(f.signals.listenerCount(signal)).toBe(0)
  f.advance(21_000)
  expect(f.exits).toEqual([0])
})

test("mixed signals preserve the original absolute backstop when termination hangs", async () => {
  const f = getFixture({ hang: true })
  f.signals.emit("SIGTERM")
  await Bun.sleep(0)
  f.advance(500)

  f.signals.emit("SIGINT")
  await Bun.sleep(0)
  f.advance(20_499)

  expect(f.getShutdownCount()).toBe(1)
  expect(f.exits).toEqual([])
  f.advance(1)
  expect(f.exits).toEqual([1])
  expect(f.getFinishCount()).toBe(0)
})

test("deadline starts interruption and the same backstop bounds unresponsive shutdown", async () => {
  const f = getFixture({ hang: true })
  f.signals.emit("SIGTERM")
  await Bun.sleep(0)

  f.advance(999)
  await Bun.sleep(0)
  expect(f.getShutdownCount()).toBe(0)
  f.advance(1)
  await Bun.sleep(0)
  expect(f.getShutdownCount()).toBe(1)
  f.advance(20_000)

  expect(f.exits).toEqual([1])
})

test("successful drain waits for cleanup and cancels both deadlines", async () => {
  const f = getFixture()
  f.signals.emit("SIGTERM")
  await Bun.sleep(0)

  f.drained.resolve()
  await Bun.sleep(0)
  f.advance(21_000)

  expect(f.getShutdownCount()).toBe(1)
  expect(f.getFinishCount()).toBe(1)
  expect(f.exits).toEqual([0])
})

test("drain failure still interrupts and exits with a failure status", async () => {
  const f = getFixture()
  f.signals.emit("SIGTERM")
  await Bun.sleep(0)

  f.drained.reject(new Error("synthetic failure"))
  await Bun.sleep(0)

  expect(f.getShutdownCount()).toBe(1)
  expect(f.getFinishCount()).toBe(1)
  expect(f.exits).toEqual([1])
  expect(f.logs).toContain("O encerramento gradual falhou; interrompendo o runtime.")
})

test.each(["SIGTERM", "SIGINT"] as const)(
  "serve handles a real second %s through interruption and cleanup",
  async (signal) => {
    const moduleUrl = new URL("../../src/cli/serveShutdown.ts", import.meta.url).href
    const source = `
    import { registerServeShutdown } from ${JSON.stringify(moduleUrl)}
    registerServeShutdown({
      drainTimeoutMs: 1000,
      beginDrain: () => { console.log("draining"); return new Promise(() => {}) },
      shutdown: async () => { console.log("interrupted"); await Bun.sleep(20) },
      finish: async () => { console.log("cleanup complete") },
      log: () => {},
    })
    console.log("ready")
    setInterval(() => {}, 1000)
  `
    const processUnderTest = Bun.spawn([process.execPath, "--eval", source], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    child = processUnderTest
    const reader = processUnderTest.stdout.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready")
    processUnderTest.kill("SIGTERM")
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("draining")

    processUnderTest.kill(signal)
    const [code, output] = await Promise.all([processUnderTest.exited, getStreamText(reader)])

    expect(code).toBe(0)
    expect(output).toContain("interrupted")
    expect(output).toContain("cleanup complete")
  },
)

test("a provider ignoring termination cannot keep the server alive beyond deadline plus 20 seconds", async () => {
  const moduleUrl = new URL("../../src/cli/serveShutdown.ts", import.meta.url).href
  const source = `
    import { registerServeShutdown } from ${JSON.stringify(moduleUrl)}
    const provider = new Promise(() => {})
    registerServeShutdown({
      drainTimeoutMs: 10,
      beginDrain: () => provider,
      shutdown: () => provider,
      finish: async () => {},
      log: () => {},
    })
    console.log("ready")
    setInterval(() => {}, 1000)
  `
  const processUnderTest = Bun.spawn([process.execPath, "--eval", source], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  child = processUnderTest
  const reader = processUnderTest.stdout.getReader()
  const ready = await reader.read()
  reader.releaseLock()
  expect(new TextDecoder().decode(ready.value)).toContain("ready")

  const started = performance.now()
  processUnderTest.kill("SIGTERM")
  const [code, stderr] = await Promise.all([processUnderTest.exited, new Response(processUnderTest.stderr).text()])

  expect(code).toBe(1)
  expect(stderr).toBe("")
  expect(performance.now() - started).toBeLessThan(21_000)
}, 30_000)

const getFixture = ({ hang = false } = {}) => {
  const signals = new EventEmitter()
  const drained = Promise.withResolvers<void>()
  const exits: number[] = []
  const logs: string[] = []
  // The manual clock and counters belong only to this synthetic server lifecycle.
  let now = 0
  let timers: Array<{ at: number; callback: () => void }> = []
  let shutdownCount = 0
  let finishCount = 0
  registerServeShutdown({
    drainTimeoutMs: 1000,
    beginDrain: () => drained.promise,
    shutdown: async () => {
      shutdownCount += 1
      if (hang) await new Promise(() => {})
    },
    finish: async () => {
      finishCount += 1
    },
    log: ({ msg }) => {
      logs.push(msg)
    },
    signals,
    exit: (code) => {
      exits.push(code)
    },
    schedule: (callback, delayMs) => {
      const timer = { at: now + delayMs, callback }
      timers = [...timers, timer]
      return () => {
        timers = timers.filter((pending) => pending !== timer)
      }
    },
  })
  return {
    signals,
    drained,
    exits,
    logs,
    getShutdownCount: () => shutdownCount,
    getFinishCount: () => finishCount,
    advance: (elapsedMs: number) => {
      now += elapsedMs
      const due = timers.filter((timer) => timer.at <= now)
      timers = timers.filter((timer) => timer.at > now)
      due.forEach((timer) => {
        timer.callback()
      })
    },
  }
}

const getStreamText = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> => {
  const decoder = new TextDecoder()
  // This recording belongs only to the fixture's fixed, short stdout stream.
  let output = ""
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) {
      reader.releaseLock()
      return output + decoder.decode()
    }
    output += decoder.decode(chunk.value, { stream: true })
  }
}
