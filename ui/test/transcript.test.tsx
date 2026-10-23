import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react"
import type { Message, Run, UiEvent, UiEventEnvelope } from "@touri/contracts"
import { afterEach, expect, test, vi } from "vitest"
import App from "../src/App"
import { type ApiRequest, createApiClient } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { createSendJournal } from "../src/api/sendJournal"
import { VirtualMessageList } from "../src/components/ChatPanel"
import { ApiError } from "../src/errors"
import { applyDelta, applyParts, updateMessage, useWorkspace } from "../src/useWorkspace"
import { makeConnectionEvents } from "./connection-events"

const input = {
  threadId: "thread",
  parentId: null,
  text: "Minha mensagem",
  attachmentIds: [],
  clientNonce: "nonce",
  deadline: 60_000,
}
const message = (status: NonNullable<Message["delivery"]>["status"] = "acked"): Message => ({
  id: "send:nonce",
  threadId: "thread",
  parentId: null,
  role: "user",
  kind: "text",
  status: "complete",
  runId: "run",
  text: input.text,
  parts: [{ type: "text", text: input.text }],
  sender: null,
  source: "local",
  createdAt: 1,
  updatedAt: 1,
  seq: 1,
  updatedSeq: 4,
  generation: 1,
  delivery: { clientNonce: "nonce", deadline: input.deadline, status },
})
const run = { id: "run", threadId: "thread", status: "queued", finishedAt: null } as Run
const response = { message: message(), run }
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test("offline sends survive recreation and drain in order on reconnect", async () => {
  const request = vi.fn().mockResolvedValue(response)
  const events: UiEvent[] = []
  const journal = createSendJournal({
    request: request as ApiRequest,
    emit: (event) => events.push(event),
    storage: localStorage,
    now: () => 1,
  })
  journal.disconnect()
  await journal.enqueue(input)
  await journal.enqueue({ ...input, clientNonce: "next", text: "Segunda", parentId: "send:nonce" })
  expect(request).not.toHaveBeenCalled()
  expect(journal.messages().map((message) => message.delivery?.status)).toEqual(["queued", "queued"])
  journal.stop()
  const restored = createSendJournal({
    request: request as ApiRequest,
    emit: (event) => events.push(event),
    storage: localStorage,
    now: () => 1,
  })
  restored.reconnect()
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
  expect(request.mock.calls[0]?.[1]).toEqual(input)
  expect(request.mock.calls[1]?.[1]).toMatchObject({ clientNonce: "next", parentId: "send:nonce" })
  expect(restored.messages()).toEqual([])
  restored.stop()
})

test("lost acknowledgement retries the exact nonce, including after the deadline", async () => {
  let now = 1
  const request = vi.fn().mockRejectedValueOnce(new TypeError("network")).mockResolvedValue(response)
  const journal = createSendJournal({
    request: request as ApiRequest,
    emit: () => undefined,
    storage: localStorage,
    now: () => now,
  })
  await journal.enqueue(input)
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
  expect(journal.messages()[0]?.delivery?.status).toBe("sent")
  now = 100_000
  journal.reconnect()
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
  expect(request.mock.calls[0]?.[1]).toEqual(request.mock.calls[1]?.[1])
  expect(journal.messages()).toEqual([])
  journal.stop()
})

test("expiry marks a never-sent offline entry as failed and preserves its text", async () => {
  vi.useFakeTimers()
  let now = 1
  const request = vi.fn()
  const journal = createSendJournal({
    request: request as ApiRequest,
    emit: () => undefined,
    storage: localStorage,
    now: () => now,
  })
  journal.disconnect()
  await journal.enqueue({ ...input, deadline: 10 })
  now = 11
  await vi.advanceTimersByTimeAsync(10)
  expect(journal.messages()[0]).toMatchObject({ text: input.text, delivery: { status: "failed" } })
  journal.reconnect()
  expect(request).not.toHaveBeenCalled()
  journal.stop()
})

test("a definitive delivery rejection is retained and never resent automatically", async () => {
  const request = vi.fn().mockRejectedValue(new ApiError(409, "Bot pausado", "BOT_PAUSED"))
  const journal = createSendJournal({
    request: request as ApiRequest,
    emit: () => undefined,
    storage: localStorage,
    now: () => 1,
  })
  await journal.enqueue(input)
  await vi.waitFor(() => expect(journal.messages()[0]?.delivery?.status).toBe("failed"))
  journal.reconnect()
  expect(request).toHaveBeenCalledTimes(1)
  journal.stop()
})

test("a WebSocket acknowledgement wins over a late network failure", async () => {
  let reject: (error: Error) => void = () => undefined
  const request = vi.fn(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail
      }),
  )
  const events = vi.fn()
  const journal = createSendJournal({
    request: request as ApiRequest,
    emit: events,
    storage: localStorage,
    now: () => 1,
  })
  await journal.enqueue(input)
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
  journal.acknowledge(message())
  reject(new TypeError("response lost"))
  await Promise.resolve()
  expect(journal.messages()).toEqual([])
  expect(events.mock.calls.at(-1)?.[0]).toMatchObject({ message: { delivery: { status: "sent" } } })
  journal.stop()
})

test("local persistence failure preserves the composer by rejecting before a network send", async () => {
  const request = vi.fn()
  const journal = createSendJournal({
    request: request as ApiRequest,
    emit: () => undefined,
    storage: {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota")
      },
    },
    now: () => 1,
  })
  await expect(journal.enqueue(input)).rejects.toThrow("quota")
  expect(request).not.toHaveBeenCalled()
  expect(journal.messages()).toEqual([])
})

test("WebSocket reconnection resumes from the last seq and rejects duplicates and gaps", async () => {
  vi.useFakeTimers()
  class Socket extends EventTarget {
    static instances: Socket[] = []
    close = vi.fn()
    constructor(public url: URL) {
      super()
      Socket.instances.push(this)
    }
  }
  vi.stubGlobal("WebSocket", Socket)
  const api = createApiClient({
    endpoint: { baseUrl: "http://127.0.0.1:1", wsUrl: "ws://127.0.0.1:1/events", token: "token" },
    fetchImpl: async () => Response.json({ schemaVersion: 46, ticket: "single-use-test" }),
  })
  const events: UiEventEnvelope[] = []
  const stop = api.subscribe((event) => events.push(event))
  await vi.advanceTimersByTimeAsync(0)
  const frame = (socket: Socket | undefined, seq: number): void => {
    socket?.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify({ seq, at: 1, event: { type: "run.updated", run } }) }),
    )
  }
  const first = Socket.instances[0]
  first?.dispatchEvent(new Event("open"))
  frame(first, 1)
  frame(first, 1)
  frame(first, 3)
  expect(events.map((event) => event.seq)).toEqual([1])
  expect(first?.close).toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(250)
  const second = Socket.instances[1]
  expect(second?.url.searchParams.get("since")).toBe("1")
  second?.dispatchEvent(new Event("open"))
  frame(second, 2)
  frame(second, 3)
  expect(events.map((event) => event.seq)).toEqual([1, 2, 3])
  stop()
})

test("older snapshots cannot undo a newer transcript revision or add duplicates", () => {
  const current = message()
  const older = {
    ...current,
    updatedSeq: 2,
    text: "Antigo",
    delivery: { ...current.delivery, clientNonce: "nonce", deadline: 1, status: "queued" as const },
  }
  expect(updateMessage([current], older)).toEqual([current])
  expect(updateMessage([current], current)).toHaveLength(1)
})

test("a canceled run never grows or loses its terminal state after reconnect and refresh", async () => {
  const api = createMockApi()
  const stored = api.getState().messages.find((row) => row.role === "assistant")
  if (!stored) throw new Error("Missing fixture message")
  Object.assign(stored, {
    status: "canceled",
    runId: "interrupted-run",
    text: "INÍCIO",
    parts: [{ type: "text", text: "INÍCIO" }],
    updatedSeq: 10,
  })
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))
  const late = {
    ...structuredClone(stored),
    status: "complete" as const,
    text: "INÍCIO FIM",
    parts: [{ type: "text" as const, text: "INÍCIO FIM" }],
    updatedSeq: 12,
  }
  const canceled: Run = { ...run, id: "interrupted-run", threadId: stored.threadId, status: "canceled", finishedAt: 10 }
  act(() => {
    api.emit({ type: "run.updated", run: canceled })
    api.emit({ type: "message.updated", message: { ...late, status: "streaming", updatedSeq: 11 } })
    api.emit({
      type: "message.delta",
      threadId: stored.threadId,
      messageId: stored.id,
      partIndex: 0,
      offset: 6,
      delta: " FIM",
      updatedSeq: 12,
    })
    api.emit({ type: "message.updated", message: late })
    api.emit({ type: "run.updated", run: { ...canceled, status: "succeeded", finishedAt: 12 } })
  })
  expect(hook.result.current.data.runs.find((row) => row.id === canceled.id)?.status).toBe("canceled")
  expect(hook.result.current.data.messages.find((row) => row.id === stored.id)).toMatchObject({
    status: "canceled",
    text: "INÍCIO",
    updatedSeq: 10,
  })
  Object.assign(stored, late)
  const baseRequest = api.request
  api.request = async (route, input, pathValues) =>
    route === "GET /threads/:id/runs" && pathValues?.id === stored.threadId
      ? ({ runs: [{ ...canceled, status: "succeeded", finishedAt: 12 }] } as never)
      : baseRequest(route, input, pathValues)
  await act(async () => hook.result.current.actions.refresh())
  expect(hook.result.current.data.runs.find((row) => row.id === canceled.id)?.status).toBe("canceled")
  expect(hook.result.current.data.messages.find((row) => row.id === stored.id)).toMatchObject({
    status: "canceled",
    text: "INÍCIO",
    updatedSeq: 10,
  })
})

test("delta offsets and revisions prevent gaps, duplicates and stale snapshots, including reasoning", () => {
  const initial = {
    ...message(),
    role: "assistant" as const,
    status: "streaming" as const,
    text: "Olá 🚀",
    parts: [{ type: "text" as const, text: "Olá 🚀" }],
  }
  const delta = {
    type: "message.delta" as const,
    threadId: "thread",
    messageId: initial.id,
    partIndex: 0,
    delta: "Olá 🚀 mundo",
    offset: 0,
    updatedSeq: 5,
    generation: 1,
  }
  const applied = applyDelta([initial], initial.id, delta.delta, 0, delta.offset, delta)
  expect(applied[0]).toMatchObject({ text: "Olá 🚀 mundo", updatedSeq: 5 })
  expect(applyDelta(applied, initial.id, delta.delta, 0, delta.offset, delta)).toEqual(applied)
  expect(updateMessage(applied, initial)).toEqual(applied)
  expect(applyDelta(applied, initial.id, "lacuna", 0, 100, { ...delta, updatedSeq: 6 })).toEqual(applied)
  const reasoning = applyDelta(applied, initial.id, "Análise", 1, 0, { ...delta, partType: "reasoning", updatedSeq: 6 })
  expect(reasoning[0]).toMatchObject({
    text: "Olá 🚀 mundo",
    updatedSeq: 6,
    parts: [{ type: "text" }, { type: "reasoning", text: "Análise" }],
  })
  expect(applyDelta(reasoning, initial.id, "antigo", 0, 0, { ...delta, updatedSeq: 7, generation: 0 })).toEqual(
    reasoning,
  )
})

test("compact part revisions preserve streamed prose, output references and reasoning offsets on replay", () => {
  const initial: Message = {
    ...message(),
    role: "assistant",
    status: "streaming",
    text: "Olá",
    parts: [{ type: "text", text: "Olá" }],
  }
  const patch: Extract<UiEvent, { type: "message.parts" }> = {
    type: "message.parts",
    threadId: initial.threadId,
    messageId: initial.id,
    updatedSeq: 5,
    generation: 1,
    parts: [
      { partIndex: 1, part: { type: "reasoning", text: "Conferindo", estimatedTokens: 120 } },
      {
        partIndex: 2,
        part: {
          type: "command",
          callId: "read",
          command: "cat result.txt",
          cwd: "/project",
          outputTail: "",
          exitCode: 0,
          outputAttachmentId: "output:content-hash",
          outputBytes: 32_000,
        },
      },
    ],
  }
  const applied = applyParts([initial], patch)
  expect(applied[0]).toMatchObject({ text: "Olá", updatedSeq: 5, parts: [initial.parts[0], {}, patch.parts[1]?.part] })
  expect(applyParts(applied, patch)).toEqual(applied)
  expect(applyParts(applied, { ...patch, updatedSeq: 6, generation: 0 })).toEqual(applied)
  expect(applyParts([initial], { ...patch, parts: patch.parts.slice(1) })).toEqual([initial])
  const delta: Extract<UiEvent, { type: "message.delta" }> = {
    type: "message.delta",
    threadId: initial.threadId,
    messageId: initial.id,
    partIndex: 1,
    partType: "reasoning",
    offset: 10,
    delta: " a fila",
    updatedSeq: 6,
    generation: 1,
  }
  const streamed = applyDelta(applied, initial.id, delta.delta, delta.partIndex, delta.offset, delta)
  expect(streamed[0]?.parts[1]).toEqual({ type: "reasoning", text: "Conferindo a fila", estimatedTokens: 120 })
  expect(applyParts(streamed, patch)).toEqual(streamed)
  expect(streamed[0]?.parts[2]).toEqual(patch.parts[1]?.part)
  expect(applyParts([{ ...initial, status: "complete" }], patch)[0]?.status).toBe("complete")
  expect(
    applyParts([initial], {
      ...patch,
      parts: [{ partIndex: 0, part: { type: "reasoning", text: "Conferindo" } }],
    })[0],
  ).toMatchObject({ text: "", parts: [{ type: "reasoning", text: "Conferindo" }] })
})

test("an expired WebSocket cursor signals resync and resumes without reconnecting in a loop", async () => {
  vi.useFakeTimers()
  class Socket extends EventTarget {
    static instances: Socket[] = []
    close = vi.fn()
    constructor(public url: URL) {
      super()
      Socket.instances.push(this)
    }
  }
  vi.stubGlobal("WebSocket", Socket)
  const api = createApiClient({
    endpoint: { baseUrl: "http://127.0.0.1:1", wsUrl: "ws://127.0.0.1:1/events", token: "token" },
    fetchImpl: async () => Response.json({ schemaVersion: 46, ticket: "single-use-test" }),
  })
  const received: UiEventEnvelope[] = []
  const stop = api.subscribe((event) => received.push(event))
  await vi.advanceTimersByTimeAsync(0)
  const socket = Socket.instances[0]
  socket?.dispatchEvent(new Event("open"))
  socket?.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "resync", lastSeq: 400 }) }))
  socket?.dispatchEvent(
    new MessageEvent("message", { data: JSON.stringify({ seq: 401, at: 1, event: { type: "run.updated", run } }) }),
  )
  expect(received.map((row) => row.event.type)).toEqual(["transcript.resync", "run.updated"])
  expect(socket?.close).not.toHaveBeenCalled()
  socket?.dispatchEvent(new Event("close"))
  await vi.advanceTimersByTimeAsync(250)
  expect(Socket.instances[1]?.url.searchParams.get("since")).toBe("401")
  stop()
})

test("a cold start waits for the stream head and loads once instead of replaying history", async () => {
  vi.useFakeTimers()
  class Socket extends EventTarget {
    static instances: Socket[] = []
    close = vi.fn()
    constructor(public url: URL) {
      super()
      Socket.instances.push(this)
    }
  }
  vi.stubGlobal("WebSocket", Socket)
  const api = createApiClient({
    endpoint: { baseUrl: "http://127.0.0.1:1", wsUrl: "ws://127.0.0.1:1/events", token: "token" },
    fetchImpl: async () => Response.json({ schemaVersion: 46, ticket: "single-use-test" }),
  })
  const received: UiEventEnvelope[] = []
  const stop = api.subscribe((event) => received.push(event))
  let ready = false
  void api.cursorReady?.().then(() => {
    ready = true
  })
  await vi.advanceTimersByTimeAsync(0)
  const socket = Socket.instances[0]
  expect(socket?.url.searchParams.get("since")).toBe("0")
  socket?.dispatchEvent(new Event("open"))
  expect(ready).toBe(false)
  socket?.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "resync", lastSeq: 2400 }) }))
  await vi.advanceTimersByTimeAsync(0)
  expect(ready).toBe(true)
  // The pending first load covers history, so the cold frame is not a second reload.
  expect(received).toEqual([])
  socket?.dispatchEvent(
    new MessageEvent("message", { data: JSON.stringify({ seq: 2401, at: 1, event: { type: "run.updated", run } }) }),
  )
  expect(received.map((row) => row.seq)).toEqual([2401])
  // A later expired cursor still asks for a reload.
  socket?.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "resync", lastSeq: 2500 }) }))
  expect(received.map((row) => row.event.type)).toEqual(["run.updated", "transcript.resync"])
  stop()
})

test("the first load does not wait forever for an event socket that never opens", async () => {
  vi.useFakeTimers()
  vi.stubGlobal(
    "WebSocket",
    class extends EventTarget {
      close = vi.fn()
    },
  )
  const api = createApiClient({
    endpoint: { baseUrl: "http://127.0.0.1:1", wsUrl: "ws://127.0.0.1:1/events", token: "token" },
    fetchImpl: async () => Response.json({ schemaVersion: 46, ticket: "single-use-test" }),
  })
  const stop = api.subscribe(() => undefined)
  let ready = false
  void api.cursorReady?.().then(() => {
    ready = true
  })
  await vi.advanceTimersByTimeAsync(2_999)
  expect(ready).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(ready).toBe(true)
  stop()
})

test("reconnecting the event stream does not reload every conversation", async () => {
  const mock = createMockApi()
  const request = vi.fn(mock.request) as unknown as ApiRequest
  let connection: ((connected: boolean) => void) | undefined
  const api = {
    ...mock,
    request,
    isMock: false,
    subscribeConnection: (listener: (connected: boolean) => void) => {
      connection = listener
      return () => undefined
    },
  }
  const view = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(view.result.current.data.loading).toBe(false))
  const loads = () => vi.mocked(request).mock.calls.filter(([route]) => route === "GET /bots").length
  expect(loads()).toBe(1)
  act(() => connection?.(false))
  act(() => connection?.(true))
  await act(async () => undefined)
  expect(loads()).toBe(1)
  view.unmount()
})

test("resync refetches the thread snapshot and replaces text lost outside the retention window", async () => {
  const api = createMockApi()
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))
  const stored = api.getState().messages.find((row) => row.role === "assistant")
  if (!stored) throw new Error("Missing fixture message")
  const callsBefore = api.calls.filter((call) => call.route === "GET /threads/:id/messages").length
  stored.text = "Texto completo recuperado"
  stored.parts = [{ type: "text", text: stored.text }]
  stored.updatedSeq = 100
  act(() => api.emit({ type: "transcript.resync" }))
  await waitFor(() =>
    expect(hook.result.current.data.messages.find((row) => row.id === stored.id)?.text).toBe(stored.text),
  )
  expect(api.calls.filter((call) => call.route === "GET /threads/:id/messages").length).toBeGreaterThan(callsBefore)
})

test("part patches and deltas arriving during a resync replay in order after its snapshot", async () => {
  const base = createMockApi()
  const stored = base.getState().messages.find((row) => row.role === "assistant")
  if (!stored) throw new Error("Missing fixture message")
  Object.assign(stored, { text: "", status: "streaming", parts: [{ type: "text", text: "" }], updatedSeq: 1 })
  let armed = false
  let release: () => void = () => undefined
  let captured: () => void = () => undefined
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const ready = new Promise<void>((resolve) => {
    captured = resolve
  })
  const request: ApiRequest = async (route, input, pathValues) => {
    const response = await base.request(route, input, pathValues)
    if (armed && route === "GET /threads/:id/messages" && pathValues?.id === stored.threadId) {
      const snapshot = structuredClone(response)
      captured()
      await barrier
      return snapshot
    }
    return response
  }
  const api = { ...base, request }
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))
  Object.assign(stored, { text: "Oi", parts: [{ type: "text", text: "Oi" }], updatedSeq: 2 })
  armed = true
  act(() => base.emit({ type: "transcript.resync" }))
  await act(async () => {
    await ready
  })
  const command = {
    type: "command" as const,
    callId: "read",
    command: "cat result.txt",
    cwd: "/project",
    outputTail: "ok",
    exitCode: 0,
  }
  act(() =>
    base.emit({
      type: "message.parts",
      threadId: stored.threadId,
      messageId: stored.id,
      parts: [{ partIndex: 1, part: command }],
      updatedSeq: 3,
      generation: 1,
    }),
  )
  act(() =>
    base.emit({
      type: "message.delta",
      threadId: stored.threadId,
      messageId: stored.id,
      partIndex: 2,
      offset: 0,
      delta: " mundo",
      updatedSeq: 4,
      generation: 1,
    }),
  )
  await act(async () => {
    release()
    await barrier
  })
  await waitFor(() =>
    expect(hook.result.current.data.messages.find((row) => row.id === stored.id)).toMatchObject({
      text: "Oi mundo",
      updatedSeq: 4,
      parts: [{ type: "text", text: "Oi" }, command, { type: "text", text: " mundo" }],
    }),
  )
})

test("an interrupted event consumer resumes from the last applied revision", async () => {
  vi.useFakeTimers()
  class Socket extends EventTarget {
    static instances: Socket[] = []
    close = vi.fn()
    constructor(public url: URL) {
      super()
      Socket.instances.push(this)
    }
  }
  vi.stubGlobal("WebSocket", Socket)
  const api = createApiClient({
    endpoint: { baseUrl: "http://127.0.0.1:1", wsUrl: "ws://127.0.0.1:1/events", token: "token" },
    fetchImpl: async () => Response.json({ schemaVersion: 46, ticket: "single-use-test" }),
  })
  let interrupted = true
  const applied: number[] = []
  const stop = api.subscribe((envelope) => {
    if (interrupted) {
      interrupted = false
      throw new Error("Consumer interrupted")
    }
    applied.push(envelope.seq)
  })
  await vi.advanceTimersByTimeAsync(0)
  const frame = JSON.stringify({ seq: 1, at: 1, event: { type: "message.updated", message: message() } })
  Socket.instances[0]?.dispatchEvent(new Event("open"))
  Socket.instances[0]?.dispatchEvent(new MessageEvent("message", { data: frame }))
  await vi.advanceTimersByTimeAsync(250)
  expect(Socket.instances[1]?.url.searchParams.get("since")).toBe("0")
  Socket.instances[1]?.dispatchEvent(new Event("open"))
  Socket.instances[1]?.dispatchEvent(new MessageEvent("message", { data: frame }))
  expect(applied).toEqual([1])
  stop()
})

test("messages with the same id in different threads remain independent", () => {
  const first = message()
  const second = { ...first, threadId: "other", text: "Outra conversa" }
  expect(updateMessage([first], second)).toEqual([first, second])
  expect(updateMessage([first, second], { ...second, text: "Atualizada" })).toEqual([
    first,
    { ...second, text: "Atualizada" },
  ])
})

test("sends added while awaiting an acknowledgement drain without another reconnect", async () => {
  let complete: (value: typeof response) => void = () => undefined
  const request = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    )
    .mockResolvedValue(response)
  const journal = createSendJournal({
    request: request as ApiRequest,
    emit: () => undefined,
    storage: localStorage,
    now: () => 1,
  })
  await journal.enqueue(input)
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
  await journal.enqueue({ ...input, clientNonce: "next", parentId: "send:nonce" })
  complete(response)
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
  expect(journal.messages()).toEqual([])
  journal.stop()
})

test("a lost HTTP response retries while the event connection remains available", async () => {
  vi.useFakeTimers()
  const request = vi.fn().mockRejectedValueOnce(new TypeError("network")).mockResolvedValue(response)
  const journal = createSendJournal({
    request: request as ApiRequest,
    emit: () => undefined,
    storage: localStorage,
    now: () => 1,
  })
  await journal.enqueue(input)
  await vi.advanceTimersByTimeAsync(500)
  expect(request).toHaveBeenCalledTimes(2)
  expect(request.mock.calls[0]?.[1]).toEqual(request.mock.calls[1]?.[1])
  expect(journal.messages()).toEqual([])
  journal.stop()
})

test("restored offline entries expire without a new send or connection", async () => {
  vi.useFakeTimers()
  let now = 1
  const options = {
    request: vi.fn() as unknown as ApiRequest,
    emit: () => undefined,
    storage: localStorage,
    now: () => now,
  }
  const first = createSendJournal(options)
  first.disconnect()
  await first.enqueue({ ...input, deadline: 10 })
  first.stop()
  const restored = createSendJournal(options)
  restored.disconnect()
  now = 11
  await vi.advanceTimersByTimeAsync(10)
  expect(restored.messages()[0]?.delivery?.status).toBe("failed")
  restored.stop()
})

test("an unused API client cannot expire another client's acknowledged journal", async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1)
  const options = {
    request: vi.fn().mockResolvedValue(response) as unknown as ApiRequest,
    emit: () => undefined,
    storage: localStorage,
  }
  const seed = createSendJournal(options)
  seed.disconnect()
  await seed.enqueue({ ...input, deadline: 10 })
  seed.stop()
  createApiClient({ endpoint: { baseUrl: "http://127.0.0.1:1", wsUrl: "ws://127.0.0.1:1/events", token: "token" } })
  const live = createSendJournal(options)
  live.reconnect()
  await vi.advanceTimersByTimeAsync(20)
  expect(localStorage.getItem("touri.send-journal.v1")).toBe("[]")
  live.stop()
})

test("a pending nonce cannot silently reuse different content", async () => {
  const journal = createSendJournal({
    request: vi.fn() as unknown as ApiRequest,
    emit: () => undefined,
    storage: localStorage,
    now: () => 1,
  })
  journal.disconnect()
  await journal.enqueue(input)
  await expect(journal.enqueue({ ...input, text: "Outra mensagem" })).rejects.toMatchObject({
    errorCode: "NONCE_CONFLICT",
  })
  expect(journal.messages()).toHaveLength(1)
  journal.stop()
})

test("delivery states and interrupted tools render in Portuguese", () => {
  const rows = ["queued", "sent", "acked", "failed"].map((status, index) => ({
    ...message(status as NonNullable<Message["delivery"]>["status"]),
    id: `m${index}`,
  }))
  rows.push({
    ...message(),
    id: "assistant",
    role: "assistant",
    status: "streaming",
    parts: [
      {
        type: "tool_call",
        callId: "call",
        tool: "read",
        summary: "",
        inputJson: "{}",
        outputJson: null,
        ok: null,
        resolution: "interrupted",
        resolvedAt: 1,
      },
    ],
  })
  const view = render(
    <VirtualMessageList messages={rows} onSwitchBranch={() => undefined} onRetry={async () => undefined} />,
  )
  const activity = view.container.querySelector<HTMLButtonElement>(".turn-activity-toggle")
  expect(activity).not.toBeNull()
  if (activity) fireEvent.click(activity)
  for (const label of ["Na fila · aguardando conexão", "Enviando…", "Entregue", "Falha na entrega", "Encerrado"])
    expect(screen.getByText(label)).toBeInTheDocument()
  expect(screen.queryByText("Em execução")).toBeNull()
})

test("an interrupted run with a streaming snapshot renders interruption and retry, never Cancelado", () => {
  const reply: Message = {
    ...message(),
    role: "assistant",
    runId: "run",
    status: "streaming",
    text: "INÍCIO",
    parts: [{ type: "text", text: "INÍCIO" }],
  }
  render(
    <VirtualMessageList
      messages={[reply]}
      runs={[{ ...run, status: "interrupted", errorClass: "app_restart" }]}
      onSwitchBranch={() => undefined}
      onRetry={async () => undefined}
    />,
  )
  expect(screen.getByText("A resposta foi interrompida. Algumas ações podem ter sido concluídas.")).toBeVisible()
  expect(screen.getByRole("button", { name: "Retomar tarefa" })).toBeVisible()
  expect(screen.queryByText("Cancelado")).toBeNull()
})

test("a restored live run exposes Parar and continues streaming until completion", async () => {
  const api = createMockApi()
  const stored = api.getState().messages.find((row) => row.role === "assistant")
  if (!stored) throw new Error("Missing fixture message")
  const active: Run = { ...run, id: "live-run", threadId: stored.threadId, status: "running", finishedAt: null }
  Object.assign(stored, {
    status: "streaming",
    runId: active.id,
    text: "INÍCIO",
    parts: [{ type: "text", text: "INÍCIO" }],
    updatedSeq: 10,
  })
  const request: ApiRequest = async (route, input, pathValues) =>
    route === "GET /threads/:id/runs" && pathValues?.id === stored.threadId
      ? ({ runs: [active] } as never)
      : api.request(route, input, pathValues)
  render(<App kernel={{ services: { api: { ...api, request } } }} />)
  const composer = await screen.findByRole("form", { name: "Compor mensagem" })
  expect(await within(composer).findByRole("button", { name: "Parar" }, { timeout: 5000 })).toBeVisible()
  act(() =>
    api.emit({
      type: "message.delta",
      threadId: stored.threadId,
      messageId: stored.id,
      partIndex: 0,
      offset: 6,
      delta: " FIM",
      updatedSeq: 11,
    }),
  )
  expect(await within(screen.getByTestId("virtual-message-list")).findByText("INÍCIO FIM")).toBeVisible()
  act(() => {
    api.emit({
      type: "message.updated",
      message: {
        ...stored,
        status: "complete",
        text: "INÍCIO FIM",
        parts: [{ type: "text", text: "INÍCIO FIM" }],
        updatedSeq: 12,
      },
    })
    api.emit({ type: "run.updated", run: { ...active, status: "succeeded", finishedAt: 20 } })
  })
  await waitFor(() => expect(screen.queryByRole("button", { name: "Parar" })).toBeNull())
  expect(screen.queryByText("Cancelado")).toBeNull()
})

test("a loaded workspace keeps the composer available to queue messages while offline", async () => {
  const mock = createMockApi()
  const connection = makeConnectionEvents()
  const sendMessage = vi.fn(
    async (input: Parameters<NonNullable<import("../src/api/client").UiApi["sendMessage"]>>[0]) => ({
      message: { ...message("queued"), threadId: input.threadId, parentId: input.parentId, text: input.text },
      run: null,
    }),
  )
  const api = {
    ...mock,
    ...connection,
    isMock: false,
    sendMessage,
  }
  render(<App kernel={{ services: { api } }} />)
  const composer = await screen.findByRole("textbox", { name: /Mensagem para/ })
  act(() => connection.emitConnection(false))
  expect(screen.getByText("Reconectando…")).toBeVisible()
  fireEvent.change(composer, { target: { value: "Enviar quando voltar" } })
  fireEvent.click(screen.getByRole("button", { name: "Enviar" }))
  await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
  expect(await screen.findByText("Na fila · aguardando conexão")).toBeVisible()
})
