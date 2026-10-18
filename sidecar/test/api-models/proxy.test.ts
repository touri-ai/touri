import { expect, test } from "bun:test"
import { getApiError } from "../../src/api-models/client"
import { type ApiProxyFetch, forwardApiRequest } from "../../src/api-models/proxy"

const key = "fixture-private-api-key"
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
