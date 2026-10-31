import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { type ApiRequest, createApiClient, type UiApi } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { errorRecovery } from "../src/errorRecovery"
import { ApiError } from "../src/errors"
import { t } from "../src/i18n"
import { useWorkspace } from "../src/useWorkspace"
import { saveWorkChannelCache } from "../src/workChannelCache"

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test.each([
  ["network", 0, undefined],
  ["gateway", 502, undefined],
  ["timeout", 504, undefined],
  ["server", 503, "SERVER_CONNECTION_FAILED"],
] as const)("a failed %s read replaces a socket that never closed", async (failure, status, errorCode) => {
  vi.useFakeTimers()
  const sockets = makeSockets()
  const fetchImpl = vi.fn(async () => Response.json({ ticket: "test-ticket", ok: true, schemaVersion: 46 }))
  const api = createApiClient({
    endpoint: { baseUrl: "https://server.example", wsUrl: "wss://server.example/api/v1/events", token: "test" },
    fetchImpl,
  })
  const connection = vi.fn()
  api.subscribeConnection?.(connection)
  onTestFinished(api.subscribe(vi.fn()))
  await vi.advanceTimersByTimeAsync(0)
  sockets.getSocket(0).dispatchEvent(new Event("open"))
  if (failure === "network") {
    fetchImpl.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    fetchImpl.mockRejectedValueOnce(new TypeError("Failed to fetch"))
  }
  if (failure !== "network")
    fetchImpl.mockResolvedValueOnce(Response.json({ code: "TOURI-E1009", errorCode }, { status }))

  await expect(api.request("GET /health", {})).rejects.toBeInstanceOf(ApiError)
  await vi.advanceTimersByTimeAsync(250)
  sockets.getSocket(1).dispatchEvent(new Event("open"))

  expect(sockets.getSocket(0).close).toHaveBeenCalledOnce()
  expect(connection.mock.calls).toEqual([[false], [true]])
})

test("a read refused by a draining server reconnects instead of reporting a broken conversation", async () => {
  vi.useFakeTimers()
  const sockets = makeSockets()
  const fetchImpl = vi.fn(async () => Response.json({ ticket: "test-ticket", ok: true, schemaVersion: 46 }))
  const api = createApiClient({
    endpoint: { baseUrl: "https://server.example", wsUrl: "wss://server.example/api/v1/events", token: "test" },
    fetchImpl,
  })
  const connection = vi.fn()
  api.subscribeConnection?.(connection)
  onTestFinished(api.subscribe(vi.fn()))
  await vi.advanceTimersByTimeAsync(0)
  sockets.getSocket(0).dispatchEvent(new Event("open"))
  // The exact body a restarting server sends while it drains active runs.
  fetchImpl.mockResolvedValueOnce(Response.json({ errorCode: "RUNTIME_DRAINING" }, { status: 503 }))

  await expect(
    api.request("GET /threads/:id/messages", { all: true, limit: 40 }, { id: "thread" }),
  ).rejects.toMatchObject({ status: 503, errorCode: "RUNTIME_DRAINING" })
  await vi.advanceTimersByTimeAsync(250)
  sockets.getSocket(1).dispatchEvent(new Event("open"))

  expect(sockets.getSocket(0).close).toHaveBeenCalledOnce()
  expect(connection.mock.calls).toEqual([[false], [true]])
})

test.each([
  ["STORE_UNAVAILABLE", "TOURI-E1009"],
  ["HOST_UNAVAILABLE", "TOURI-E1009"],
  ["COMPUTER_UNAVAILABLE", "TOURI-E1009"],
  [undefined, "TOURI-E1009"],
  [undefined, undefined],
] as const)("a 503 %s/%s read preserves the event connection and message delivery", async (errorCode, code) => {
  vi.useFakeTimers()
  const sockets = makeSockets()
  const fetchImpl = vi.fn(async () => Response.json({ ticket: "test-ticket", ok: true, schemaVersion: 46 }))
  const api = createApiClient({
    endpoint: { baseUrl: "https://server.example", wsUrl: "wss://server.example/api/v1/events", token: "test" },
    fetchImpl,
  })
  const events = vi.fn()
  const connection = vi.fn()
  api.subscribeConnection?.(connection)
  onTestFinished(api.subscribe(events))
  await vi.advanceTimersByTimeAsync(0)
  sockets.getSocket(0).dispatchEvent(new Event("open"))
  fetchImpl.mockResolvedValueOnce(Response.json({ code, errorCode }, { status: 503 }))

  await expect(api.request("GET /health", {})).rejects.toMatchObject({ status: 503, code })
  sockets.getSocket(0).dispatchEvent(
    new MessageEvent("message", {
      data: JSON.stringify({ seq: 1, at: 1, event: { type: "transcript.resync" } }),
    }),
  )
  fetchImpl.mockImplementationOnce(async () => Response.json({ message: api.pendingMessages?.()[0], run: null }))
  await api.sendMessage?.({ threadId: "thread", parentId: null, text: "Mensagem de teste", attachmentIds: [] })
  await vi.advanceTimersByTimeAsync(0)

  expect(sockets.getSocket(0).close).not.toHaveBeenCalled()
  expect(connection).not.toHaveBeenCalled()
  expect(events).toHaveBeenCalledWith(expect.objectContaining({ seq: 1 }))
  expect(fetchImpl).toHaveBeenCalledTimes(3)
  expect(api.pendingMessages?.()).toEqual([])
})

test.each([
  new ApiError(503, "Store unavailable", "STORE_UNAVAILABLE", "TOURI-E1009"),
  new ApiError(503, "Host unavailable", "HOST_UNAVAILABLE", "TOURI-E1009"),
  new ApiError(503, "Computer unavailable", "COMPUTER_UNAVAILABLE", "TOURI-E1009"),
  new ApiError(503, "Service unavailable", undefined, "TOURI-E1009"),
  new ApiError(503, "Service unavailable"),
  new Error("TOURI-E1009"),
])("a non-connection error does not claim touri is unreachable: %s", (error) => {
  const recovery = errorRecovery(error)

  expect(recovery.message).not.toBe(t("O serviço do touri está indisponível. Verifique a conexão e tente novamente."))
})

test("a failed write is not replayed and does not replace the event connection", async () => {
  vi.useFakeTimers()
  const sockets = makeSockets()
  const fetchImpl = vi.fn(async () => Response.json({ ticket: "test-ticket", ok: true, schemaVersion: 46 }))
  const api = createApiClient({
    endpoint: { baseUrl: "https://server.example", wsUrl: "wss://server.example/api/v1/events", token: "test" },
    fetchImpl,
  })
  onTestFinished(api.subscribe(vi.fn()))
  await vi.advanceTimersByTimeAsync(0)
  sockets.getSocket(0).dispatchEvent(new Event("open"))
  fetchImpl.mockResolvedValueOnce(Response.json({ code: "TOURI-E1009" }, { status: 503 }))

  await expect(api.request("POST /threads", { botId: "bot" })).rejects.toBeInstanceOf(ApiError)
  await vi.advanceTimersByTimeAsync(10_000)

  expect(fetchImpl).toHaveBeenCalledTimes(2)
  expect(sockets.getSocket(0).close).not.toHaveBeenCalled()
})

test("a healthy snapshot is repaired by event replay without refetching history on reconnect", async () => {
  const mock = createMockApi()
  const request = vi.fn(mock.request)
  const client = makeConnectionClient({ ...mock, request, isMock: false })
  const hook = renderHook(() => useWorkspace(client.api))
  await waitFor(() => expect(hook.result.current.data.messages.length).toBeGreaterThan(0))
  request.mockClear()

  await act(async () => client.reconnect())

  expect(getWorkspaceSnapshotReads(request.mock.calls.map(([route]) => route))).toEqual([])
})

test("returning online lets a cursor-aware transport replay changes without refetching valid history", async () => {
  const mock = createMockApi()
  const request = vi.fn(mock.request)
  const api = { ...mock, request, cursorReady: async () => undefined }
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(hook.result.current.data.messages.length).toBeGreaterThan(0))
  request.mockClear()

  await act(async () => window.dispatchEvent(new Event("online")))

  expect(getWorkspaceSnapshotReads(request.mock.calls.map(([route]) => route))).toEqual([])
})

test("reconnection reloads a snapshot that failed before the bot list arrived", async () => {
  const mock = createMockApi()
  const failRead = makeUnavailableRead()
  const request: ApiRequest = async (route, input, path) => {
    if (route === "GET /bots") failRead()
    return mock.request(route, input, path)
  }
  const client = makeConnectionClient({ ...mock, request, isMock: false })
  const hook = renderHook(() => useWorkspace(client.api))
  await waitFor(() => expect(hook.result.current.data.notice).toContain("TOURI-E1009"))
  expect(errorRecovery(hook.result.current.data.notice).message).toContain("O serviço do touri está indisponível")

  act(client.reconnect)

  await waitFor(() => expect(hook.result.current.data.loaded).toBe(true))
  expect(hook.result.current.data.bots.length).toBeGreaterThan(0)
  expect(hook.result.current.data.notice).toBeNull()
})

test("a stopped server reports inside the open conversation instead of the app notice", async () => {
  const mock = createMockApi()
  let unavailable = false
  const request: ApiRequest = async (route, input, path) => {
    if (unavailable) throw new ApiError(0, "", undefined, "TOURI-E1009")
    return mock.request(route, input, path)
  }
  const api = { ...mock, request, isMock: false }
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(hook.result.current.data.messages.length).toBeGreaterThan(0))
  const { selectedThreadId } = hook.result.current.data
  const messageIds = hook.result.current.data.messages.map((message) => message.id)
  unavailable = true

  await act(async () => hook.result.current.actions.refresh())

  expect(hook.result.current.data.notice).toBeNull()
  expect(hook.result.current.data.historyFailure).toMatchObject({ kind: "server", code: "TOURI-E1009" })
  expect(hook.result.current.data.historyFailure?.threadId).toBe(selectedThreadId)
  expect(hook.result.current.data.messages.map((message) => message.id)).toEqual(messageIds)
  unavailable = false

  await act(async () => hook.result.current.actions.refresh())

  await waitFor(() => expect(hook.result.current.data.historyFailure).toBeNull(), { timeout: 4000 })
  expect(hook.result.current.data.notice).toBeNull()
})

test.each([404, 502])("an HTTP %s index failure does not claim the open conversation was deleted", async (status) => {
  const mock = createMockApi()
  let failure: ApiError | null = null
  const request: ApiRequest = async (route, input, path) => {
    if (route === "GET /runs" && failure) throw failure
    return mock.request(route, input, path)
  }
  const client = { ...mock, request, isMock: false }
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(hook.result.current.data.messages.length).toBeGreaterThan(0))
  failure = new ApiError(status, "Synthetic index failure")

  await act(async () => hook.result.current.actions.refresh())

  expect(hook.result.current.data.notice).toContain("Synthetic index failure")
  expect(hook.result.current.data.historyFailure).toBeNull()
})

test("a later successful message read preserves an unreachable run snapshot until retry succeeds", async () => {
  const mock = createMockApi()
  const releaseMessages = Promise.withResolvers<void>()
  const messagesStarted = vi.fn()
  const runsFailed = vi.fn()
  let unreachable = true
  const request: ApiRequest = async (route, input, path) => {
    if (route === "GET /threads/:id/runs" && unreachable) {
      runsFailed()
      throw new ApiError(0, "", undefined, "TOURI-E1009")
    }
    if (route === "GET /threads/:id/messages") {
      messagesStarted()
      await releaseMessages.promise
    }
    return mock.request(route, input, path)
  }
  const client = { ...mock, request, isMock: false }
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(messagesStarted).toHaveBeenCalled())
  await waitFor(() => expect(runsFailed).toHaveBeenCalled())
  await waitFor(() =>
    expect(hook.result.current.data.historyFailure).toMatchObject({ kind: "server", code: "TOURI-E1009" }),
  )

  await act(async () => releaseMessages.resolve())
  await waitFor(() => expect(hook.result.current.data.messages.length).toBeGreaterThan(0))

  expect(hook.result.current.data.historyRunsReady).toBe(false)
  expect(hook.result.current.data.historyFailure).toMatchObject({ kind: "server", code: "TOURI-E1009" })
  expect(hook.result.current.data.notice).toBeNull()
  unreachable = false

  await act(async () => hook.result.current.actions.refresh())

  await waitFor(() => expect(hook.result.current.data.historyRunsReady).toBe(true))
  expect(hook.result.current.data.historyFailure).toBeNull()
})

test("a successful channel message read does not clear a failed workspace index", async () => {
  const mock = createMockApi()
  const { group, thread } = await mock.request("POST /groups", {
    name: "Canal de exemplo",
    color: "#2563eb",
    memberIds: ["bot-mark"],
    coordinatorBotId: null,
  })
  saveWorkChannelCache({ groups: [group], threads: [thread], selectedThreadId: thread.id }, "owner")
  const releaseMessages = Promise.withResolvers<void>()
  let failedIndex = true
  const request: ApiRequest = async (route, input, path) => {
    if (route === "GET /runs" && failedIndex) throw new ApiError(0, "", undefined, "TOURI-E1009")
    if (route === "GET /threads/:id/messages") await releaseMessages.promise
    return mock.request(route, input, path)
  }
  const client = { ...mock, request, isMock: false }
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(hook.result.current.data.historyFailure?.index).toBe(true))

  await act(async () => releaseMessages.resolve())
  await waitFor(() => expect(hook.result.current.data.historyThreadId).toBe(thread.id))

  expect(hook.result.current.data.historyFailure).toMatchObject({ index: true, threadId: thread.id })
  failedIndex = false

  await act(async () => hook.result.current.actions.refresh())

  expect(hook.result.current.data.historyFailure).toBeNull()
})

test("reconnection clears the selected history's service error without a new server event", async () => {
  const mock = createMockApi()
  let unavailable = true
  const request: ApiRequest = async (route, input, path) => {
    if (route === "GET /threads/:id/messages" && unavailable) throw new ApiError(0, "", undefined, "TOURI-E1009")
    return mock.request(route, input, path)
  }
  const client = makeConnectionClient({ ...mock, request, isMock: false })
  const hook = renderHook(() => useWorkspace(client.api))
  await waitFor(() => expect(hook.result.current.data.historyFailure).toBeTruthy(), { timeout: 4000 })
  expect(hook.result.current.data.historyFailure).toMatchObject({ kind: "server", code: "TOURI-E1009" })
  expect(hook.result.current.data.notice).toBeNull()
  unavailable = false

  act(client.reconnect)

  await waitFor(() => expect(hook.result.current.data.messages.length).toBeGreaterThan(0))
  expect(hook.result.current.data.historyFailure).toBeNull()
  expect(hook.result.current.data.notice).toBeNull()
})

test.each(["reconnect", "online"] as const)(
  "%s recovers a failed conversation without another server event or manual retry",
  async (recovery) => {
    const mock = createMockApi()
    const failRead = vi
      .fn<() => void>()
      .mockImplementationOnce(() => {
        throw new ApiError(503, "Restarting", "RUNTIME_DRAINING")
      })
      .mockImplementationOnce(() => {
        throw new ApiError(503, "Restarting", "RUNTIME_DRAINING")
      })
    const request: ApiRequest = async (route, input, path) => {
      if (route === "GET /threads/:id/messages") failRead()
      return mock.request(route, input, path)
    }
    const client = makeConnectionClient({ ...mock, request, isMock: false, cursorReady: async () => undefined })
    const hook = renderHook(() => useWorkspace(client.api))
    await waitFor(() => expect(hook.result.current.data.historyFailure?.code).toBe("TOURI-E1009"), {
      timeout: 4000,
    })
    expect(hook.result.current.data.notice).toBeNull()

    act(() => {
      if (recovery === "reconnect") client.reconnect()
      else window.dispatchEvent(new Event("online"))
    })

    await waitFor(() => expect(hook.result.current.data.messages.length).toBeGreaterThan(0))
    expect(hook.result.current.data.historyFailure).toBeNull()
    expect(hook.result.current.data.notice).toBeNull()
    expect(failRead).toHaveBeenCalledTimes(3)
  },
)

test("reconnecting does not retry a deleted conversation", async () => {
  const mock = createMockApi()
  const read = vi.fn<() => void>().mockImplementation(() => {
    throw new ApiError(404, "Thread not found", "NOT_FOUND")
  })
  const request: ApiRequest = async (route, input, path) => {
    if (route === "GET /threads/:id/messages") read()
    return mock.request(route, input, path)
  }
  const client = makeConnectionClient({ ...mock, request, isMock: false, cursorReady: async () => undefined })
  const hook = renderHook(() => useWorkspace(client.api))
  await waitFor(() => expect(hook.result.current.data.historyFailure?.kind).toBe("deleted"))

  await act(async () => client.reconnect())
  await act(async () => window.dispatchEvent(new Event("online")))

  expect(read).toHaveBeenCalledTimes(1)
  expect(hook.result.current.data.historyFailure?.kind).toBe("deleted")
})

test.each(["pt-BR", "en"] as const)("service errors identify touri instead of the AI in %s", (locale) => {
  const failures = [
    new ApiError(0, "", undefined, "TOURI-E1009"),
    new ApiError(502, "", undefined, "TOURI-E1009"),
    new ApiError(504, "", undefined, "TOURI-E1009"),
    new ApiError(503, "", "SERVER_CONNECTION_FAILED", "TOURI-E1009"),
    new Error("SERVER_CONNECTION_FAILED"),
  ]

  failures.forEach((error) => {
    const recovery = errorRecovery(error, { locale })
    const detail = t("Service request failed", { error: error.message }, locale)

    expect(recovery.message).toContain("touri")
    expect(recovery.message).toContain(locale === "pt-BR" ? "serviço" : "service")
    expect(recovery.actions.map((action) => action.kind)).toEqual(["retry"])
    expect(detail).not.toMatch(/local/i)
  })
})

const makeConnectionClient = (api: UiApi) => {
  const connections = new EventTarget()
  const subscribeConnection = (listener: (connected: boolean) => void) => {
    const reconnect = () => listener(true)
    connections.addEventListener("reconnect", reconnect)
    return () => connections.removeEventListener("reconnect", reconnect)
  }
  return {
    api: { ...api, subscribeConnection },
    reconnect: () => {
      connections.dispatchEvent(new Event("reconnect"))
    },
  }
}

const makeUnavailableRead = () =>
  vi.fn<() => void>().mockImplementationOnce(() => {
    throw new ApiError(0, "", undefined, "TOURI-E1009")
  })

const makeSockets = () => {
  const sockets = new Map<number, Socket>()
  // Socket creation and closure emulate the browser API at the transport boundary.
  class Socket extends EventTarget {
    close = vi.fn()
    constructor() {
      super()
      sockets.set(sockets.size, this)
    }
  }
  vi.stubGlobal("WebSocket", Socket)
  return {
    getSocket: (index: number) => {
      const socket = sockets.get(index)
      if (!socket) throw new Error(`Missing socket ${index}`)
      return socket
    },
  }
}

const getWorkspaceSnapshotReads = (routes: string[]): string[] =>
  routes.filter((route) =>
    [
      "GET /bots",
      "GET /threads/:id/messages",
      "GET /threads/:id/transcript",
      "GET /notifications",
      "GET /workspace/activity",
    ].includes(route),
  )
