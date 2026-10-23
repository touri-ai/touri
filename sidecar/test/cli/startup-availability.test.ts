import { expect, mock, test } from "bun:test"
import { createStartupAvailability } from "../../src/cli/startupAvailability"

const getRequest = (path: string) => {
  const url = new URL(path, "http://127.0.0.1:18795")
  return { request: new Request(url), url, clientIp: "127.0.0.1" }
}

test.each(["/api/v1/health", "/api/v1/ws-ticket", "/api/v1/events", "/api/v1/threads/thread/messages"])(
  "startup refuses %s until all API modules are ready",
  async (path) => {
    const dispatch = mock(async () => null)
    const availability = createStartupAvailability(dispatch)

    const response = await availability.intercept(getRequest(path))

    expect(response?.status).toBe(503)
    expect(response?.headers.get("Retry-After")).toBe("1")
    expect(response?.headers.get("Cache-Control")).toBe("no-store")
    expect(await response?.json()).toEqual({ code: "TOURI-E1009", errorCode: "SERVER_CONNECTION_FAILED" })
    expect(dispatch).not.toHaveBeenCalled()
  },
)

test("the initial page still loads while its API connection retries", async () => {
  const dispatch = mock(async () => new Response("Synthetic pairing page"))
  const availability = createStartupAvailability(dispatch)

  const response = await availability.intercept(getRequest("/pair"))

  expect(await response?.text()).toBe("Synthetic pairing page")
  expect(dispatch).toHaveBeenCalledTimes(1)
})

test("ready requests still pass through existing authentication", async () => {
  const dispatch = mock(async () => new Response(null, { status: 401 }))
  const availability = createStartupAvailability(dispatch)
  availability.markReady()

  const response = await availability.intercept(getRequest("/api/v1/health"))

  expect(response?.status).toBe(401)
  expect(dispatch).toHaveBeenCalledTimes(1)
})
