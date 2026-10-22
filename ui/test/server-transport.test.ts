import { afterEach, expect, test, vi } from "vitest"
import { createApiClient } from "../src/api/client"
import { createSendJournal } from "../src/api/sendJournal"

class Socket extends EventTarget {
  static instances: Socket[] = []
  close = vi.fn()
  constructor(public url: URL) {
    super()
    Socket.instances.push(this)
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  Socket.instances = []
})

test("a failed event ticket reports offline and recovers on the first successful socket", async () => {
  vi.useFakeTimers()
  vi.stubGlobal("WebSocket", Socket)
  const fetchImpl = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValue(Response.json({ ticket: "one-use" }))
  const api = createApiClient({
    endpoint: { baseUrl: "http://127.0.0.1:1", wsUrl: "ws://127.0.0.1:1/api/v1/events", token: "local-relay" },
    fetchImpl,
  })
  const connection = vi.fn()
  api.subscribeConnection?.(connection)
  const stop = api.subscribe(() => undefined)
  try {
    await vi.advanceTimersByTimeAsync(0)
    expect(connection).toHaveBeenLastCalledWith(false)
    await vi.advanceTimersByTimeAsync(250)
    Socket.instances[0]?.dispatchEvent(new Event("open"))
    expect(connection).toHaveBeenLastCalledWith(true)
  } finally {
    stop()
  }
})

test("a server replay beyond the cap requests a snapshot and resumes at its cursor", async () => {
  vi.useFakeTimers()
  vi.stubGlobal("WebSocket", Socket)
  const api = createApiClient({
    endpoint: { baseUrl: "http://127.0.0.1:1", wsUrl: "ws://127.0.0.1:1/api/v1/events", token: "local-relay" },
    fetchImpl: async () => Response.json({ ticket: "one-use" }),
  })
  const events = vi.fn()
  const stop = api.subscribe(events)
  const frame = (socket: Socket | undefined, data: unknown) =>
    socket?.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }))
  try {
    await vi.advanceTimersByTimeAsync(0)
    const first = Socket.instances[0]
    first?.dispatchEvent(new Event("open"))
    frame(first, { type: "resync", lastSeq: 10 })
    events.mockClear()
    first?.dispatchEvent(new Event("close"))
    await vi.advanceTimersByTimeAsync(250)
    const next = Socket.instances[1]
    expect(next?.url.searchParams.get("since")).toBe("10")
    next?.dispatchEvent(new Event("open"))
    frame(next, { type: "resync", lastSeq: 5000 })
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ event: { type: "transcript.resync" } }))
    events.mockClear()
    const event = { type: "import.progress", phase: "done", done: 1, total: 1 }
    frame(next, { seq: 5000, at: 1, event })
    frame(next, { seq: 5001, at: 2, event })
    expect(events).toHaveBeenCalledTimes(1)
    expect(events).toHaveBeenLastCalledWith({ seq: 5001, at: 2, event })
  } finally {
    stop()
  }
})

test("pending messages remain on their original server across mode switches and restart", async () => {
  vi.useFakeTimers()
  const saved = new Map<string, string>()
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
  }
  const request = vi.fn()
  const make = (scope?: string) => {
    const journal = createSendJournal({ request, emit: () => undefined, storage, scope: scope ?? null })
    journal.stop()
    return journal
  }
  const local = make()
  const remote = make("https://server.example")
  try {
    await local.enqueue({ threadId: "same-id", parentId: null, text: "local draft", attachmentIds: [] })
    await remote.enqueue({ threadId: "same-id", parentId: null, text: "server draft", attachmentIds: [] })
    expect(
      make()
        .messages()
        .map((message) => message.text),
    ).toEqual(["local draft"])
    expect(
      make("https://server.example")
        .messages()
        .map((message) => message.text),
    ).toEqual(["server draft"])
    expect(make("https://another.example").messages()).toEqual([])
    expect(request).not.toHaveBeenCalled()
  } finally {
    local.stop()
    remote.stop()
  }
})

test("a stored channel message without a bot run acknowledges delivery without publishing bot activity", async () => {
  vi.useFakeTimers()
  const emit = vi.fn()
  const storage = { getItem: () => null, setItem: vi.fn() }
  const request = vi.fn(async (_route, input) => ({
    message: {
      id: `send:${input.clientNonce}`,
      threadId: input.threadId,
      text: input.text,
      delivery: { clientNonce: input.clientNonce, deadline: input.deadline, status: "acked" },
    },
    run: null,
  }))
  const journal = createSendJournal({ request, emit, storage })

  await journal.enqueue({ threadId: "channel", parentId: null, text: "oi", attachmentIds: [] })
  await vi.advanceTimersByTimeAsync(0)

  expect(emit).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "message.updated",
      message: expect.objectContaining({ delivery: expect.objectContaining({ status: "acked" }) }),
    }),
  )
  expect(emit.mock.calls.some(([event]) => event.type === "run.updated")).toBe(false)
  expect(journal.messages()).toEqual([])
  journal.stop()
})
