import { writeFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"

test.use({ channel: "chromium", reducedMotion: "reduce" })
test.setTimeout(120_000)

type Counts = {
  enabled: boolean
  commits: number
  bubbleCommits: number
  bubbleRenders: number
  renders: Record<string, number>
  renderMs: number[]
  longTasks: number[]
  frames: number[]
  streamingFrames: number[]
  handlers: number[]
  replyLengths: number[]
}
type StreamingWindow = Window & {
  streamingCounts: Counts
  streamingTyping: { stream: (options?: { size: number }) => Promise<void>; active: boolean }
}

/** Counts message bubble renders per React commit; reused fibers are skipped without walking them. */
const installCounter = () => {
  localStorage.setItem("touri.sidebar.mode", "work")
  // Local probe counters avoid adding allocation overhead to the measured callbacks.
  type Fiber = {
    flags: number
    type?: { name?: string; type?: { name?: string } } | string | (() => unknown)
    child: Fiber | null
    sibling: Fiber | null
    alternate: Fiber | null
    actualDuration?: number
  }
  const getCounts = (enabled: boolean): Counts => ({
    enabled,
    commits: 0,
    bubbleCommits: 0,
    bubbleRenders: 0,
    renders: {},
    renderMs: [],
    longTasks: [],
    frames: [],
    streamingFrames: [],
    handlers: [],
    replyLengths: [],
  })
  const counts = getCounts(false)
  const seen = new WeakMap<Fiber, Fiber>()
  const getFiberName = (type: Fiber["type"]): string | undefined => {
    if (typeof type === "function") return type.name
    if (typeof type === "object") return type?.name ?? type?.type?.name

    return undefined
  }
  Object.assign(window, {
    streamingCounts: counts,
    resetStreamingCounts: () => Object.assign(counts, getCounts(true)),
    // The dev server's refresh runtime also registers through this hook, so it needs a renderer map.
    __REACT_DEVTOOLS_GLOBAL_HOOK__: {
      renderers: new Map<number, unknown>(),
      supportsFiber: true,
      inject(this: { renderers: Map<number, unknown> }, renderer: unknown) {
        const id = this.renderers.size + 1
        this.renderers.set(id, renderer)
        return id
      },
      onScheduleFiberRoot: () => {},
      onPostCommitFiberRoot: () => {},
      onCommitFiberUnmount: () => {},
      onCommitFiberRoot: (_id: number, root: { current: Fiber }) => {
        let bubbles = 0
        const visit = (fiber: Fiber | null): void => {
          if (!fiber) return
          if (seen.get(fiber) !== fiber) {
            seen.set(fiber, fiber)
            if (fiber.alternate) seen.set(fiber.alternate, fiber)
            const type = fiber.type
            const name = getFiberName(type)
            // The row function may sit inside a memo wrapper; count the function component that did work.
            if (typeof type === "function" && (fiber.flags & 1) !== 0) {
              if (/^MessageBubble(?:Row)?$/.test(name ?? "")) bubbles += 1
              if (
                counts.enabled &&
                name &&
                /^(App|AppContent|VirtualMessageList|Composer|DraftComposer|Sidebar)$/.test(name)
              )
                counts.renders[name] = (counts.renders[name] ?? 0) + 1
            }
            visit(fiber.child)
          }
          visit(fiber.sibling)
        }
        visit(root.current)
        if (!counts.enabled) return
        counts.commits += 1
        if (bubbles > 0) counts.bubbleCommits += 1
        counts.bubbleRenders += bubbles
        counts.renderMs.push(root.current.actualDuration ?? 0)
      },
    },
  })
  new PerformanceObserver((list) => {
    if (counts.enabled) for (const entry of list.getEntries()) counts.longTasks.push(entry.duration)
  }).observe({ entryTypes: ["longtask"] })
  const inputStarts = new WeakMap<Event, number>()
  document.addEventListener(
    "input",
    (event) => {
      if (counts.enabled && event.target instanceof HTMLTextAreaElement) inputStarts.set(event, performance.now())
    },
    true,
  )
  document.addEventListener("input", (event) => {
    const start = inputStarts.get(event)
    if (start === undefined) return

    queueMicrotask(() => counts.handlers.push(performance.now() - start))
  })
  document.addEventListener(
    "keydown",
    (event) => {
      if (!counts.enabled || !(event.target instanceof HTMLTextAreaElement) || event.key.length !== 1) return
      const start = performance.now()
      const active = (window as StreamingWindow).streamingTyping.active
      if (active && counts.streamingFrames.length % 20 === 0) {
        const answer = Array.from(document.querySelectorAll('[data-message-id="stream-reply"] .markdown-content')).find(
          (element) => element.textContent?.includes("Aqui está"),
        )
        counts.replyLengths.push(answer?.textContent?.length ?? 0)
      }
      requestAnimationFrame(() => {
        const elapsed = performance.now() - start
        counts.frames.push(elapsed)
        if (active) counts.streamingFrames.push(elapsed)
      })
    },
    true,
  )
}

const getPercentile = (values: number[], fraction: number): number =>
  values.toSorted((left, right) => left - right)[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? 0

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`rich history stays usable during continuous streaming at ${viewport.width}px`, async ({ page }, info) => {
    await page.setViewportSize(viewport)
    page.on("pageerror", (error) => console.log(`pageerror: ${error.message}`))
    page.on("console", (message) => {
      if (message.type() === "error") console.log(`console: ${message.text().slice(0, 300)}`)
    })
    await page.addInitScript(installCounter)
    await page.goto("/test/e2e/streaming-typing-harness.html?history=rich")
    const input = page.getByRole("textbox", { name: "Mensagem para mark", exact: true })
    await expect(input).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText("Pergunta 999", { exact: true })).toBeVisible()
    await input.click()
    const cdp = await page.context().newCDPSession(page)
    await cdp.send("Performance.enable")
    // Warm autosizing, attention and the initial history layout before the idle comparison.
    await input.pressSequentially("aquecimento", { delay: 40 })
    await input.fill("")
    const resetCounts = () =>
      page.evaluate(() => {
        const target = window as Window & { resetStreamingCounts: () => void }
        target.resetStreamingCounts()
      })
    const stopProbe = () =>
      page.evaluate(() => {
        const counts = (window as StreamingWindow).streamingCounts
        counts.enabled = false
        return counts
      })
    const getTaskMs = async () => {
      const result = await cdp.send("Performance.getMetrics")
      return (result.metrics.find((metric) => metric.name === "TaskDuration")?.value ?? 0) * 1000
    }
    const draft = "o rascunho continua enquanto a resposta chega sem perder nenhuma palavra "
    await resetCounts()
    const idleTaskStart = await getTaskMs()
    const idleStart = await page.evaluate(() => performance.now())

    await input.pressSequentially(draft, { delay: 40 })
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())))
    const idleEnd = await page.evaluate(() => performance.now())
    const idleTaskMs = (await getTaskMs()) - idleTaskStart
    const idleCounts = await stopProbe()
    await input.fill("")
    await resetCounts()
    await cdp.send("Profiler.enable")
    await cdp.send("Profiler.start")
    const streamTaskStart = await getTaskMs()
    const streamStart = await page.evaluate(() => performance.now())
    const streamed = page.evaluate(() => (window as StreamingWindow).streamingTyping.stream({ size: 20 }))
    await page
      .locator('[data-message-id="stream-reply"] .markdown-content')
      .filter({ hasText: "Aqui está o roteiro fictício completo" })
      .first()
      .waitFor()
    await input.pressSequentially(draft.repeat(3), { delay: 40 })
    if (process.env.TOURI_SCREENSHOT_DIR)
      await page.screenshot({ path: `${process.env.TOURI_SCREENSHOT_DIR}/typing-${viewport.width}.png` })
    await streamed
    const streamEnd = await page.evaluate(() => performance.now())
    const { profile } = await cdp.send("Profiler.stop")
    const self = new Map<string, number>()
    const interval = (profile.endTime - profile.startTime) / Math.max(1, profile.samples?.length ?? 1)
    const byId = new Map(profile.nodes.map((node) => [node.id, node]))
    for (const id of profile.samples ?? []) {
      const node = byId.get(id)
      if (!node) continue
      const name = `${node.callFrame.functionName || "(anon)"} ${node.callFrame.url.split("/").at(-1)}:${node.callFrame.lineNumber}`
      self.set(name, (self.get(name) ?? 0) + interval / 1000)
    }
    const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)
    console.log(`profile ${viewport.width}: ${JSON.stringify(top)}`)
    const streamingTaskMs = (await getTaskMs()) - streamTaskStart
    const counts = await stopProbe()
    const result = {
      historyMessages: 2000,
      historyTools: 12000,
      finishedRuns: 1000,
      idleKeys: idleCounts.frames.length,
      streamingKeys: counts.streamingFrames.length,
      replyGrowthWhileTyping: Math.max(0, ...counts.replyLengths) - Math.min(...counts.replyLengths),
      idleHandlerP95: getPercentile(idleCounts.handlers, 0.95),
      streamingHandlerP95: getPercentile(counts.handlers, 0.95),
      idleInputFrameP99: getPercentile(idleCounts.frames, 0.99),
      inputFrameP99: getPercentile(counts.streamingFrames, 0.99),
      inputFrameMax: Math.max(0, ...counts.streamingFrames),
      idleTaskMs,
      streamingTaskMs,
      idleTaskMsPerSecond: (idleTaskMs * 1000) / (idleEnd - idleStart),
      streamingTaskMsPerSecond: (streamingTaskMs * 1000) / (streamEnd - streamStart),
      idleRenders: idleCounts.renders,
      idleDurationMs: idleEnd - idleStart,
      durationMs: streamEnd - streamStart,
      commits: counts.commits,
      bubbleRendersPerCommit: counts.bubbleRenders / Math.max(1, counts.bubbleCommits),
      renders: counts.renders,
      renderP99: getPercentile(counts.renderMs, 0.99),
      renderMs: counts.renderMs.reduce((sum, duration) => sum + duration, 0),
      longTasks: counts.longTasks.length,
      longestTask: Math.max(0, ...counts.longTasks),
      longTaskMs: counts.longTasks.reduce((sum, value) => sum + value, 0),
    }
    console.log(`streaming-history ${viewport.width}: ${JSON.stringify(result)}`)
    await writeFile(info.outputPath("metrics.json"), JSON.stringify(result))

    await expect(input).toHaveValue(draft.repeat(3))
    const reply = page.locator('[data-message-id="stream-reply"]')
    await expect(reply).toContainText("Etapa 60")
    await reply.getByRole("button", { name: "Mostrar mais", exact: true }).click()
    await expect(reply.locator("ol > li")).toHaveCount(60)
    await expect(reply.locator("tbody > tr")).toHaveCount(8)
    await expect(reply).toContainText("Cidade 8")
    if (process.env.TOURI_SCREENSHOT_DIR) {
      await reply.locator("table").scrollIntoViewIfNeeded()
      await page.screenshot({ path: `${process.env.TOURI_SCREENSHOT_DIR}/table-${viewport.width}.png` })
    }
    // Earlier messages keep their props while one reply streams; only the streaming row renders again.
    expect(counts.bubbleCommits).toBeGreaterThan(10)
    expect(result.bubbleRendersPerCommit).toBeLessThan(3)
    expect(result.idleKeys).toBeGreaterThan(50)
    expect(result.streamingKeys).toBeGreaterThan(150)
    // Scheduling and frame delivery vary on the shared host; detect sustained or severe stalls.
    expect(result.replyGrowthWhileTyping).toBeGreaterThan(100)
    expect(result.streamingHandlerP95).toBeLessThan(16)
    expect(result.inputFrameP99).toBeLessThan(100)
    expect(result.inputFrameMax).toBeLessThan(2000)
  })
}
