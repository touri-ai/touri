import { readFile, writeFile } from "node:fs/promises"
import { expect, type Page, type TestInfo, test } from "@playwright/test"
import type * as CodeVisibility from "../../src/components/codeVisibility"

test.use({ channel: "chromium", trace: "off", viewport: { width: 1440, height: 900 } })

test("streaming eight long replies keeps allocation work bounded", async ({ page, context }, testInfo) => {
  test.setTimeout(180_000)
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/test/e2e/streaming-memory-harness.html")
  await expect(page.locator(".composer-island textarea")).toBeVisible({ timeout: 30_000 })
  await expect(page.locator(".markdown-code .shiki")).toHaveCount(12, { timeout: 30_000 })
  const browser = context.browser()
  if (!browser) throw new Error("Missing fixture browser")
  const browserCdp = await browser.newBrowserCDPSession()
  const { processInfo } = await browserCdp.send("SystemInfo.getProcessInfo")
  const rendererIds = processInfo.filter((entry) => entry.type === "renderer").map((entry) => entry.id)
  const cdp = await context.newCDPSession(page)
  await cdp.send("HeapProfiler.enable")
  await cdp.send("HeapProfiler.collectGarbage")
  const initial = await cdp.send("Runtime.getHeapUsage")
  await cdp.send("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  })
  await page.evaluate(() => window.dispatchEvent(new Event("start-streaming-fixture")))

  const outputBytes = await page.evaluate(() => Number(document.documentElement.dataset.streamingOutputBytes))
  const phase = process.env.TOURI_STREAM_PHASE ?? "after"
  const started = Date.now()
  // Keep protocol sampling state local; never force GC during the measured stream.
  const samples = []
  let streamingCaptured = false
  let completedAt: number | null = null
  while (Date.now() - started < 150_000) {
    const heap = await cdp.send("Runtime.getHeapUsage")
    const elapsedMs = Date.now() - started
    const complete = await page.evaluate(() => document.documentElement.dataset.streamingDone === "true")
    const progress = await page.evaluate(() => Number(document.documentElement.dataset.streamingProgress ?? 0))
    if (!streamingCaptured && !complete && progress >= 0.4) {
      await attachScreenshot(page, testInfo, `${phase}-streaming`)
      streamingCaptured = true
    }
    const residentBytes = await getRendererResidentBytes(rendererIds)
    samples.push({ elapsedMs, usedBytes: heap.usedSize, totalBytes: heap.totalSize, residentBytes })
    if (complete && completedAt === null) completedAt = elapsedMs
    if (completedAt !== null && elapsedMs - completedAt >= 2000) break

    await page.waitForTimeout(50)
  }
  const { profile } = await cdp.send("HeapProfiler.stopSampling")
  await cdp.send("HeapProfiler.collectGarbage")
  const retained = await cdp.send("Runtime.getHeapUsage")
  const getAllocations = (node: typeof profile.head): Array<{ name: string; file: string; bytes: number }> => [
    {
      name: node.callFrame.functionName,
      file: node.callFrame.url.replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, ""),
      bytes: node.selfSize,
    },
    ...node.children.flatMap(getAllocations),
  ]
  const allocations = getAllocations(profile.head).toSorted((left, right) => right.bytes - left.bytes)
  const result = {
    phase,
    outputBytes,
    bots: 8,
    intervalMs: 20,
    completedAtMs: completedAt,
    durationMs: Date.now() - started,
    initialBytes: initial.usedSize,
    peakBytes: Math.max(...samples.map((sample) => sample.usedBytes)),
    retainedBytes: retained.usedSize,
    peakTotalBytes: Math.max(...samples.map((sample) => sample.totalBytes)),
    peakResidentBytes:
      process.platform === "linux" ? Math.max(...samples.map((sample) => sample.residentBytes ?? 0)) : null,
    sampledAllocationBytes: allocations.reduce((total, allocation) => total + allocation.bytes, 0),
    topAllocations: allocations.slice(0, 15),
    samples,
  }
  await writeFile(testInfo.outputPath("streaming-memory.json"), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ ...result, samples: undefined }))

  expect(streamingCaptured).toBe(true)
  expect(result.completedAtMs).not.toBeNull()
  await page.getByRole("button", { name: "Mostrar mais", exact: true }).last().click()
  await expect(page.getByRole("heading", { name: "Etapa 90", exact: true })).toBeVisible()
  await expect(page.locator(".chat-long-content .disclosure-content .markdown-code .shiki").first()).toBeVisible()
  await page.getByRole("heading", { name: "Etapa 1", exact: true }).last().scrollIntoViewIfNeeded()
  await attachScreenshot(page, testInfo, `${phase}-completed`)

  // Normalize cumulative work to delivered UTF-8 bytes, rather than a GC-dependent heap peak.
  // 32 KiB allocated per output byte leaves runtime headroom but rejects rebuilding the whole reply per delta.
  expect(outputBytes).toBeGreaterThan(0)
  expect(result.sampledAllocationBytes / outputBytes).toBeLessThan(32 * 1024)
})

test("code visibility resumes after an edge-only intersection", async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto("/test/e2e/streaming-memory-harness.html")
  await page.evaluate(async () => {
    const source = "/src/components/codeVisibility.ts"
    const visibility: typeof CodeVisibility = await import(source)
    const probe = document.createElement("div")
    probe.id = "code-visibility-probe"
    probe.dataset.ready = "false"
    probe.style.cssText = `position:fixed;left:0;top:${window.innerHeight + 160}px;width:100px;height:100px`
    document.body.append(probe)
    visibility.observeCodeVisibility(probe, () => {
      probe.dataset.ready = "true"
    })
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  })

  await expect(page.locator("#code-visibility-probe")).toHaveAttribute("data-ready", "false")
  await page.evaluate(() => {
    const probe = document.getElementById("code-visibility-probe")
    if (!probe) return

    probe.style.top = `${window.innerHeight + 159}px`
  })

  await expect(page.locator("#code-visibility-probe")).toHaveAttribute("data-ready", "true")
})

const getRendererResidentBytes = async (rendererIds: number[]): Promise<number | null> => {
  if (process.platform !== "linux") return null
  const statuses = await Promise.all(rendererIds.map((id) => readFile(`/proc/${id}/status`, "utf8").catch(() => "")))

  return statuses.reduce((bytes, status) => bytes + Number(/^VmRSS:\s+(\d+)\s+kB/m.exec(status)?.[1] ?? 0) * 1024, 0)
}

const attachScreenshot = async (page: Page, testInfo: TestInfo, name: string) => {
  const screenshot = testInfo.outputPath(`${name}.png`)

  await page.screenshot({ path: screenshot, clip: { x: 0, y: 0, width: 1440, height: 760 } })
  await testInfo.attach(name, { path: screenshot, contentType: "image/png" })
}
