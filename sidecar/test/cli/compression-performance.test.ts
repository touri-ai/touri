import { afterEach, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { setImmediate } from "node:timers/promises"
import { compressBufferedResponse, compressedVariants } from "../../src/cli/web/compression"

const cleanups = new Set<() => void>()

afterEach(() => {
  cleanups.forEach((close) => {
    close()
  })
  cleanups.clear()
})

test.each(["embedded", "directory"])("%s startup compression keeps the request loop responsive", async (source) => {
  const bytes = new TextEncoder().encode(randomBytes(768 * 1024).toString("base64"))
  const request = new Request("https://app.example.test/assets/startup.js", {
    headers: { "Accept-Encoding": "br" },
  })
  const probe = startLoopProbe()
  const getCompressed = async () => {
    if (source === "embedded") return compressedVariants(bytes)

    const response = await compressBufferedResponse(
      request,
      new Response(bytes, { headers: { "Content-Type": "text/javascript" } }),
    )

    expect(response.headers.get("content-encoding")).toBe("br")
    return response.arrayBuffer()
  }
  await setImmediate()

  await Promise.all(Array.from({ length: 24 }, getCompressed))
  await setImmediate()

  const timing = probe.getTiming()
  console.info(JSON.stringify({ source, bytes: bytes.byteLength, concurrency: 24, intervalMs: 1, timing }))
  expect(timing.p99Ms).toBeLessThan(50)
  expect(timing.maxMs).toBeLessThan(200)
  expect(timing.samples).toBeGreaterThan(10)
})

const startLoopProbe = () => {
  // Only this bounded measurement callback owns mutable timer samples.
  const samples: number[] = []
  let previous = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    samples.push(Math.max(0, now - previous - 1))
    previous = now
  }, 1)
  cleanups.add(() => clearInterval(timer))

  return {
    getTiming: () => {
      const sorted = samples.slice().sort((left, right) => left - right)

      return {
        samples: sorted.length,
        p99Ms: sorted[Math.floor(sorted.length * 0.99)] ?? 0,
        maxMs: sorted.at(-1) ?? 0,
      }
    },
  }
}
