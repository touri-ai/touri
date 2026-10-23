import { afterEach, expect, test, vi } from "vitest"
import { createApiClient } from "../src/api/client"

const cleanups = new Set<() => void>()
afterEach(() => {
  cleanups.forEach((cleanup) => {
    cleanup()
  })
  cleanups.clear()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test("reconnect delays remain below one second during a long outage and replay the cursor", async () => {
  const fixture = makeClient()
  await vi.advanceTimersByTimeAsync(0)
  const socket = fixture.getSocket(0)
  socket.dispatchEvent(new Event("open"))
  socket.dispatchEvent(
    new MessageEvent("message", {
      data: JSON.stringify({ seq: 1, at: 1, event: { type: "import.progress", phase: "done", done: 1, total: 1 } }),
    }),
  )
  socket.dispatchEvent(new Event("close"))

  for (const delay of [250, 500, 1000, 1000, 1000, 1000]) {
    const count = fixture.getSocketCount()
    await vi.advanceTimersByTimeAsync(delay - 1)
    expect(fixture.getSocketCount()).toBe(count)
    await vi.advanceTimersByTimeAsync(1)
    const next = fixture.getSocket(count)
    expect(new URL(next.url).searchParams.get("since")).toBe("1")
    next.dispatchEvent(new Event("close"))
  }

  expect(fixture.getSocketCount()).toBe(7)
})

test.each(["online", "visibilitychange"])(
  "%s retries immediately and unsubscribing removes recovery listeners",
  async (event) => {
    const fixture = makeClient()
    await vi.advanceTimersByTimeAsync(0)
    fixture.getSocket(0).dispatchEvent(new Event("open"))
    fixture.getSocket(0).dispatchEvent(new Event("close"))
    const target = event === "online" ? window : document

    target.dispatchEvent(new Event(event))
    await vi.advanceTimersByTimeAsync(0)

    expect(fixture.getSocketCount()).toBe(2)
    fixture.stop()
    target.dispatchEvent(new Event(event))
    await vi.advanceTimersByTimeAsync(5000)
    expect(fixture.getSocketCount()).toBe(2)
  },
)

test("a socket stalled during its handshake is replaced after one second", async () => {
  const fixture = makeClient()
  await vi.advanceTimersByTimeAsync(0)

  await vi.advanceTimersByTimeAsync(1250)

  expect(fixture.getSocket(0).close).toHaveBeenCalledOnce()
  expect(fixture.getSocketCount()).toBe(2)
})

test("resubscribing while an aborted connection settles still starts the new subscription", async () => {
  const fixture = makeClient()
  fixture.stop()
  cleanups.add(fixture.api.subscribe(vi.fn()))

  await vi.advanceTimersByTimeAsync(250)

  expect(fixture.getSocketCount()).toBe(1)
})

test("an incompatible protocol reports the update state without opening another socket", async () => {
  const fixture = makeClient()
  await vi.advanceTimersByTimeAsync(0)
  fixture.getSocket(0).dispatchEvent(new Event("open"))
  fixture.fetchImpl.mockResolvedValue(Response.json({ ok: true, schemaVersion: 99, protocolVersion: 2 }))

  fixture.getSocket(0).dispatchEvent(new Event("close"))
  await vi.advanceTimersByTimeAsync(250)

  expect(fixture.connection).toHaveBeenLastCalledWith(false, "SERVER_VERSION_MISMATCH")
  expect(fixture.getSocketCount()).toBe(1)
  const reads = fixture.fetchImpl.mock.calls.length
  await expect(fixture.api.request("POST /threads", { botId: "blocked" })).rejects.toMatchObject({
    errorCode: "SERVER_VERSION_MISMATCH",
  })
  await expect(fixture.api.uploadAttachment?.(new File(["Synthetic"], "fixture.txt"))).rejects.toMatchObject({
    errorCode: "SERVER_VERSION_MISMATCH",
  })
  expect(fixture.fetchImpl).toHaveBeenCalledTimes(reads)
})

const makeClient = () => {
  vi.useFakeTimers()
  const sockets = new Map<number, Socket>()
  // The fake records browser-owned socket creation and closure at the transport boundary.
  class Socket extends EventTarget {
    close = vi.fn()
    constructor(public url: string) {
      super()
      sockets.set(sockets.size, this)
    }
  }
  vi.stubGlobal("WebSocket", Socket)
  const fetchImpl = vi.fn(async () =>
    Response.json({ ok: true, schemaVersion: 46, protocolVersion: 1, ticket: "fixture" }),
  )
  const api = createApiClient({
    endpoint: { baseUrl: "https://server.example", wsUrl: "wss://server.example/api/v1/events", token: "" },
    fetchImpl,
  })
  const connection = vi.fn()
  api.subscribeConnection?.(connection)
  const stop = api.subscribe(vi.fn())
  cleanups.add(stop)
  return {
    api,
    stop,
    fetchImpl,
    connection,
    getSocketCount: () => sockets.size,
    getSocket: (index: number): Socket => {
      const socket = sockets.get(index)
      if (!socket) throw new Error(`Socket ${index} is not available`)
      return socket
    },
  }
}
