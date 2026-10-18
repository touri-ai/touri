import { execFile } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { promisify } from "node:util"
import { expect, test } from "@playwright/test"

test.use({ channel: "chromium", trace: "off", viewport: { width: 1440, height: 900 } })

test("streaming eight long replies keeps allocation work bounded", async ({ page, context }, testInfo) => {
  test.setTimeout(480_000)
  await promisify(execFile)("bun", ["--cwd", "ui", "build"], { cwd: resolve(import.meta.dirname, "../../..") })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/test/e2e/streaming-memory-harness.html")
  await expect(page.locator(".composer-island textarea")).toBeVisible({ timeout: 30_000 })
  await expect(page.locator(".markdown-highlight .shiki")).toHaveCount(12, { timeout: 30_000 })
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

  const started = Date.now()
  const samples = []
  let completedAt: number | null = null
  while (Date.now() - started < 300_000) {
    const heap = await cdp.send("Runtime.getHeapUsage")
    const elapsedMs = Date.now() - started
    const complete = await page.evaluate(() => document.documentElement.dataset.streamingDone === "true")
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
    phase: process.env.TOURI_STREAM_PHASE ?? "after",
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
  const screenshot = testInfo.outputPath("streaming.png")
  await page.screenshot({ path: screenshot, clip: { x: 0, y: 0, width: 1440, height: 760 } })
  await testInfo.attach("synthetic streaming", { path: screenshot, contentType: "image/png" })
  console.log(JSON.stringify({ ...result, samples: undefined }))

  expect(result.completedAtMs).not.toBeNull()
  await page.getByRole("button", { name: "Mostrar mais", exact: true }).last().click()
  await expect(page.getByRole("heading", { name: "Etapa 90", exact: true })).toBeVisible()
  expect(result.peakBytes).toBeLessThan(160 * 1024 * 1024)
})

const getRendererResidentBytes = async (rendererIds: number[]): Promise<number | null> => {
  if (process.platform !== "linux") return null
  const statuses = await Promise.all(rendererIds.map((id) => readFile(`/proc/${id}/status`, "utf8").catch(() => "")))

  return statuses.reduce((bytes, status) => bytes + Number(/^VmRSS:\s+(\d+)\s+kB/m.exec(status)?.[1] ?? 0) * 1024, 0)
}
