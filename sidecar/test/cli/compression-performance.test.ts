import { afterEach, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { setImmediate } from "node:timers/promises"
import { brotliDecompressSync } from "node:zlib"
import { compressBufferedResponse, compressedVariants, createCompressionRunner } from "../../src/cli/web/compression"
import { createCompressionClient } from "../../src/cli/web/compression-client"

const cleanups = new Set<() => void>()

afterEach(() => {
  cleanups.forEach((close) => {
    close()
  })
  cleanups.clear()
})

test("worker startup failure preserves the original response bytes", async () => {
  const client = createCompressionClient({
    createWorker: () => {
      throw new Error("synthetic worker startup failure")
    },
  })
  cleanups.add(client.close)
  const bytes = new TextEncoder().encode("Synthetic response")

  const result = await client.run(bytes, "br")

  expect(result).toBe(bytes)
  expect(new TextDecoder().decode(bytes)).toBe("Synthetic response")
})

test("closing active compression preserves bytes and permits the next request", async () => {
  const held = URL.createObjectURL(new Blob(["self.onmessage = () => {}"], { type: "application/javascript" }))
  cleanups.add(() => {
    URL.revokeObjectURL(held)
  })
  let created = 0
  const client = createCompressionClient({
    createWorker: (url) => {
      created += 1

      return new Worker(created === 1 ? held : url, { smol: true, ref: false })
    },
  })
  cleanups.add(client.close)
  const bytes = new TextEncoder().encode("Synthetic response. ".repeat(100))
  const pending = client.run(bytes, "br")

  client.close()
  const canceled = await pending
  const compressed = await client.run(bytes, "br")

  expect(canceled).toBe(bytes)
  expect(created).toBe(2)
  expect(new Uint8Array(brotliDecompressSync(compressed))).toEqual(bytes)
})

test("compression admission bounds retained bytes until native work finishes", async () => {
  const run = createCompressionRunner()
  const held = Promise.withResolvers<number>()
  const first = run(64 * 1024 * 1024, () => held.promise)

  expect(run(1, () => Promise.resolve(2))).toBeNull()
  held.resolve(1)
  expect(await first).toBe(1)

  expect(await run(64 * 1024 * 1024, () => Promise.resolve(2))).toBe(2)
})

test("compression admission bounds waiting jobs and recovers capacity", async () => {
  const run = createCompressionRunner()
  const held = Promise.withResolvers<number>()
  const jobs = Array.from({ length: 64 }, () => run(1, () => held.promise))

  expect(run(1, () => Promise.resolve(2))).toBeNull()
  held.resolve(1)
  await Promise.all(jobs)

  expect(await run(1, () => Promise.resolve(2))).toBe(2)
})

test("failed native compression releases admission and does not block later work", async () => {
  const run = createCompressionRunner()
  const first = run(64 * 1024 * 1024, () => Promise.reject(new Error("synthetic compression failure")))

  await expect(first).rejects.toThrow("synthetic compression failure")

  expect(await run(64 * 1024 * 1024, () => Promise.resolve(2))).toBe(2)
})

test("saturated HTTP compression preserves identity bodies and encoding headers", async () => {
  const body = "synthetic response content\n".repeat(150)
  const request = new Request("https://app.example.test/large-response", { headers: { "Accept-Encoding": "br" } })
  const getResponse = () =>
    compressBufferedResponse(request, new Response(body, { headers: { "Content-Type": "text/plain" } }))

  const responses = await Promise.all(Array.from({ length: 65 }, getResponse))
  const contents = await Promise.all(
    responses.map(async (response) => {
      const bytes = new Uint8Array(await response.arrayBuffer())
      const decoded = response.headers.has("content-encoding") ? brotliDecompressSync(bytes) : bytes

      return new TextDecoder().decode(decoded)
    }),
  )

  expect(responses.some((response) => !response.headers.has("content-encoding"))).toBe(true)
  expect(contents.every((content) => content === body)).toBe(true)
  expect(responses.every((response) => response.headers.get("vary") === "Accept-Encoding")).toBe(true)
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
