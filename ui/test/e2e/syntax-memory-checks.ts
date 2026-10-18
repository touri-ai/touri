import { writeFile } from "node:fs/promises"
import { type CDPSession, expect, type Page, test } from "@playwright/test"

const sampleTimes = (process.env.TOURI_SYNTAX_SAMPLE_MS ?? "1000").split(",").map(Number)
const phase = process.env.TOURI_SYNTAX_PHASE ?? "after"

const viewports = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]

viewports.forEach((viewport) => {
  test(`code highlighting releases native buffers (${viewport.width})`, async ({ page, context }, testInfo) => {
    test.setTimeout(Math.max(...sampleTimes) + 60_000)
    await context.grantPermissions(["clipboard-read", "clipboard-write"])
    await page.setViewportSize(viewport)
    await page.emulateMedia({ reducedMotion: "reduce" })

    await page.goto(`${process.env.TOURI_SYNTAX_ORIGIN ?? ""}/test/e2e/syntax-memory-harness.html`)
    await expect(page.locator(".markdown-highlight .shiki")).toHaveCount(30, { timeout: 30_000 })
    await expect(page.locator('.markdown-highlight span[style*="--syntax-"]')).not.toHaveCount(0)
    const block = page.locator(".markdown-code").last()
    const source = await block.locator("code").innerText()
    await block.getByRole("button", { name: "Copiar código" }).click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(source)
    await expect(block.getByRole("status")).toHaveText("Código copiado")
    await page.evaluate(() => document.fonts.ready)
    const screenshot = testInfo.outputPath(`${phase}-${viewport.width}.png`)
    await page.screenshot({ path: screenshot })
    await testInfo.attach(`${phase}-${viewport.width}`, { path: screenshot, contentType: "image/png" })

    const cdp = await context.newCDPSession(page)
    await cdp.send("HeapProfiler.enable")
    const samples = await getMemorySamples(page, cdp, viewport.width === 1440 ? sampleTimes : [1000])
    await writeFile(
      testInfo.outputPath("composer-performance.json"),
      JSON.stringify({ phase, viewport, samples }, null, 2),
    )

    samples.forEach((sample) => {
      expect(sample.nativeArrayBufferBytes).toBeLessThan(8 * 1024 * 1024)
    })
    await page.goto("about:blank")
    await cdp.send("HeapProfiler.collectGarbage")
    const closed = await getNativeBuffers(cdp)
    expect(closed.nativeArrayBufferBytes).toBeLessThan(8 * 1024 * 1024)
  })
})

type NativeBuffers = { nativeArrayBufferBytes: number; largestNativeArrayBufferBytes: number }
type MemorySample = NativeBuffers & { elapsedMs: number; usedSize: number; backingStorageSize: number; nodes: number }

const getMemorySamples = (page: Page, cdp: CDPSession, times: number[]): Promise<MemorySample[]> => {
  const started = Date.now()

  return times.reduce(async (pending, elapsed) => {
    const samples = await pending
    await page.waitForTimeout(Math.max(0, elapsed - (Date.now() - started)))
    await cdp.send("HeapProfiler.collectGarbage")
    const heap = await cdp.send("Runtime.getHeapUsage")
    const dom = await cdp.send("Memory.getDOMCounters")
    const buffers = await getNativeBuffers(cdp)

    return [...samples, { elapsedMs: Date.now() - started, ...heap, ...buffers, nodes: dom.nodes }]
  }, Promise.resolve<MemorySample[]>([]))
}

type HeapSnapshot = {
  snapshot: { meta: { node_fields: string[] } }
  strings: string[]
  nodes: number[]
}

const getNativeBuffers = async (cdp: CDPSession): Promise<NativeBuffers> => {
  // Snapshot chunks arrive through a protocol callback; keep the streaming state local.
  let serialized = ""
  const append = ({ chunk }: { chunk: string }) => {
    serialized += chunk
  }
  cdp.on("HeapProfiler.addHeapSnapshotChunk", append)
  await cdp.send("HeapProfiler.takeHeapSnapshot")
  cdp.off("HeapProfiler.addHeapSnapshotChunk", append)
  const { snapshot, strings, nodes }: HeapSnapshot = JSON.parse(serialized)
  const fields = snapshot.meta.node_fields
  const name = fields.indexOf("name")
  const size = fields.indexOf("self_size")

  // Avoid allocating an object for every node in a multi-megabyte snapshot.
  let nativeArrayBufferBytes = 0
  let largestNativeArrayBufferBytes = 0
  for (let index = 0; index < nodes.length; index += fields.length) {
    if (strings[nodes[index + name] ?? -1] !== "system / JSArrayBufferData") continue
    const bytes = nodes[index + size] ?? 0
    nativeArrayBufferBytes += bytes
    largestNativeArrayBufferBytes = Math.max(largestNativeArrayBufferBytes, bytes)
  }

  return { nativeArrayBufferBytes, largestNativeArrayBufferBytes }
}
