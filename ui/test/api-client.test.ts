import type { ApiRoutes } from "@touri/contracts"
import { expect, test, vi } from "vitest"
import { apiRouteKeys, createApiClient, resolveSidecarEndpoint, type TauriInvoke } from "../src/api/client"

const contractRouteKeys: Array<keyof ApiRoutes> = [
  "GET /workspace/activity",
  "GET /runs",
  "GET /groups",
  "POST /groups",
  "PATCH /groups/:id",
  "DELETE /groups/:id",
  "GET /groups/:id/threads",
  "POST /groups/:id/threads",
  "GET /cloud/account",
  "POST /cloud/pair",
  "POST /cloud/pair/poll",
  "DELETE /cloud/account",
  "POST /cloud/bots/:id/park",
  "POST /cloud/bots/:id/wake",
  "PUT /cloud/bots/:id/key",
  "GET /health",
  "GET /session",
  "POST /ui/errors",
  "POST /reports/history",
  "GET /reports",
  "POST /reports/preview",
  "POST /reports/:id/deliver",
  "POST /reports/:id/saved",
  "GET /doctor",
  "GET /doctor/storage",
  "POST /doctor/storage/compact",
  "GET /storage/bot-deletions",
  "GET /bots",
  "POST /bots",
  "PATCH /bots/:id",
  "DELETE /bots/:id",
  "GET /bots/:id/mcp",
  "GET /bots/:id/mcp/prerequisites",
  "POST /bots/:id/mcp/test",
  "PUT /bots/:id/mcp/:name",
  "DELETE /bots/:id/mcp/:name",
  "PATCH /bots/:id/mcp/:name/tools/:tool",
  "GET /bots/:id/grants",
  "DELETE /bots/:id/grants/:grant",
  "GET /providers/opencode/models",
  "GET /provider-profiles",
  "GET /bots/:id/provider-login",
  "PUT /bots/:id/provider-login",
  "DELETE /bots/:id/provider-login",
  "GET /bots/:id/provider-login/flow",
  "POST /bots/:id/provider-login/flow",
  "GET /machines",
  "POST /machines/service/start",
  "POST /bots/:id/machine/stop",
  "GET /bots/:id/images",
  "GET /bots/:id/files",
  "GET /bots/:id/files/content",
  "POST /bots/:id/machine/shell",
  "POST /bots/:id/machine/restart",
  "POST /bots/:id/machine/intent",
  "POST /bots/:id/machine/reset",
  "POST /bots/:id/desktop",
  "POST /bots/:id/desktop/return",
  "POST /desktop/:id/text",
  "DELETE /desktop/:id",
  "GET /bots/:id/threads",
  "POST /threads",
  "PATCH /threads/:id",
  "GET /threads/:id/transcript",
  "GET /threads/:id/messages",
  "GET /threads/:id/goal",
  "POST /threads/:id/goal",
  "PATCH /threads/:id/goal",
  "POST /threads/:id/messages",
  "POST /runs/:id/cancel",
  "POST /runs/:id/retry",
  "POST /approvals/:id",
  "GET /search",
  "POST /attachments",
  "GET /attachments/:id",
  "GET /attachments/:id/content",
  "GET /routines",
  "POST /routines",
  "PATCH /routines/:id",
  "DELETE /routines/:id",
  "POST /routines/:id/run",
  "GET /routine-runs",
  "GET /mcp/tools",
  "GET /projects",
  "GET /projects/discover",
  "GET /folders",
  "POST /folders",
  "POST /projects",
  "GET /projects/:id/git",
  "GET /projects/:id/secrets",
  "PUT /projects/:id/secrets/:name",
  "DELETE /projects/:id/secrets/:name",
  "GET /projects/:id/processes",
  "PUT /projects/:id/processes/:name",
  "POST /processes/:id/start",
  "POST /processes/:id/stop",
  "POST /processes/:id/restart",
  "GET /processes/:id/logs",
  "GET /previews",
  "GET /browser/tabs",
  "GET /bots/:id/browser-preview",
  "POST /browser/tabs/:id/takeover",
  "POST /browser/secret-entry/:id",
  "POST /computer/grants",
  "POST /computer/kill",
  "POST /imports/legacy",
  "GET /imports/:id",
  "GET /recovery",
  "POST /recovery/:id/dismiss",
  "GET /notifications",
  "GET /notifications/pending",
  "POST /notifications/:id/dismiss",
  "POST /notifications/dismiss-all",
  "POST /threads/:id/respond",
  "POST /bots/:id/messages",
  "GET /settings",
  "GET /api-models",
  "POST /api-models",
  "POST /api-models/models",
  "POST /api-models/test",
  "POST /api-models/:id/test",
  "PATCH /api-models/:id/browser-decisions",
  "DELETE /api-models/:id",
  "PATCH /settings",
]

test("the UI client route inventory matches ApiRoutes", () => {
  expect([...apiRouteKeys]).toEqual(contractRouteKeys)
  expect(new Set(apiRouteKeys).size).toBe(apiRouteKeys.length)
})

test("connection-info resolution preserves the Rust endpoint contract", async () => {
  const invoke = (async () => ({
    baseUrl: "http://127.0.0.1:43123",
    wsUrl: "ws://127.0.0.1:43123/api/v1/events",
    token: "ui-token",
  })) as TauriInvoke
  await expect(resolveSidecarEndpoint(invoke)).resolves.toEqual({
    baseUrl: "http://127.0.0.1:43123",
    wsUrl: "ws://127.0.0.1:43123/api/v1/events",
    token: "ui-token",
  })
  await expect(resolveSidecarEndpoint((async () => null) as TauriInvoke)).rejects.toThrow("no connection information")
})

test("r2: reconnects WebSocket, refreshes the endpoint, and cancels retries after unsubscribe", async () => {
  vi.useFakeTimers()
  class Socket extends EventTarget {
    static instances: Array<Socket> = []
    close = vi.fn()
    constructor(public url: URL) {
      super()
      Socket.instances.push(this)
    }
  }
  vi.stubGlobal("WebSocket", Socket)
  try {
    const resolveEndpoint = vi.fn(async () => ({
      baseUrl: "http://127.0.0.1:2",
      wsUrl: "ws://127.0.0.1:2/events",
      token: "new-token",
    }))
    let issued = 0
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ ok: true, ticket: `ticket-${++issued}` }),
    )
    const api = createApiClient({
      endpoint: { baseUrl: "http://127.0.0.1:1", wsUrl: "ws://127.0.0.1:1/events", token: "old" },
      resolveEndpoint,
      fetchImpl,
    })
    const events = vi.fn()
    const connections = vi.fn()
    api.subscribeConnection?.(connections)
    const stop = api.subscribe(events)
    await vi.advanceTimersByTimeAsync(0)
    Socket.instances[0]?.dispatchEvent(new Event("open"))
    Socket.instances[0]?.dispatchEvent(new Event("close"))
    await vi.advanceTimersByTimeAsync(250)
    expect(resolveEndpoint).toHaveBeenCalledTimes(1)
    expect(Socket.instances).toHaveLength(2)
    expect(Socket.instances[1]?.url.searchParams.has("token")).toBe(false)
    expect(Socket.instances[1]?.url.searchParams.get("ticket")).toBe("ticket-2")
    const desktop = new URL((await api.websocketUrl?.("/api/v1/desktop/session/socket")) ?? "")
    expect(desktop.host).toBe("127.0.0.1:2")
    expect(desktop.pathname).toBe("/api/v1/desktop/session/socket")
    expect(desktop.searchParams.has("token")).toBe(false)
    expect(desktop.searchParams.get("ticket")).toBe("ticket-3")
    Socket.instances[1]?.dispatchEvent(new Event("open"))
    expect(connections).toHaveBeenLastCalledWith(true)
    Socket.instances[1]?.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ seq: 1, at: 1, event: { type: "import.progress", phase: "done", done: 1, total: 1 } }),
      }),
    )
    expect(events).toHaveBeenCalledTimes(1)
    await api.request("GET /health", {})
    expect(fetchImpl.mock.calls.at(-1)?.[0]).toContain("127.0.0.1:2")
    Socket.instances[1]?.dispatchEvent(new Event("close"))
    stop()
    await vi.advanceTimersByTimeAsync(10000)
    expect(Socket.instances).toHaveLength(2)
  } finally {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})

test("r2: only retries reads after a network failure, never replays a mutation", async () => {
  const fetchImpl = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("network down"))
    .mockResolvedValueOnce(Response.json({ routines: [] }))
  const resolveEndpoint = vi.fn(async () => ({
    baseUrl: "http://127.0.0.1:2",
    wsUrl: "ws://127.0.0.1:2/events",
    token: "new",
  }))
  const api = createApiClient({
    endpoint: { baseUrl: "http://127.0.0.1:1", wsUrl: "ws://127.0.0.1:1/events", token: "old" },
    resolveEndpoint,
    fetchImpl,
  })
  await expect(api.request("GET /routines", {})).resolves.toEqual({ routines: [] })
  expect(fetchImpl).toHaveBeenCalledTimes(2)
  fetchImpl.mockRejectedValue(new TypeError("network down"))
  await expect(api.request("POST /bots", { name: "r2", provider: "codex" })).rejects.toMatchObject({
    code: "TOURI-E1010",
    retryable: false,
    status: 0,
  })
  expect(fetchImpl).toHaveBeenCalledTimes(3)
})

test("reports recovery when the first WebSocket connection failed before opening", async () => {
  vi.useFakeTimers()
  class Socket extends EventTarget {
    static instances: Array<Socket> = []
    close = vi.fn()
    constructor() {
      super()
      Socket.instances.push(this)
    }
  }
  vi.stubGlobal("WebSocket", Socket)
  try {
    const api = createApiClient({
      endpoint: { baseUrl: "http://127.0.0.1:1", wsUrl: "ws://127.0.0.1:1/events", token: "test" },
      fetchImpl: async () => Response.json({ ticket: "single-use-test" }),
    })
    const connections = vi.fn()
    api.subscribeConnection?.(connections)
    const stop = api.subscribe(() => undefined)
    await vi.advanceTimersByTimeAsync(0)
    Socket.instances[0]?.dispatchEvent(new Event("error"))
    expect(connections).toHaveBeenLastCalledWith(false)
    await vi.advanceTimersByTimeAsync(250)
    Socket.instances[1]?.dispatchEvent(new Event("open"))
    expect(connections).toHaveBeenLastCalledWith(true)
    stop()
  } finally {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})

test("streams evidence images as authenticated blobs with encoded workspace paths", async () => {
  const fetchImpl = vi.fn(
    async () => ({ ok: true, blob: async () => new Blob(["image"], { type: "image/png" }) }) as Response,
  )
  const api = createApiClient({
    endpoint: { baseUrl: "http://127.0.0.1:43123", wsUrl: "ws://127.0.0.1:43123/events", token: "ui-token" },
    fetchImpl,
  })
  const image = await api.request("GET /bots/:id/images", { path: "shots/a b.png", base: "reports" }, { id: "bot" })
  expect(image.type).toBe("image/png")
  expect(fetchImpl).toHaveBeenCalledWith(
    "http://127.0.0.1:43123/api/v1/bots/bot/images?path=shots%2Fa%20b.png&base=reports",
    expect.objectContaining({ headers: { Authorization: "Bearer ui-token" }, method: "GET" }),
  )
})

test("reads output continuation pages as authenticated JSON rather than attachment blobs", async () => {
  const page = { text: "Resultado", offset: 65536, nextOffset: null, bytes: 65545 }
  const fetchImpl = vi.fn(async () => Response.json(page))
  const api = createApiClient({
    endpoint: { baseUrl: "http://127.0.0.1:43123", wsUrl: "ws://127.0.0.1:43123/events", token: "ui-token" },
    fetchImpl,
  })
  await expect(
    api.request("GET /attachments/:id/content", { offset: 65536, limit: 65536 }, { id: "output" }),
  ).resolves.toEqual(page)
  expect(fetchImpl).toHaveBeenCalledWith(
    "http://127.0.0.1:43123/api/v1/attachments/output/content?offset=65536&limit=65536",
    expect.objectContaining({ headers: { Authorization: "Bearer ui-token" }, method: "GET" }),
  )
})

test("A07: file chooser uploads send bounded bytes without host paths or an active MIME", async () => {
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({ attachment: { id: "uploaded", mime: "application/octet-stream" } }),
  )
  const api = createApiClient({
    endpoint: { baseUrl: "http://127.0.0.1:43123", wsUrl: "ws://127.0.0.1:43123/events", token: "ui-token" },
    fetchImpl,
  })
  await api.uploadAttachment?.(new File(["<svg/>"], "test.svg", { type: "image/svg+xml" }))
  const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))
  expect(body).toEqual({ name: "test.svg", dataBase64: btoa("<svg/>") })
})

test("attachment uploads preserve the server's rejection reason", async () => {
  const fetchImpl = vi.fn(
    async () =>
      new Response(JSON.stringify({ error: "Arquivo acima de 15 MB", errorCode: "ATTACHMENT_TOO_LARGE" }), {
        status: 413,
      }),
  )
  const api = createApiClient({
    endpoint: { baseUrl: "http://localhost:1", wsUrl: "ws://localhost:1", token: "test" },
    fetchImpl,
  })
  await expect(api.uploadAttachment?.(new File(["small"], "a.txt"))).rejects.toMatchObject({
    message: "Arquivo acima de 15 MB",
    errorCode: "ATTACHMENT_TOO_LARGE",
    status: 413,
  })
})
