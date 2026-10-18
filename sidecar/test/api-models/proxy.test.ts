import { afterEach, expect, test } from "bun:test"
import { getApiError } from "../../src/api-models/client"
import { type ApiProxyFetch, forwardApiRequest } from "../../src/api-models/proxy"

const key = "fixture-private-api-key"
const cleanups = new Set<() => void>()
afterEach(() => {
  cleanups.forEach((close) => {
    close()
  })
  cleanups.clear()
})

const getRequest = (token = "temporary-token") =>
  new Request("http://127.0.0.1/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "demo-model", messages: [] }),
  })

for (const [status, reason] of [
  [401, "invalid_key"],
  [402, "no_credit"],
  [404, "model_not_found"],
  [429, "rate_limit"],
] as const)
  test(`the private API transport discards credential echoes in HTTP ${status} errors`, async () => {
    const fetchImpl: ApiProxyFetch = async (_url, input) => {
      expect(new Headers(input?.headers).get("Authorization")).toBe(`Bearer ${key}`)
      expect(input?.redirect).toBe("error")
      expect(typeof input?.body).toBe("string")
      return Response.json({ error: { message: `Rejected credential ${key}` } }, { status })
    }

    const result = await forwardApiRequest(getRequest(), {
      baseUrl: "https://api.example.com/v1",
      key,
      token: "temporary-token",
      mapError: getApiError,
      fetchImpl,
    })

    expect(result.status).toBe(status)
    expect(await result.json()).toEqual({ error: { message: reason } })
  })

test("the private API transport removes credentials across response chunks and drops upstream headers", async () => {
  const encoder = new TextEncoder()
  const chunks = ["data: ", key.slice(0, 7), key.slice(7), "\n\ndata: [DONE]\n\n"]
  const fetchImpl: ApiProxyFetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          chunks.forEach((chunk) => {
            controller.enqueue(encoder.encode(chunk))
          })
          controller.close()
        },
      }),
      { headers: { "Content-Type": "text/event-stream", "X-Echo": key } },
    )

  const result = await forwardApiRequest(getRequest(), {
    baseUrl: "https://api.example.com/v1",
    key,
    token: "temporary-token",
    mapError: getApiError,
    fetchImpl,
  })
  const text = await result.text()

  expect(text).toBe("data: [REDACTED]\n\ndata: [DONE]\n\n")
  expect(JSON.stringify(Array.from(result.headers))).not.toContain(key)
})

test("a private transport token cannot be used as the provider credential", async () => {
  const fetchImpl: ApiProxyFetch = async () => {
    throw new Error("The upstream must not be called")
  }

  const result = await forwardApiRequest(getRequest("wrong-token"), {
    baseUrl: "https://api.example.com/v1",
    key,
    token: "temporary-token",
    mapError: getApiError,
    fetchImpl,
  })

  expect(result.status).toBe(403)
})

test("streamed model replies preserve Unicode at the credential buffer boundary", async () => {
  const reply = `🙂${"x".repeat(key.length - 1)}`
  const fetchImpl: ApiProxyFetch = async () => new Response(reply)

  const result = await forwardApiRequest(getRequest(), {
    baseUrl: "https://api.example.com/v1",
    key,
    token: "temporary-token",
    mapError: getApiError,
    fetchImpl,
  })

  expect(await result.text()).toBe(reply)
})

test.each([
  [16, 256],
  [32, 256],
  [32, 32 * 1024 * 1024],
] as const)(
  "the private transport keeps timers responsive during a %i MiB stream in %i byte chunks",
  async (streamMiB, chunkBytes) => {
    const totalBytes = streamMiB * 1024 * 1024
    const chunk = new TextEncoder().encode(`data: ${"x".repeat(chunkBytes - 8)}\n\n`)
    const fetchImpl: ApiProxyFetch = async () =>
      new Response(getSyntheticStream(chunk, totalBytes / chunkBytes), {
        headers: { "Content-Type": "text/event-stream" },
      })
    const response = await forwardApiRequest(getRequest(), {
      baseUrl: "https://api.example.com/v1",
      key,
      token: "temporary-token",
      mapError: getApiError,
      fetchImpl,
    })
    if (!response.body) throw new Error("The synthetic stream is missing")

    const measurement = await getStreamMeasurement(response.body)

    console.info(JSON.stringify(Object.assign({ chunkBytes }, measurement)))
    expect(measurement.bytes).toBe(totalBytes)
    expect(measurement.ticks).toBeGreaterThan(0)
    expect(measurement.longestPauseMs).toBeLessThan(100)
  },
)

test("empty upstream chunks still let timers run during private transport streaming", async () => {
  const fetchImpl: ApiProxyFetch = async () => new Response(getSyntheticStream(new Uint8Array(), 65_536))
  const response = await forwardApiRequest(getRequest(), {
    baseUrl: "https://api.example.com/v1",
    key,
    token: "temporary-token",
    mapError: getApiError,
    fetchImpl,
  })
  if (!response.body) throw new Error("The synthetic stream is missing")

  const measurement = await getStreamMeasurement(response.body)

  expect(measurement.bytes).toBe(0)
  expect(measurement.ticks).toBeGreaterThan(0)
  expect(measurement.longestPauseMs).toBeLessThan(100)
})

test.each([
  ["raw", (value: string) => value],
  ["URL-encoded", encodeURIComponent],
  ["JSON-escaped", (value: string) => JSON.stringify(value).slice(1, -1)],
] as const)(
  "the private transport redacts every byte split of a %s credential echo",
  async (_name, getRepresentation) => {
    const credential = 'fixture/"private\\key-ç'
    const echo = new TextEncoder().encode(getRepresentation(credential))
    const boundaries = Array.from({ length: echo.byteLength + 1 }, (_, index) => index)

    for (const boundary of boundaries) {
      const fetchImpl: ApiProxyFetch = async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(echo.subarray(0, boundary))
              controller.enqueue(echo.subarray(boundary))
              controller.close()
            },
          }),
        )
      const response = await forwardApiRequest(getRequest(), {
        baseUrl: "https://api.example.com/v1",
        key: credential,
        token: "temporary-token",
        mapError: getApiError,
        fetchImpl,
      })

      expect(await response.text()).toBe("[REDACTED]")
    }
  },
)

test.each([16_383, 16_374])(
  "the private transport preserves Unicode and credential echoes after a %i byte prefix",
  async (prefixBytes) => {
    const prefix = "x".repeat(prefixBytes)
    const reply = `${prefix}🙂${key}${"y".repeat(16_384)}🙂`
    const fetchImpl: ApiProxyFetch = async () => new Response(reply)

    const response = await forwardApiRequest(getRequest(), {
      baseUrl: "https://api.example.com/v1",
      key,
      token: "temporary-token",
      mapError: getApiError,
      fetchImpl,
    })

    expect(await response.text()).toBe(reply.replaceAll(key, "[REDACTED]"))
  },
)

const getSyntheticStream = (chunk: Uint8Array, chunks: number) => {
  // The source counter is local to this stream and never buffers the whole reply.
  let remaining = chunks
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (remaining === 0) return controller.close()

      controller.enqueue(chunk)
      remaining -= 1
    },
  })
}

const getStreamMeasurement = async (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader()
  const started = performance.now()
  // Local counters observe timer starvation while the response is being consumed.
  let previous = started
  let longestPauseMs = 0
  let ticks = 0
  let bytes = 0
  const timer = setInterval(() => {
    const now = performance.now()
    longestPauseMs = Math.max(longestPauseMs, now - previous)
    previous = now
    ticks += 1
  }, 5)
  cleanups.add(() => clearInterval(timer))
  cleanups.add(() => reader.releaseLock())

  while (true) {
    const result = await reader.read()
    if (result.done) break

    bytes += result.value.byteLength
  }

  const finished = performance.now()
  return {
    bytes,
    elapsedMs: finished - started,
    longestPauseMs: Math.max(longestPauseMs, finished - previous),
    ticks,
  }
}
