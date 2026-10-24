import { afterEach, expect, test, vi } from "vitest"
import { createApiClient, type Endpoint } from "../src/api/client"

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

test("network recovery retries immediately even when the window is hidden", async () => {
  const fixture = makeClient()
  await vi.advanceTimersByTimeAsync(0)
  fixture.getSocket(0).dispatchEvent(new Event("open"))
  fixture.getSocket(0).dispatchEvent(new Event("close"))
  hideDocument()

  window.dispatchEvent(new Event("online"))
  await vi.advanceTimersByTimeAsync(0)

  expect(fixture.getSocketCount()).toBe(2)
})

test("hiding a healthy window keeps its connection open", async () => {
  const fixture = makeClient()
  await vi.advanceTimersByTimeAsync(0)
  const socket = fixture.getSocket(0)
  socket.dispatchEvent(new Event("open"))
  hideDocument()

  document.dispatchEvent(new Event("visibilitychange"))
  await vi.advanceTimersByTimeAsync(0)

  expect(socket.close).not.toHaveBeenCalled()
  expect(fixture.getSocketCount()).toBe(1)
})

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

test("status reports the current attempt and next retry, including to a late subscriber", async () => {
  const fixture = makeClient()
  await vi.advanceTimersByTimeAsync(0)
  fixture.getSocket(0).dispatchEvent(new Event("open"))

  fixture.getSocket(0).dispatchEvent(new Event("close"))

  expect(fixture.api.getConnectionStatus?.()).toEqual({
    state: "unavailable",
    attempt: 1,
    retryAt: Date.now() + 250,
  })
  const status = vi.fn()
  cleanups.add(fixture.api.subscribeConnectionStatus?.(status) ?? (() => undefined))
  expect(status).toHaveBeenLastCalledWith(fixture.api.getConnectionStatus?.())

  await vi.advanceTimersByTimeAsync(250)

  expect(status).toHaveBeenLastCalledWith({ state: "unavailable", attempt: 2, retryAt: null })
  fixture.getSocket(1).dispatchEvent(new Event("open"))
  expect(status).toHaveBeenLastCalledWith({ state: "connected", attempt: 2, retryAt: null })
})

test("retry now replaces the current stalled handshake instead of waiting for its deadline", async () => {
  const fixture = makeClient()
  await vi.advanceTimersByTimeAsync(0)
  fixture.getSocket(0).dispatchEvent(new Event("open"))
  fixture.getSocket(0).dispatchEvent(new Event("close"))
  await vi.advanceTimersByTimeAsync(250)
  const stalled = fixture.getSocket(1)

  fixture.api.retryConnection?.()
  await vi.advanceTimersByTimeAsync(0)

  expect(stalled.close).toHaveBeenCalledOnce()
  expect(fixture.getSocketCount()).toBe(3)
  expect(fixture.api.getConnectionStatus?.()).toEqual({ state: "unavailable", attempt: 3, retryAt: null })
})

test("device offline pauses attempts until the online signal and removes the offline listener on teardown", async () => {
  const fixture = makeClient()
  await vi.advanceTimersByTimeAsync(0)
  fixture.getSocket(0).dispatchEvent(new Event("open"))
  const online = makeOnlineSignal(false)
  cleanups.add(online.restore)

  window.dispatchEvent(new Event("offline"))
  await vi.advanceTimersByTimeAsync(10_000)

  expect(fixture.api.getConnectionStatus?.()).toEqual({ state: "offline", attempt: 1, retryAt: null })
  expect(fixture.getSocketCount()).toBe(1)
  expect(fixture.getSocket(0).close).toHaveBeenCalledOnce()

  online.setOnline(true)
  window.dispatchEvent(new Event("online"))
  await vi.advanceTimersByTimeAsync(0)
  fixture.getSocket(1).dispatchEvent(new Event("open"))

  expect(fixture.api.getConnectionStatus?.()).toEqual({ state: "connected", attempt: 2, retryAt: null })
  fixture.stop()
  online.setOnline(false)
  window.dispatchEvent(new Event("offline"))
  expect(fixture.api.getConnectionStatus?.().state).toBe("connected")
})

test("a rejected session stops retries and only an explicit access check can reconnect", async () => {
  const fixture = makeClient()
  await vi.advanceTimersByTimeAsync(0)
  fixture.getSocket(0).dispatchEvent(new Event("open"))
  fixture.fetchImpl.mockImplementation(async () => Response.json({ errorCode: "UNAUTHORIZED" }, { status: 401 }))

  await expect(fixture.api.request("GET /session", {})).rejects.toMatchObject({ status: 401 })

  expect(fixture.api.getConnectionStatus?.()).toEqual({ state: "session-expired", attempt: 1, retryAt: null })
  expect(fixture.getSocket(0).close).toHaveBeenCalledOnce()
  const reads = fixture.fetchImpl.mock.calls.length
  window.dispatchEvent(new Event("online"))
  document.dispatchEvent(new Event("visibilitychange"))
  await vi.advanceTimersByTimeAsync(10_000)
  await expect(fixture.api.request("GET /bots", {})).rejects.toMatchObject({ status: 401 })
  expect(fixture.fetchImpl).toHaveBeenCalledTimes(reads)
  expect(fixture.getSocketCount()).toBe(1)

  fixture.api.retryConnection?.()
  await vi.advanceTimersByTimeAsync(0)

  expect(fixture.api.getConnectionStatus?.().state).toBe("session-expired")
  expect(fixture.getSocketCount()).toBe(1)
  fixture.fetchImpl.mockImplementation(async () => getHealthyResponse())
  fixture.api.retryConnection?.()
  await vi.advanceTimersByTimeAsync(0)
  fixture.getSocket(1).dispatchEvent(new Event("open"))

  expect(fixture.api.getConnectionStatus?.().state).toBe("connected")
})

test("a forbidden resource is not mistaken for a revoked device session", async () => {
  const fixture = makeClient()
  await vi.advanceTimersByTimeAsync(0)
  fixture.getSocket(0).dispatchEvent(new Event("open"))
  fixture.fetchImpl.mockImplementation(async () => Response.json({ errorCode: "FORBIDDEN" }, { status: 403 }))

  await expect(fixture.api.request("GET /bots", {})).rejects.toMatchObject({ status: 403 })

  expect(fixture.api.getConnectionStatus?.().state).toBe("connected")
  expect(fixture.getSocket(0).close).not.toHaveBeenCalled()
})

test("a rejected socket ticket requires pairing rather than repeatedly retrying auth", async () => {
  const fixture = makeClient()
  await vi.advanceTimersByTimeAsync(0)
  fixture.getSocket(0).dispatchEvent(new Event("open"))
  fixture.fetchImpl.mockImplementation(async (url) => {
    if (String(url).endsWith("/ws-ticket")) return Response.json({ errorCode: "UNAUTHORIZED" }, { status: 401 })
    return getHealthyResponse()
  })

  fixture.getSocket(0).dispatchEvent(new Event("close"))
  await vi.advanceTimersByTimeAsync(5000)

  expect(fixture.api.getConnectionStatus?.().state).toBe("session-expired")
  expect(fixture.getSocketCount()).toBe(1)
  expect(fixture.connection).toHaveBeenLastCalledWith(false, "UNAUTHORIZED")
})

test("the local shell refreshes a rotated service token without asking for remote pairing", async () => {
  const endpoint = { baseUrl: "http://localhost:1234", wsUrl: "ws://localhost:1234/events", token: "local-token" }
  const resolveEndpoint = vi.fn(async () => Object.assign({}, endpoint, { token: "rotated-local-token" }))
  const fixture = makeClient({ endpoint, resolveEndpoint })
  await vi.advanceTimersByTimeAsync(0)
  fixture.getSocket(0).dispatchEvent(new Event("open"))
  fixture.fetchImpl.mockImplementationOnce(async () => Response.json({ errorCode: "UNAUTHORIZED" }, { status: 401 }))

  await expect(fixture.api.request("GET /health", {})).rejects.toMatchObject({ status: 401 })
  await vi.advanceTimersByTimeAsync(250)
  fixture.getSocket(1).dispatchEvent(new Event("open"))

  expect(resolveEndpoint).toHaveBeenCalledOnce()
  expect(fixture.api.getConnectionStatus?.().state).toBe("connected")
  expect(fixture.connection).not.toHaveBeenCalledWith(false, "UNAUTHORIZED")
})

test("a stalled native endpoint lookup has bounded waits and one underlying lookup", async () => {
  const resolveEndpoint = vi.fn(() => new Promise<Endpoint>(() => undefined))
  const fixture = makeClient({ resolveEndpoint })
  await vi.advanceTimersByTimeAsync(0)
  fixture.getSocket(0).dispatchEvent(new Event("open"))

  fixture.getSocket(0).dispatchEvent(new Event("close"))
  await vi.advanceTimersByTimeAsync(5000)

  expect(resolveEndpoint).toHaveBeenCalledOnce()
  expect(fixture.api.getConnectionStatus?.().attempt).toBeGreaterThan(2)
  fixture.stop()
  await vi.advanceTimersByTimeAsync(5000)
  expect(vi.getTimerCount()).toBe(0)
})

test("native vault recovery keeps its trusted error identifier available to settings", async () => {
  const resolveEndpoint = vi.fn(async () => {
    throw new Error("VAULT_LOCKED")
  })
  const fixture = makeClient({ resolveEndpoint })
  await vi.advanceTimersByTimeAsync(0)
  fixture.getSocket(0).dispatchEvent(new Event("open"))

  fixture.getSocket(0).dispatchEvent(new Event("close"))
  await vi.advanceTimersByTimeAsync(250)

  expect(fixture.api.getConnectionStatus?.()).toMatchObject({ state: "unavailable", errorCode: "VAULT_LOCKED" })
})

const getHealthyResponse = () => Response.json({ ok: true, schemaVersion: 46, protocolVersion: 1, ticket: "fixture" })

const makeClient = (options: { resolveEndpoint?: () => Promise<Endpoint>; endpoint?: Endpoint } = {}) => {
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
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => getHealthyResponse())
  const api = createApiClient(
    Object.assign(
      {
        endpoint: { baseUrl: "https://server.example", wsUrl: "wss://server.example/api/v1/events", token: "" },
        fetchImpl,
      },
      options,
    ),
  )
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

const hideDocument = () => {
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
  cleanups.add(() => visibility.mockRestore())
}

// The browser owns this read-only signal; the fixture exposes its restore function for teardown.
const makeOnlineSignal = (initial: boolean) => {
  const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(initial)

  return {
    setOnline: (value: boolean): void => {
      online.mockReturnValue(value)
    },
    restore: () => online.mockRestore(),
  }
}
