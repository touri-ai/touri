import { type ChildProcess, execFile, spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { expect, test } from "@playwright/test"
import { build } from "vite"
import { composerPerformanceMessageCount, composerPerformanceToolCount } from "./composer-performance-fixture"
import "./syntax-memory-checks"

const run = promisify(execFile)
const repository = resolve(import.meta.dirname, "../../..")
const phase = process.env.TOURI_COMPOSER_PERF_PHASE ?? "after"
const cpuRate = Number(process.env.TOURI_COMPOSER_PERF_CPU_RATE ?? 4)

type Keystroke = {
  start: number
  keyToInputMs: number
  handlerMs: number
  frameMs: number
  afterFrameMs: number
}
type Commit = { at: number; duration: number; renders: Record<string, number> }
type Metrics = { enabled: boolean; samples: Keystroke[]; commits: Commit[]; lastCommitAt: number }

/** Installed before React starts. PerformedWork counts actual renders, including renders with no DOM mutation. */
const installMeasurements = () => {
  localStorage.setItem(
    "touri.workspace.v1",
    JSON.stringify({
      botId: "composer-performance-bot",
      threadId: "composer-performance-thread",
    }),
  )
  type Fiber = {
    flags: number
    type?: { displayName?: string; name?: string; type?: { name?: string } }
    child: Fiber | null
    sibling: Fiber | null
    alternate: Fiber | null
    actualDuration?: number
  }
  const metrics: Metrics = { enabled: false, samples: [], commits: [], lastCommitAt: 0 }
  const target = window as unknown as {
    composerPerformance: Metrics
    composerPerformanceComponents?: Map<unknown, string>
    __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown
  }
  const lastCommitted = new WeakMap<Fiber, Fiber>()
  target.composerPerformance = metrics
  target.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    inject: () => 1,
    onCommitFiberUnmount: () => {},
    onCommitFiberRoot: (_id: number, root: { current: Fiber }) => {
      const renders: Record<string, number> = {}
      const visit = (fiber: Fiber | null): void => {
        if (!fiber) return
        // Reused fibers retain old flags. Skip their subtrees without walking the idle transcript.
        if (lastCommitted.get(fiber) !== fiber) {
          lastCommitted.set(fiber, fiber)
          if (fiber.alternate) lastCommitted.set(fiber.alternate, fiber)
          const name = target.composerPerformanceComponents?.get(fiber.type)
          if (name && (fiber.flags & 1) !== 0) renders[name] = (renders[name] ?? 0) + 1
          visit(fiber.child)
        }
        visit(fiber.sibling)
      }
      visit(root.current)
      const committedAt = performance.now()
      metrics.lastCommitAt = committedAt
      if (metrics.enabled)
        metrics.commits.push({ at: committedAt, duration: root.current.actualDuration ?? 0, renders })
    },
  }
  let keydownAt = 0
  document.addEventListener(
    "keydown",
    (event) => {
      if (metrics.enabled && event.target instanceof HTMLTextAreaElement && event.key.length === 1)
        keydownAt = performance.now()
    },
    true,
  )
  // Keep the browser's key-to-input work separate from the delegated input handler.
  const inputStarts = new WeakMap<Event, number>()
  document.addEventListener(
    "input",
    (event) => {
      if (metrics.enabled && event.target instanceof HTMLTextAreaElement) inputStarts.set(event, performance.now())
    },
    true,
  )
  // React's delegated handler runs on the root before this document bubble listener.
  document.addEventListener("input", (event) => {
    if (!metrics.enabled || !(event.target instanceof HTMLTextAreaElement) || !keydownAt) return
    const inputAt = inputStarts.get(event)
    if (inputAt === undefined) return

    const sample: Keystroke = {
      start: keydownAt,
      keyToInputMs: inputAt - keydownAt,
      handlerMs: 0,
      frameMs: 0,
      afterFrameMs: 0,
    }
    metrics.samples.push(sample)
    keydownAt = 0
    queueMicrotask(() => {
      sample.handlerMs = performance.now() - inputAt
    })
    requestAnimationFrame(() => {
      sample.frameMs = performance.now() - sample.start
      // A task after rAF provides a paint opportunity; this is not a claim of physical display latency.
      setTimeout(() => {
        sample.afterFrameMs = performance.now() - sample.start
      }, 0)
    })
  })
}

const percentile = (values: number[], fraction: number): number =>
  [...values].sort((left, right) => left - right)[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? 0

const availablePort = async (): Promise<number> => {
  const socket = createServer()
  await new Promise<void>((ready) => socket.listen(0, "127.0.0.1", ready))
  const address = socket.address()
  if (!address || typeof address === "string") throw new Error("Temporary server port is unavailable")
  await new Promise<void>((done, reject) => socket.close((error) => (error ? reject(error) : done())))
  return address.port
}

test.use({
  channel: "chromium",
  viewport: { width: 1440, height: 900 },
  // DOM snapshots of thousands of tool nodes would dominate the work being measured.
  trace: { mode: "on", screenshots: false, snapshots: false, sources: false },
})
test.setTimeout(300_000)

test("long history keeps typing independent of transcript work", async ({ page, context }, testInfo) => {
  await mkdir(join(repository, "node_modules/.cache"), { recursive: true })
  const temporary = await mkdtemp(join(repository, "node_modules/.cache/touri-composer-performance-"))
  const dataDir = join(temporary, "data")
  const uiDir = join(temporary, "ui")
  let server: ChildProcess | undefined
  try {
    await build({
      root: join(repository, "ui"),
      configFile: join(repository, "ui/vite.config.ts"),
      logLevel: "error",
      resolve: { alias: { "react-dom/client": "react-dom/profiling" } },
      build: {
        outDir: uiDir,
        rollupOptions: {
          input: [join(repository, "ui/index.html"), join(repository, "ui/test/e2e/composer-performance-harness.html")],
        },
      },
    })
    await run("bun", ["scripts/seed-composer-performance.ts", "--data-dir", dataDir], { cwd: repository })
    const port = await availablePort()
    const origin = `http://127.0.0.1:${port}`
    server = spawn(
      "bun",
      ["sidecar/src/cli/main.ts", "serve", "--data-dir", dataDir, "--port", String(port), "--ui-dir", uiDir],
      {
        cwd: repository,
        // Keep this synthetic fixture independent of installed providers and their diagnostic polling.
        env: { ...process.env, TOURI_HEADLESS: "1", TOURI_DOCTOR_SKIP_PROVIDER_PROBES: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    let stdout = ""
    server.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    let failure = ""
    server.stderr?.on("data", (chunk: Buffer) => {
      failure += chunk.toString()
    })
    await expect
      .poll(() => stdout.includes("listening on") || server?.exitCode !== null, { timeout: 30_000 })
      .toBe(true)
    expect(stdout.includes("listening on"), `Temporary server failed: ${failure}`).toBe(true)
    const pairing = await run("bun", ["run", "touri", "pair", "--data-dir", dataDir], { cwd: repository })
    const code = pairing.stdout.match(/Pairing code: ([A-Z0-9-]+)/)?.[1]
    expect(Boolean(code), "Temporary server pairing code was generated").toBe(true)
    const paired = await context.request.post(`${origin}/pair`, { data: { code, name: "Performance fixture" } })
    expect(paired.ok()).toBe(true)
    await context.addInitScript(installMeasurements)
    await page.emulateMedia({ reducedMotion: "reduce" })
    const cdp = await context.newCDPSession(page)
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate })
    await cdp.send("Performance.enable")
    await page.goto(`${origin}/test/e2e/composer-performance-harness.html?mode=server`)
    const input = page.locator(".composer-island textarea")
    await expect(input).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole("heading", { name: "Synthetic review 250", exact: true })).toBeVisible({
      timeout: 30_000,
    })
    await page.waitForFunction(
      () =>
        (window as unknown as { composerPerformanceFixture: { initialLoadMs: number } }).composerPerformanceFixture
          .initialLoadMs > 0,
    )
    const initialLoadMs = await page.evaluate(
      () =>
        (window as unknown as { composerPerformanceFixture: { initialLoadMs: number } }).composerPerformanceFixture
          .initialLoadMs,
    )
    const response = await context.request.get(`${origin}/api/v1/threads/composer-performance-thread/messages?all=true`)
    const history = (await response.json()) as { messages: Array<{ parts: Array<{ type: string }> }> }
    expect(history.messages).toHaveLength(composerPerformanceMessageCount)
    expect(
      history.messages.reduce(
        (total, message) => total + message.parts.filter((part) => part.type === "tool_call").length,
        0,
      ),
    ).toBe(composerPerformanceToolCount)
    await input.focus()
    // Warm focus, mascot attention, and the first autosize before collecting steady-state typing.
    await input.press("w")
    await input.fill("")
    await page.evaluate(
      () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
    )
    // Let asynchronous virtual-row measurements settle before measuring typing commits.
    await page.waitForFunction(
      (quietPeriodMs) => {
        const metrics = (window as unknown as { composerPerformance: Metrics }).composerPerformance
        return metrics.lastCommitAt > 0 && performance.now() - metrics.lastCommitAt >= quietPeriodMs
      },
      250,
      { timeout: 15_000 },
    )
    const initialMetrics = await cdp.send("Performance.getMetrics")
    await page.evaluate(() => {
      const metrics = (window as unknown as { composerPerformance: Metrics }).composerPerformance
      metrics.samples = []
      metrics.commits = []
      metrics.enabled = true
    })
    const text = "Typing stays smooth."
    const taskSamples: number[] = []
    let previousTask = initialMetrics.metrics.find((metric) => metric.name === "TaskDuration")?.value ?? 0
    for (let index = 0; index < text.length; index++) {
      await input.press(text[index] ?? " ")
      await page.waitForFunction((length) => {
        const metrics = (window as unknown as { composerPerformance: Metrics }).composerPerformance
        return metrics.samples.length === length && (metrics.samples.at(-1)?.afterFrameMs ?? 0) > 0
      }, index + 1)
      const currentMetrics = await cdp.send("Performance.getMetrics")
      const task = currentMetrics.metrics.find((metric) => metric.name === "TaskDuration")?.value ?? previousTask
      taskSamples.push((task - previousTask) * 1000)
      previousTask = task
    }
    await expect(input).toHaveValue(text)
    const finalMetrics = await cdp.send("Performance.getMetrics")
    const metrics = await page.evaluate(() => {
      const metrics = (window as unknown as { composerPerformance: Metrics }).composerPerformance
      metrics.enabled = false
      return metrics
    })
    const durations = new Map(initialMetrics.metrics.map((metric) => [metric.name, metric.value]))
    const mainThread = Object.fromEntries(
      finalMetrics.metrics
        .filter((metric) =>
          ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration"].includes(metric.name),
        )
        .map((metric) => [metric.name, (metric.value - (durations.get(metric.name) ?? 0)) * 1000]),
    )
    const renders = metrics.commits.reduce<Record<string, number>>((total, commit) => {
      for (const [name, count] of Object.entries(commit.renders)) total[name] = (total[name] ?? 0) + count
      return total
    }, {})
    const report = {
      phase,
      cpuRate,
      messages: history.messages.length,
      toolCalls: composerPerformanceToolCount,
      initialLoadMs,
      keypresses: metrics.samples.length,
      p95KeyToInputMs: percentile(
        metrics.samples.map((sample) => sample.keyToInputMs),
        0.95,
      ),
      p95HandlerMs: percentile(
        metrics.samples.map((sample) => sample.handlerMs),
        0.95,
      ),
      p95NextFrameMs: percentile(
        metrics.samples.map((sample) => sample.frameMs),
        0.95,
      ),
      p95AfterFrameMs: percentile(
        metrics.samples.map((sample) => sample.afterFrameMs),
        0.95,
      ),
      reactCommits: metrics.commits.length,
      p95ReactRenderMs: percentile(
        metrics.commits.map((commit) => commit.duration),
        0.95,
      ),
      renders,
      mainThreadMs: mainThread,
      mainThreadMsPerKey: (mainThread.TaskDuration ?? 0) / metrics.samples.length,
      p95MainThreadMs: percentile(taskSamples, 0.95),
      samples: metrics.samples.map((sample, index) => ({ ...sample, mainThreadMs: taskSamples[index] })),
    }
    // Publish only generated measurements and pixels; raw traces contain machine-local source paths.
    await mkdir(testInfo.outputDir, { recursive: true })
    const reportPath = testInfo.outputPath("composer-performance.json")
    const screenshotPath = testInfo.outputPath("composer-performance.png")
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    await page.screenshot({ path: screenshotPath })
    await testInfo.attach(`composer-performance-${phase}.json`, { path: reportPath, contentType: "application/json" })
    await testInfo.attach("composer-performance.png", { path: screenshotPath, contentType: "image/png" })
    console.log(`Composer performance: ${JSON.stringify({ ...report, samples: undefined })}`)
    expect(metrics.samples).toHaveLength(text.length)
    expect(metrics.commits.length, "DevTools hook observed React commits").toBeGreaterThan(0)
    expect(renders.Composer ?? 0, "DevTools hook observed each composer edit").toBeGreaterThanOrEqual(text.length)
    if (phase === "baseline")
      expect(renders.VirtualMessageList ?? 0, "Baseline reproduces transcript renders while typing").toBeGreaterThan(0)
    if (phase !== "baseline") {
      expect(renders.VirtualMessageList ?? 0, "Typing must not render the transcript").toBe(0)
      expect(renders.MarkdownContent ?? 0, "Typing must not parse message markdown").toBe(0)
      expect(renders.ToolCallList ?? 0, "Typing must not render tool history").toBe(0)
      // Native editing before input must fit the same frame budget as the delegated handler.
      expect(report.p95KeyToInputMs).toBeLessThan(16)
      expect(report.p95HandlerMs).toBeLessThan(16)
      // rAF includes waiting for a display refresh; allow two missed frames under a throttled CI CPU.
      expect(report.p95NextFrameMs).toBeLessThan(50)
      expect(initialLoadMs).toBeLessThan(15_000)

      // Native autosizing must still grow, scroll at its limit, and shrink after clearing.
      const singleLineHeight = await input.evaluate((element) => element.getBoundingClientRect().height)
      await input.fill("First line\nSecond line\nThird line\nFourth line")
      await expect
        .poll(() => input.evaluate((element) => element.getBoundingClientRect().height))
        .toBeGreaterThan(singleLineHeight)
      const multiline = Array.from({ length: 30 }, (_, index) => `Synthetic line ${index + 1}`).join("\n")
      await input.fill(multiline)
      await expect(input).toHaveValue(multiline)
      const longInput = await input.evaluate((element) => ({
        height: element.getBoundingClientRect().height,
        maxHeight: Number.parseFloat(getComputedStyle(element).maxHeight),
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      }))
      expect(longInput.height).toBeLessThanOrEqual(longInput.maxHeight)
      expect(longInput.scrollHeight).toBeGreaterThan(longInput.clientHeight)
      await input.fill("")
      await expect
        .poll(() => input.evaluate((element) => element.getBoundingClientRect().height))
        .toBe(singleLineHeight)
    }
  } finally {
    if (server && server.exitCode === null) {
      server.kill("SIGTERM")
      await new Promise<void>((done) => {
        const timer = setTimeout(() => {
          server?.kill("SIGKILL")
          done()
        }, 10_000)
        server?.once("exit", () => {
          clearTimeout(timer)
          done()
        })
      })
    }
    await rm(temporary, { recursive: true, force: true })
  }
})
