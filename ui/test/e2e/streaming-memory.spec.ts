import { execFile } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { promisify } from "node:util"
import { expect, test } from "@playwright/test"

test.use({ channel: "chromium", trace: "off", viewport: { width: 1440, height: 900 } })

test("streaming eight long replies keeps allocation work bounded", async ({ page, context }, testInfo) => {
  test.setTimeout(240_000)
  await promisify(execFile)("bun", ["--cwd", "ui", "build"], { cwd: resolve(import.meta.dirname, "../../..") })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/test/e2e/streaming-memory-harness.html")
  await expect(page.locator(".composer-island textarea")).toBeVisible({ timeout: 30_000 })
  await expect(page.locator(".markdown-highlight .shiki")).toHaveCount(12, { timeout: 30_000 })
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
  // Samples are local to this capture; appending avoids copying the growing measurement series.
  const samples = []
  while (Date.now() - started < 15_000) {
    const heap = await cdp.send("Runtime.getHeapUsage")
    samples.push({ elapsedMs: Date.now() - started, usedBytes: heap.usedSize })
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
    initialBytes: initial.usedSize,
    peakBytes: Math.max(...samples.map((sample) => sample.usedBytes)),
    retainedBytes: retained.usedSize,
    sampledAllocationBytes: allocations.reduce((total, allocation) => total + allocation.bytes, 0),
    topAllocations: allocations.slice(0, 15),
    samples,
  }
  await writeFile(testInfo.outputPath("streaming-memory.json"), JSON.stringify(result, null, 2))
  const screenshot = testInfo.outputPath("streaming.png")
  await page.screenshot({ path: screenshot })
  await testInfo.attach("synthetic streaming", { path: screenshot, contentType: "image/png" })
  console.log(JSON.stringify({ ...result, samples: undefined }))

  await expect(page.locator("html")).toHaveAttribute("data-streaming-done", "true", { timeout: 30_000 })
  await page.getByRole("button", { name: "Mostrar mais", exact: true }).last().click()
  await expect(page.getByRole("heading", { name: "Etapa 90", exact: true })).toBeVisible()
  expect(result.peakBytes).toBeLessThan(160 * 1024 * 1024)
})
