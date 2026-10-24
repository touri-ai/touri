import { writeFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"

test.use({ channel: "chromium", reducedMotion: "reduce" })
test.setTimeout(120_000)

type Counts = { enabled: boolean; commits: number; bubbleRenders: number; longTasks: number[]; frames: number[] }
type StreamingWindow = Window & {
  streamingCounts: Counts
  streamingTyping: { stream: () => Promise<void> }
}

/** Counts message bubble renders per React commit; reused fibers are skipped without walking them. */
const installCounter = () => {
  type Fiber = {
    flags: number
    type?: { name?: string; type?: { name?: string } } | string | (() => unknown)
    child: Fiber | null
    sibling: Fiber | null
    alternate: Fiber | null
  }
  const counts: Counts = { enabled: false, commits: 0, bubbleRenders: 0, longTasks: [], frames: [] }
  const seen = new WeakMap<Fiber, Fiber>()
  const getFiberName = (type: Fiber["type"]): string | undefined => {
    if (typeof type === "function") return type.name
    if (typeof type === "object") return type?.name ?? type?.type?.name

    return undefined
  }
  Object.assign(window, {
    streamingCounts: counts,
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
            if (typeof type === "function" && /^MessageBubble(?:Row)?$/.test(name ?? "") && (fiber.flags & 1) !== 0)
              bubbles += 1
            visit(fiber.child)
          }
          visit(fiber.sibling)
        }
        visit(root.current)
        if (!counts.enabled || bubbles === 0) return
        counts.commits += 1
        counts.bubbleRenders += bubbles
      },
    },
  })
  new PerformanceObserver((list) => {
    if (counts.enabled) for (const entry of list.getEntries()) counts.longTasks.push(entry.duration)
  }).observe({ entryTypes: ["longtask"] })
  document.addEventListener(
    "keydown",
    (event) => {
      if (!counts.enabled || !(event.target instanceof HTMLTextAreaElement) || event.key.length !== 1) return
      const start = performance.now()
      requestAnimationFrame(() => counts.frames.push(performance.now() - start))
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
  test(`a streaming reply re-renders only itself in a long conversation at ${viewport.width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize(viewport)
    page.on("pageerror", (error) => console.log(`pageerror: ${error.message}`))
    page.on("console", (message) => {
      if (message.type() === "error") console.log(`console: ${message.text().slice(0, 300)}`)
    })
    await page.addInitScript(installCounter)
    await page.goto("/test/e2e/streaming-typing-harness.html?history=realistic")
    const input = page.getByRole("textbox", { name: "Mensagem para mark", exact: true })
    await expect(input).toBeVisible()
    await expect(page.getByText("Pergunta 12", { exact: true })).toBeVisible()
    await input.click()
    await page.evaluate(() => {
      const probe = (window as StreamingWindow).streamingCounts
      probe.enabled = true
    })

    const streamed = page.evaluate(() => (window as StreamingWindow).streamingTyping.stream())
    await page.getByText("Aqui está o roteiro fictício completo").waitFor()
    await input.pressSequentially("o rascunho continua enquanto a resposta chega ", { delay: 40 })
    await streamed
    if (process.env.TOURI_SCREENSHOT_DIR)
      await page.screenshot({ path: `${process.env.TOURI_SCREENSHOT_DIR}/streaming-history-${viewport.width}.png` })
    const counts = await page.evaluate(() => {
      const value = (window as StreamingWindow).streamingCounts
      value.enabled = false
      return value
    })
    const result = {
      commits: counts.commits,
      bubbleRendersPerCommit: counts.bubbleRenders / Math.max(1, counts.commits),
      longTasks: counts.longTasks.length,
      longestTask: Math.max(0, ...counts.longTasks),
      longTaskMs: counts.longTasks.reduce((sum, value) => sum + value, 0),
      inputFrameP99: getPercentile(counts.frames, 0.99),
    }
    console.log(`streaming-history ${viewport.width}: ${JSON.stringify(result)}`)
    await writeFile(info.outputPath("metrics.json"), JSON.stringify(result))

    await expect(input).toHaveValue("o rascunho continua enquanto a resposta chega ")
    const reply = page.locator('[data-message-id="stream-reply"]')
    await expect(reply).toContainText("Etapa 60")
    await reply.getByRole("button", { name: "Mostrar mais", exact: true }).click()
    await expect(reply.locator("ol > li")).toHaveCount(60)
    await expect(reply.locator("tbody > tr")).toHaveCount(8)
    await expect(reply).toContainText("Cidade 8")
    // Earlier messages keep their props while one reply streams; only the streaming row renders again.
    expect(result.commits).toBeGreaterThan(10)
    expect(result.bubbleRendersPerCommit).toBeLessThan(3)
  })
}
