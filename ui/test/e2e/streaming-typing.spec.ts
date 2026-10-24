import { writeFile } from "node:fs/promises"
import { expect, type Page, test } from "@playwright/test"

test.use({ channel: "chromium", reducedMotion: "reduce" })
test.setTimeout(120_000)

type Sample = { key: number; frame: number }
type Probe = { samples: Sample[]; longTasks: Array<{ start: number; duration: number }> }

const installProbe = () => {
  const probe: Probe = { samples: [], longTasks: [] }
  Object.assign(window, { streamingProbe: probe })
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) probe.longTasks.push({ start: entry.startTime, duration: entry.duration })
  }).observe({ entryTypes: ["longtask"] })
  document.addEventListener(
    "keydown",
    (event) => {
      if (!(event.target instanceof HTMLTextAreaElement) || event.key.length !== 1) return
      const key = performance.now()
      requestAnimationFrame(() => probe.samples.push({ key, frame: performance.now() - key }))
    },
    true,
  )
}

const percentile = (values: number[], fraction: number): number =>
  [...values].sort((left, right) => left - right)[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? 0

const measure = async (page: Page, from: number, to: number) =>
  page.evaluate(
    ([start, end]) => {
      const probe = (window as unknown as { streamingProbe: Probe }).streamingProbe
      return {
        frames: probe.samples
          .filter((sample) => sample.key >= start && sample.key <= end)
          .map((sample) => sample.frame),
        tasks: probe.longTasks.filter((task) => task.start >= start && task.start <= end).map((task) => task.duration),
      }
    },
    [from, to] as const,
  )

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`typing stays responsive while a long answer streams at ${viewport.width}px`, async ({ page }, info) => {
    await page.setViewportSize(viewport)
    await page.addInitScript(installProbe)
    await page.goto("/test/e2e/streaming-typing-harness.html")
    const input = page.getByRole("textbox", { name: "Mensagem para mark", exact: true })
    await expect(input).toBeVisible()
    const cdp = await page.context().newCDPSession(page)
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 2 })
    await input.click()

    const idleStart = await page.evaluate(() => performance.now())
    await input.pressSequentially("Rascunho parado ", { delay: 40 })
    const idleEnd = await page.evaluate(() => performance.now())

    const profiling = Boolean(process.env.TOURI_STREAM_PROFILE)
    if (profiling) {
      await cdp.send("Profiler.enable")
      await cdp.send("Profiler.start")
    }
    const streamStart = await page.evaluate(() => performance.now())
    const streamed = page.evaluate(() =>
      (window as unknown as { streamingTyping: { stream: () => Promise<void> } }).streamingTyping.stream(),
    )
    await page.getByText("Aqui está o roteiro fictício completo").waitFor()
    await input.pressSequentially("enquanto o texto chega a pessoa continua escrevendo sem pausa ", { delay: 40 })
    if (process.env.TOURI_SCREENSHOT_DIR && (await page.getByText(/Etapa 60:/).count()) === 0)
      await page.screenshot({ path: `${process.env.TOURI_SCREENSHOT_DIR}/streaming-midway-${viewport.width}.png` })
    await streamed
    const streamEnd = await page.evaluate(() => performance.now())
    if (profiling) {
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
      await writeFile(info.outputPath("profile-top.json"), JSON.stringify(top, null, 1))
      await writeFile(
        `${process.env.TOURI_STREAM_PROFILE}/profile-${viewport.width}.json`,
        JSON.stringify(top, null, 1),
      )
    }

    await expect(input).toHaveValue("Rascunho parado enquanto o texto chega a pessoa continua escrevendo sem pausa ")
    await expect(page.locator('[data-message-id="stream-reply"]')).toContainText("Etapa 60")
    const idle = await measure(page, idleStart, idleEnd)
    const streaming = await measure(page, streamStart, streamEnd)
    const result = {
      idleFrameP99: percentile(idle.frames, 0.99),
      streamingFrameP99: percentile(streaming.frames, 0.99),
      streamingLongTasks: streaming.tasks.length,
      streamingLongestTask: Math.max(0, ...streaming.tasks),
      streamingTaskMs: streaming.tasks.reduce((sum, value) => sum + value, 0),
      durationMs: streamEnd - streamStart,
    }
    console.log(`streaming-typing ${viewport.width}: ${JSON.stringify(result)}`)
    await writeFile(info.outputPath("metrics.json"), JSON.stringify(result))
    if (process.env.TOURI_SCREENSHOT_DIR)
      await page.screenshot({ path: `${process.env.TOURI_SCREENSHOT_DIR}/streaming-typing-${viewport.width}.png` })
  })
}
