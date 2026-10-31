import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import type { Message, Run } from "@touri/contracts"
import { afterEach, expect, test } from "vitest"
import App from "../src/App"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { pendingApprovalTargets } from "../src/approvalNavigation"
import { latestPreview } from "../src/botPreview"
import { ApiError } from "../src/errors"
import { useWorkspace } from "../src/useWorkspace"
import { TranscriptBuffer } from "../src/workspaceMemory"

afterEach(cleanup)

const deferred = () => {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const offscreenMessage = (api: ReturnType<typeof createMockApi>): Message => {
  const original = api.getState().messages[0]
  if (!original) throw new Error("Missing message fixture")
  const message = {
    ...structuredClone(original),
    id: "offscreen-message",
    threadId: "thread-onb",
    role: "assistant" as const,
  }
  api.getState().messages.push(message)
  return message
}

test("134 threads across 15 bots request only the selected history and render before it arrives", async () => {
  const api = createMockApi()
  const state = api.getState()
  const bot = state.bots[0]
  const thread = state.threads[0]
  if (!bot || !thread) throw new Error("Missing bot fixture")
  state.bots.splice(
    0,
    state.bots.length,
    ...Array.from({ length: 15 }, (_, index) => ({ ...bot, id: `bot-${index}`, mainThreadId: `thread-${index}` })),
  )
  state.threads.splice(
    0,
    state.threads.length,
    ...Array.from({ length: 134 }, (_, index) => ({
      ...thread,
      id: `thread-${index}`,
      botId: `bot-${index % 15}`,
      updatedAt: index,
    })),
  )
  state.messages.splice(0)
  const barrier = deferred()
  const request: ApiRequest = async (route, input, path) => {
    const response = await api.request(route, input, path)
    if (route === "GET /threads/:id/messages" || route === "GET /threads/:id/runs") await barrier.promise
    return response
  }
  const client = { ...api, request }
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(api.calls.filter((call) => call.route === "GET /threads/:id/messages")).toHaveLength(1))
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))
  expect(hook.result.current.data.bots).toHaveLength(15)
  expect(hook.result.current.data.threads).toHaveLength(134)
  expect(hook.result.current.data.selectedThreadId).toBe("thread-120")
  expect(
    api.calls.filter((call) => call.route === "GET /threads/:id/messages").map((call) => call.pathValues.id),
  ).toEqual(["thread-120"])
  expect(api.calls.filter((call) => call.route === "GET /threads/:id/runs").map((call) => call.pathValues.id)).toEqual([
    "thread-120",
  ])
  await act(async () => barrier.resolve())
})

test("selection retains a cached page and reloads background events from durable history", async () => {
  const api = createMockApi()
  offscreenMessage(api)
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() =>
    expect(hook.result.current.data.messages.some((message) => message.threadId === "thread-mark")).toBe(true),
  )
  expect(hook.result.current.data.messages.some((message) => message.threadId === "thread-onb")).toBe(false)
  const original = hook.result.current.data.messages[0]
  if (!original) throw new Error("Missing message fixture")
  const reply = { ...original, id: "live-reply", threadId: "thread-onb", text: "Live reply", updatedSeq: 100 }
  api.getState().messages.push(reply)
  act(() => {
    api.emit({
      type: "message.created",
      message: reply,
    })
    hook.result.current.actions.selectLocation({ bot: "bot-onb", thread: "thread-onb" })
  })
  await waitFor(() =>
    expect(
      hook.result.current.data.messages.some(
        (message) => message.threadId === "thread-onb" && message.id !== "live-reply",
      ),
    ).toBe(true),
  )
  expect(hook.result.current.data.messages).not.toContainEqual(original)
  expect(hook.result.current.data.messages.find((message) => message.id === "live-reply")?.text).toBe("Live reply")
  act(() => hook.result.current.actions.selectBot("bot-mark"))
  await waitFor(() => expect(hook.result.current.data.messages).toContainEqual(original))
  expect(hook.result.current.data.messages.every((message) => message.threadId === "thread-mark")).toBe(true)
  expect(
    api.calls.filter((call) => call.route === "GET /threads/:id/messages" && call.pathValues.id === "thread-mark"),
  ).toHaveLength(1)
})

test("a thousand background replies retain only small activity summaries", async () => {
  const api = createMockApi()
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(hook.result.current.data.messages.length).toBeGreaterThan(0))
  const original = api.getState().messages[0]
  if (!original) throw new Error("Missing message fixture")
  for (let batch = 0; batch < 10; batch++) {
    act(() => {
      for (let n = batch * 100; n < (batch + 1) * 100; n++) {
        const text = `${n}: ${"background output ".repeat(4000)}`
        api.emit({
          type: "message.created",
          message: {
            ...original,
            id: `background-${n}`,
            threadId: "thread-onb",
            role: "assistant",
            text,
            parts: [{ type: "text", text }],
            createdAt: n + 1,
            updatedAt: n + 1,
          },
        })
      }
    })
  }
  expect(hook.result.current.data.messages.every((message) => message.threadId === "thread-mark")).toBe(true)
  const summaries = hook.result.current.data.activityMessages.filter((message) => message.threadId === "thread-onb")
  expect(summaries.length).toBeLessThanOrEqual(5)
  expect(JSON.stringify(summaries).length).toBeLessThan(10_000)
  expect(summaries.some((message) => message.id === "background-999")).toBe(true)
})

test("background previews append new prose parts and ignore replayed revisions", async () => {
  const api = createMockApi()
  const reply = offscreenMessage(api)
  Object.assign(reply, {
    status: "streaming",
    text: "Primeiro trecho. ",
    parts: [
      { type: "text", text: "Primeiro trecho. " },
      { type: "command", callId: "preview-command", command: "pwd", cwd: "/project", outputTail: "", exitCode: 0 },
    ],
    updatedSeq: 1,
  })
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))
  const preview = () => hook.result.current.data.activityMessages.find((message) => message.id === reply.id)?.text
  const delta = {
    type: "message.delta" as const,
    threadId: reply.threadId,
    messageId: reply.id,
    partIndex: 2,
    offset: 0,
    delta: "Continuação após a ferramenta.",
    updatedSeq: 2,
  }
  act(() => api.emit(delta))
  expect(preview()).toBe(`Primeiro trecho. ${delta.delta}`)
  act(() => api.emit(delta))
  expect(preview()).toBe(`Primeiro trecho. ${delta.delta}`)
  act(() => api.emit({ ...delta, offset: delta.delta.length, delta: "x".repeat(1000), updatedSeq: 3 }))
  expect(preview()).toHaveLength(512)
  expect(hook.result.current.data.messages.some((message) => message.threadId === reply.threadId)).toBe(false)
})

test("resolved background approvals are evicted before their notifications rotate out", async () => {
  const api = createMockApi()
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))
  const original = api.getState().messages[0]
  if (!original) throw new Error("Missing message fixture")
  const started = Date.now()
  for (let batch = 0; batch < 24; batch++)
    act(() => {
      for (let n = batch * 10; n < (batch + 1) * 10; n++) {
        const requestId = `memory-approval-${n}`
        api.emit({
          type: "message.created",
          message: {
            ...original,
            id: requestId,
            threadId: "thread-onb",
            role: "assistant",
            status: "streaming",
            text: "Approval",
            createdAt: started + n,
            updatedAt: started + n,
            parts: [
              { type: "approval", approvalId: requestId, request: "command", detail: "pwd", decision: "pending" },
            ],
          },
        })
        const notification = api.notify({
          kind: "approval",
          title: "Approval",
          body: "Command",
          botId: "bot-onb",
          threadId: "thread-onb",
          requestId,
        })
        api.emit({
          type: "notification.resolved",
          notification: {
            ...notification,
            resolvedAt: started + n,
            resolution: "allow",
          },
        })
      }
    })
  const summaries = hook.result.current.data.activityMessages.filter((message) =>
    message.id.startsWith("memory-approval-"),
  )
  expect(summaries.length).toBeLessThanOrEqual(5)
  expect(pendingApprovalTargets(summaries)).toHaveLength(0)
})

test("a slow offscreen history response cannot restore an evicted transcript", async () => {
  const api = createMockApi()
  offscreenMessage(api)
  const barrier = deferred()
  const request: ApiRequest = async (route, input, path) => {
    const response = await api.request(route, input, path)
    if (route === "GET /threads/:id/messages" && path?.id === "thread-mark") await barrier.promise
    return response
  }
  const client = { ...api, request }
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(api.calls.some((call) => call.route === "GET /threads/:id/messages")).toBe(true))
  act(() => hook.result.current.actions.selectBot("bot-onb"))
  await waitFor(() =>
    expect(hook.result.current.data.messages.some((message) => message.threadId === "thread-onb")).toBe(true),
  )
  await act(async () => barrier.resolve())
  expect(hook.result.current.data.messages.every((message) => message.threadId === "thread-onb")).toBe(true)
})

test("snapshot overlap buffers discard overflow and require a fresh snapshot", () => {
  const buffer = new TranscriptBuffer()
  for (let n = 0; n < 10_000; n++)
    buffer.push({
      type: "message.delta",
      threadId: "thread",
      messageId: "message",
      partIndex: 0,
      delta: "output ".repeat(100),
    })
  expect(buffer.overflow).toBe(true)
  expect(buffer.events).toHaveLength(0)
  const oversized = new TranscriptBuffer()
  oversized.push({
    type: "message.delta",
    threadId: "thread",
    messageId: "message",
    partIndex: 0,
    delta: "x".repeat(2 * 1024 * 1024),
  })
  expect(oversized.overflow).toBe(true)
  expect(oversized.events).toHaveLength(0)
})

test("overflow during a slow selected snapshot reloads the current server revision", async () => {
  const api = createMockApi()
  const stored = api
    .getState()
    .messages.find((message) => message.role === "assistant" && message.threadId === "thread-mark")
  if (!stored) throw new Error("Missing message fixture")
  Object.assign(stored, { status: "streaming", text: "", parts: [{ type: "text", text: "" }], updatedSeq: 1 })
  const barrier = deferred()
  let reads = 0
  const request: ApiRequest = async (route, input, path) => {
    const response = structuredClone(await api.request(route, input, path))
    if (route === "GET /threads/:id/messages" && ++reads === 1) await barrier.promise
    return response
  }
  const client = { ...api, request }
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(reads).toBe(1))
  act(() => {
    for (let n = 0; n < 600; n++)
      api.emit({
        type: "message.delta",
        threadId: stored.threadId,
        messageId: stored.id,
        partIndex: 0,
        offset: n,
        delta: "x",
        updatedSeq: n + 2,
      })
  })
  Object.assign(stored, {
    text: "Current server revision",
    parts: [{ type: "text", text: "Current server revision" }],
    updatedSeq: 1000,
  })
  await act(async () => barrier.resolve())
  await waitFor(() => expect(reads).toBe(2))
  await waitFor(() =>
    expect(hook.result.current.data.messages.find((message) => message.id === stored.id)?.text).toBe(
      "Current server revision",
    ),
  )
})

test("an invalid saved selection never downloads another bot's history", async () => {
  localStorage.setItem("touri.workspace.v1", JSON.stringify({ botId: "bot-mark", threadId: "thread-onb" }))
  const api = createMockApi()
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(hook.result.current.data.messages.length).toBeGreaterThan(0))
  expect(hook.result.current.data.selectedThreadId).toBe("thread-mark")
  expect(
    api.calls.filter((call) => call.route === "GET /threads/:id/messages").map((call) => call.pathValues.id),
  ).toEqual(["thread-mark"])
})

test("activity preserves offscreen previews and approvals without seeding truncated transcript rows", async () => {
  const api = createMockApi()
  const original = offscreenMessage(api)
  if (!original) throw new Error("Missing message fixture")
  original.text = "Resposta completa ".repeat(100)
  original.parts = [
    { type: "approval", approvalId: "offscreen-approval", request: "command", detail: "pwd", decision: "pending" },
  ]
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))
  expect(latestPreview({ threadIds: ["thread-onb"], messages: hook.result.current.data.activityMessages })).toContain(
    "Resposta completa",
  )
  expect(
    pendingApprovalTargets(hook.result.current.data.activityMessages).some(
      (target) => target.threadId === "thread-onb",
    ),
  ).toBe(true)
  expect(hook.result.current.data.messages.some((message) => message.threadId === "thread-onb")).toBe(false)
  act(() => hook.result.current.actions.selectBot("bot-onb"))
  await waitFor(() =>
    expect(hook.result.current.data.messages.find((message) => message.id === original.id)?.text).toBe(original.text),
  )
})

test("deltas for an unopened thread do not trigger history downloads", async () => {
  const api = createMockApi()
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))
  await act(async () => {
    api.emit({
      type: "message.delta",
      threadId: "thread-onb",
      messageId: "missing",
      delta: "Background",
      partIndex: 0,
      offset: 50,
    })
  })
  expect(
    api.calls
      .filter((call) => call.route === "GET /threads/:id/messages")
      .every((call) => call.pathValues.id === "thread-mark"),
  ).toBe(true)
})

test("a selected thread replays the delta that triggered snapshot recovery", async () => {
  const api = createMockApi()
  const stored = api.getState().messages.find((message) => message.role === "assistant")
  if (!stored) throw new Error("Missing message fixture")
  Object.assign(stored, { status: "streaming", text: "", parts: [{ type: "text", text: "" }], updatedSeq: 1 })
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() =>
    expect(hook.result.current.data.messages.find((message) => message.id === stored.id)).toBeDefined(),
  )
  Object.assign(stored, { text: "Oi", parts: [{ type: "text", text: "Oi" }], updatedSeq: 2 })
  act(() =>
    api.emit({
      type: "message.delta",
      threadId: stored.threadId,
      messageId: stored.id,
      partIndex: 0,
      offset: 2,
      delta: " mundo",
      updatedSeq: 3,
    }),
  )
  await waitFor(() =>
    expect(hook.result.current.data.messages.find((message) => message.id === stored.id)?.text).toBe("Oi mundo"),
  )
})

test("startup prefers a running thread from the activity snapshot without reading other histories", async () => {
  const api = createMockApi()
  const active = (await api.request("GET /threads/:id/runs", {}, { id: "thread-onb" })).runs[0]
  if (!active) throw new Error("Missing run fixture")
  const thread = (await api.request("POST /threads", { botId: "bot-mark", title: "Running" })).thread
  thread.updatedAt = 1
  const request: ApiRequest = async (route, input, path) => {
    if (route === "GET /workspace/activity")
      return {
        messages: [],
        runs: [{ ...active, id: "background-run", botId: "bot-mark", threadId: thread.id }],
      } as never
    return api.request(route, input, path)
  }
  api.calls.splice(0)
  const client = { ...api, request }
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(hook.result.current.data.selectedThreadId).toBe(thread.id))
  expect(
    api.calls.filter((call) => call.route === "GET /threads/:id/messages").map((call) => call.pathValues.id),
  ).toEqual([thread.id])
})

test("refresh clears cached active runs that completed while disconnected", async () => {
  const api = createMockApi()
  let disconnected = false
  const request: ApiRequest = async (route, input, path) => {
    if (route === "GET /workspace/activity" && disconnected) return { messages: [], runs: [] } as never
    if (route === "GET /runs" && disconnected) return { runs: [] } as never
    return api.request(route, input, path)
  }
  const client = { ...api, request }
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))
  expect(hook.result.current.data.runs.some((run) => run.threadId === "thread-onb" && run.status === "running")).toBe(
    true,
  )
  disconnected = true
  await act(async () => hook.result.current.actions.refresh())
  expect(hook.result.current.data.runs.some((run) => run.threadId === "thread-onb" && run.status === "running")).toBe(
    false,
  )
})

test("a stale activity snapshot cannot revive a completed run evicted by a newer run", async () => {
  const api = createMockApi()
  const barrier = deferred()
  let hold = false
  let waiting = false
  const request: ApiRequest = async (route, input, path) => {
    const response = structuredClone(await api.request(route, input, path))
    if (route === "GET /workspace/activity" && hold) {
      waiting = true
      await barrier.promise
    }
    return response
  }
  const client = { ...api, request }
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))
  const active = hook.result.current.data.runs.find((run) => run.threadId === "thread-onb" && run.status === "running")
  if (!active) throw new Error("Missing active run fixture")
  hold = true
  let refresh = Promise.resolve()
  act(() => {
    refresh = hook.result.current.actions.refresh()
  })
  await waitFor(() => expect(waiting).toBe(true))
  act(() => {
    api.emit({ type: "run.updated", run: { ...active, status: "succeeded", finishedAt: Date.now() } })
    api.emit({
      type: "run.updated",
      run: {
        ...active,
        id: "newer-completed-run",
        status: "succeeded",
        queuedAt: active.queuedAt + 1,
        finishedAt: Date.now(),
      },
    })
  })
  expect(hook.result.current.data.runs.some((run) => run.id === active.id)).toBe(false)
  await act(async () => {
    barrier.resolve()
    await refresh
  })
  expect(hook.result.current.data.runs.some((run) => run.id === active.id && run.status === "running")).toBe(false)
})

test("returning during a history load keeps fresh messages and terminal runs after the old response", async () => {
  const api = createMockApi()
  const message = offscreenMessage(api)
  const barrier = deferred()
  let waiting = false
  let reads = 0
  let storedRuns: Run[] | null = null
  const request: ApiRequest = async (route, input, path) => {
    const response = structuredClone(await api.request(route, input, path))
    if (route === "GET /threads/:id/runs" && path?.id === "thread-onb") {
      reads++
      if (storedRuns) return { runs: structuredClone(storedRuns) } as never
      waiting = true
      await barrier.promise
    }
    return response
  }
  const client = { ...api, request }
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))
  const active = hook.result.current.data.runs.find((run) => run.threadId === "thread-onb" && run.status === "running")
  if (!active) throw new Error("Missing active run fixture")
  act(() => hook.result.current.actions.selectThread("thread-onb"))
  await waitFor(() => expect(waiting).toBe(true))
  act(() => hook.result.current.actions.selectThread("thread-mark"))
  const completed: Run = { ...active, status: "succeeded", finishedAt: Date.now() }
  const newer: Run = { ...completed, id: "newer-completed-run", queuedAt: active.queuedAt + 1 }
  storedRuns = [completed, newer]
  act(() => {
    Object.assign(message, {
      text: "Histórico atual",
      parts: [{ type: "text", text: "Histórico atual" }],
      updatedSeq: (message.updatedSeq ?? 0) + 100,
    })
    api.emit({ type: "message.updated", message })
    api.emit({ type: "run.updated", run: completed })
    api.emit({ type: "run.updated", run: newer })
  })
  expect(hook.result.current.data.runs.some((run) => run.id === active.id)).toBe(false)
  act(() => hook.result.current.actions.selectThread("thread-onb"))
  await waitFor(() => expect(reads).toBe(2))
  await waitFor(() =>
    expect(hook.result.current.data.messages.find((row) => row.id === message.id)?.text).toBe("Histórico atual"),
  )
  await act(async () => barrier.resolve())
  expect(hook.result.current.data.messages.find((row) => row.id === message.id)?.text).toBe("Histórico atual")
  expect(hook.result.current.data.runs.find((run) => run.id === active.id)?.status).toBe("succeeded")
})

test("a group transcript loads only after opening the group", async () => {
  const api = createMockApi()
  const group = await api.request("POST /groups", {
    name: "Team",
    color: "#888888",
    avatarShape: "circle",
    memberIds: ["bot-mark", "bot-onb"],
    coordinatorBotId: null,
  })
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))
  expect(
    api.calls
      .filter((call) => call.route === "GET /threads/:id/messages")
      .some((call) => call.pathValues.id === group.thread.id),
  ).toBe(false)
  act(() => hook.result.current.actions.selectThread(group.thread.id))
  await waitFor(() =>
    expect(
      api.calls
        .filter((call) => call.route === "GET /threads/:id/messages")
        .some((call) => call.pathValues.id === group.thread.id),
    ).toBe(true),
  )
})

test("search finds an older message in an unopened thread without loading its history", async () => {
  const api = createMockApi()
  const state = api.getState()
  const original = offscreenMessage(api)
  if (!original) throw new Error("Missing message fixture")
  state.messages.push({
    ...original,
    id: "older-result",
    text: "Needle archive",
    createdAt: 1,
    updatedAt: 1,
  } satisfies Message)
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  fireEvent.click(screen.getByRole("button", { name: "Buscar conversas" }))
  fireEvent.change(await screen.findByRole("combobox"), { target: { value: "Needle" } })
  expect(await screen.findByText("Needle archive")).toBeVisible()
  expect(api.calls.some((call) => call.route === "GET /search")).toBe(true)
  expect(
    api.calls
      .filter((call) => call.route === "GET /threads/:id/messages")
      .every((call) => call.pathValues.id === "thread-mark"),
  ).toBe(true)
})

test("selected messages become readable while the independent run snapshot is still pending", async () => {
  const api = createMockApi()
  const barrier = deferred()
  const request: ApiRequest = async (route, input, path) => {
    const response = await api.request(route, input, path)
    if (route === "GET /threads/:id/runs") await barrier.promise
    return response
  }
  const client = { ...api, request }
  const hook = renderHook(() => useWorkspace(client))

  await waitFor(() => expect(hook.result.current.data.historyThreadId).toBe("thread-mark"))

  expect(hook.result.current.data.messages.some((message) => message.threadId === "thread-mark")).toBe(true)
  expect(hook.result.current.data.historyNotice).toBeNull()
  await act(async () => barrier.resolve())
})

test("a failed run snapshot cannot hide the successfully loaded transcript", async () => {
  const api = createMockApi()
  const messages = deferred()
  const failure = new ApiError(502, "Synthetic run read failure")
  const request: ApiRequest = async (route, input, path) => {
    if (route === "GET /threads/:id/messages") await messages.promise
    if (route === "GET /threads/:id/runs") throw failure
    return api.request(route, input, path)
  }
  const client = { ...api, request }
  const hook = renderHook(() => useWorkspace(client))

  // A run failure on a working server waits for its transcript read to tell it from a stopped server.
  await act(async () => messages.resolve())
  await waitFor(() => expect(hook.result.current.data.notice).toContain(failure.message))
  await waitFor(() => expect(hook.result.current.data.historyThreadId).toBe("thread-mark"))

  expect(hook.result.current.data.messages.some((message) => message.threadId === "thread-mark")).toBe(true)
  expect(hook.result.current.data.historyNotice).toBeNull()
  expect(hook.result.current.data.notice).toContain("Synthetic run read failure")
})

test("a streaming gap can reload readable messages while the old run snapshot is pending", async () => {
  const api = createMockApi()
  const stored = api
    .getState()
    .messages.find((message) => message.role === "assistant" && message.threadId === "thread-mark")
  if (!stored) throw new Error("Missing message fixture")
  Object.assign(stored, { status: "streaming", text: "Oi", parts: [{ type: "text", text: "Oi" }], updatedSeq: 1 })
  const barrier = deferred()
  const request: ApiRequest = async (route, input, path) => {
    const response = structuredClone(await api.request(route, input, path))
    if (route === "GET /threads/:id/runs") await barrier.promise
    return response
  }
  const client = { ...api, request }
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(hook.result.current.data.historyThreadId).toBe("thread-mark"))
  Object.assign(stored, { text: "Oi mundo", parts: [{ type: "text", text: "Oi mundo" }], updatedSeq: 2 })

  act(() =>
    api.emit({
      type: "message.delta",
      threadId: stored.threadId,
      messageId: stored.id,
      partIndex: 0,
      offset: 8,
      delta: "!",
      updatedSeq: 3,
    }),
  )

  await waitFor(() =>
    expect(hook.result.current.data.messages.find((message) => message.id === stored.id)?.text).toBe("Oi mundo!"),
  )
  await act(async () => barrier.resolve())
  expect(hook.result.current.data.messages.find((message) => message.id === stored.id)?.text).toBe("Oi mundo!")
})

test.each(["events", "bytes"])("%s overflow recovers messages while runs remain held", async (limit) => {
  const api = createMockApi()
  const stored = api
    .getState()
    .messages.find((message) => message.role === "assistant" && message.threadId === "thread-mark")
  if (!stored) throw new Error("Missing message fixture")
  Object.assign(stored, { status: "streaming", text: "", parts: [{ type: "text", text: "" }], updatedSeq: 1 })
  const messages = deferred()
  const runs = deferred()
  let reads = 0
  const request: ApiRequest = async (route, input, path) => {
    const response = structuredClone(await api.request(route, input, path))
    if (route === "GET /threads/:id/runs") await runs.promise
    if (route === "GET /threads/:id/messages" && ++reads === 1) await messages.promise
    return response
  }
  const client = { ...api, request }
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(reads).toBe(1))

  act(() => {
    Array.from({ length: limit === "events" ? 513 : 1 }, (_, index) =>
      api.emit({
        type: "message.delta",
        threadId: stored.threadId,
        messageId: stored.id,
        partIndex: 0,
        offset: index,
        delta: limit === "bytes" ? "x".repeat(140_000) : "x",
        updatedSeq: index + 2,
      }),
    )
  })
  Object.assign(stored, {
    text: "Revisão atual",
    parts: [{ type: "text", text: "Revisão atual" }],
    updatedSeq: 1000,
  })
  await act(async () => messages.resolve())

  await waitFor(() => expect(reads).toBe(2))
  await waitFor(() => expect(hook.result.current.data.historyThreadId).toBe(stored.threadId))
  expect(hook.result.current.data.messages.find((message) => message.id === stored.id)?.text).toBe("Revisão atual")
  await act(async () => runs.resolve())
  expect(hook.result.current.data.messages.find((message) => message.id === stored.id)?.text).toBe("Revisão atual")
})

test("a held run snapshot cannot revive a terminal run after its row is pruned", async () => {
  const api = createMockApi()
  const barrier = deferred()
  let reads = 0
  let storedRuns: Run[] | null = null
  const request: ApiRequest = async (route, input, path) => {
    const response = structuredClone(await api.request(route, input, path))
    if (route === "GET /threads/:id/runs" && path?.id === "thread-onb") {
      reads++
      if (storedRuns) return { runs: storedRuns } as never
      await barrier.promise
    }
    return response
  }
  const client = { ...api, request }
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(hook.result.current.data.historyThreadId).toBe("thread-mark"))
  const active = hook.result.current.data.runs.find((run) => run.threadId === "thread-onb" && run.status === "running")
  if (!active) throw new Error("Missing active run fixture")

  act(() => hook.result.current.actions.selectThread(active.threadId))
  await waitFor(() => expect(reads).toBe(1))
  const completed: Run = { ...active, status: "succeeded", finishedAt: Date.now() }
  const newer: Run = { ...completed, id: "newer-completed-run", queuedAt: active.queuedAt + 1 }
  act(() => {
    api.emit({ type: "run.updated", run: completed })
    api.emit({ type: "run.updated", run: newer })
  })
  // Batched navigation prunes the terminal row before selection effects abandon the pending read.
  act(() => {
    hook.result.current.actions.selectThread("thread-mark")
    hook.result.current.actions.selectThread(active.threadId)
  })
  expect(hook.result.current.data.runs.some((run) => run.id === active.id)).toBe(false)
  storedRuns = [completed, newer]
  await act(async () => barrier.resolve())

  await waitFor(() => expect(reads).toBe(2))
  expect(hook.result.current.data.runs.some((run) => run.id === active.id && run.status === "running")).toBe(false)
  expect(hook.result.current.data.runs.find((run) => run.id === newer.id)?.status).toBe("succeeded")
})

test("a late run failure cannot replace the new selection's notice or transcript", async () => {
  const api = createMockApi()
  const barrier = deferred()
  const request: ApiRequest = async (route, input, path) => {
    if (route === "GET /threads/:id/runs" && path?.id === "thread-mark") {
      await barrier.promise
      throw new Error("Synthetic old selection failure")
    }
    return api.request(route, input, path)
  }
  const client = { ...api, request }
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(hook.result.current.data.historyThreadId).toBe("thread-mark"))

  act(() => hook.result.current.actions.selectThread("thread-onb"))
  await waitFor(() => expect(hook.result.current.data.historyThreadId).toBe("thread-onb"))
  await act(async () => barrier.resolve())

  expect(hook.result.current.data.messages.every((message) => message.threadId === "thread-onb")).toBe(true)
  expect(hook.result.current.data.historyNotice).toBeNull()
  expect(hook.result.current.data.notice).toBeNull()
})

test("run metadata publishes while the independent message snapshot is still pending", async () => {
  const api = createMockApi()
  const active = (await api.request("GET /threads/:id/runs", {}, { id: "thread-onb" })).runs[0]
  if (!active) throw new Error("Missing run fixture")
  const run: Run = { ...active, id: "selected-snapshot-run", threadId: "thread-mark", botId: "bot-mark" }
  const messages = deferred()
  const request: ApiRequest = async (route, input, path) => {
    if (route === "GET /threads/:id/messages") await messages.promise
    if (route === "GET /threads/:id/runs") return { runs: [run] } as never
    return api.request(route, input, path)
  }
  const client = { ...api, request }
  const hook = renderHook(() => useWorkspace(client))

  await waitFor(() => expect(hook.result.current.data.runs.some((row) => row.id === run.id)).toBe(true))

  expect(hook.result.current.data.historyThreadId).not.toBe("thread-mark")
  await act(async () => messages.resolve())
  await waitFor(() => expect(hook.result.current.data.historyThreadId).toBe("thread-mark"))
})

test("a message repair preserves a previous run failure until run metadata recovers", async () => {
  const api = createMockApi()
  const stored = api
    .getState()
    .messages.find((message) => message.role === "assistant" && message.threadId === "thread-mark")
  if (!stored) throw new Error("Missing message fixture")
  Object.assign(stored, { status: "streaming", text: "Oi", parts: [{ type: "text", text: "Oi" }], updatedSeq: 1 })
  const runs = deferred()
  const failure = new ApiError(502, "Synthetic run read failure")
  let runReads = 0
  const request: ApiRequest = async (route, input, path) => {
    const response = structuredClone(await api.request(route, input, path))
    if (route === "GET /threads/:id/runs") {
      if (++runReads === 1) throw failure
      await runs.promise
    }
    return response
  }
  const client = { ...api, request }
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(hook.result.current.data.historyThreadId).toBe(stored.threadId))
  await waitFor(() => expect(hook.result.current.data.notice).toContain(failure.message))
  Object.assign(stored, { text: "Oi mundo", parts: [{ type: "text", text: "Oi mundo" }], updatedSeq: 2 })

  act(() =>
    api.emit({
      type: "message.delta",
      threadId: stored.threadId,
      messageId: stored.id,
      partIndex: 0,
      offset: 8,
      delta: "!",
      updatedSeq: 3,
    }),
  )

  await waitFor(() =>
    expect(hook.result.current.data.messages.find((message) => message.id === stored.id)?.text).toBe("Oi mundo!"),
  )
  expect(hook.result.current.data.notice).toContain(failure.message)
  await act(async () => runs.resolve())
  expect(hook.result.current.data.notice).toBeNull()
})

test("message repairs cancel superseded reads instead of accumulating held run requests", async () => {
  const api = createMockApi()
  const runs = deferred()
  // This local index records the cancellation ownership of each synthetic read.
  const runSignals = new Map<number, AbortSignal | undefined>()
  let messageReads = 0
  const request: ApiRequest = async (route, input, path, transport) => {
    const response = structuredClone(await api.request(route, input, path))
    if (route === "GET /threads/:id/runs") {
      runSignals.set(runSignals.size, transport?.signal)
      await runs.promise
    }
    if (route !== "GET /threads/:id/messages") return response

    const snapshot = `Snapshot ${++messageReads}`
    const history = response as { messages: Message[] }
    return {
      messages: history.messages.map((message) => ({
        ...message,
        status: "streaming",
        text: snapshot,
        parts: [{ type: "text", text: snapshot }],
        updatedSeq: messageReads * 10,
      })),
    } as never
  }
  const client = { ...api, request }
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(hook.result.current.data.historyThreadId).toBe("thread-mark"))

  for (const index of [1, 2, 3]) {
    const message = hook.result.current.data.messages[0]
    if (!message) throw new Error("Missing selected message fixture")
    act(() =>
      api.emit({
        type: "message.delta",
        threadId: message.threadId,
        messageId: message.id,
        partIndex: 0,
        offset: 1000,
        delta: "!",
        updatedSeq: index * 10 + 1,
      }),
    )
    await waitFor(() => expect(hook.result.current.data.messages[0]?.text).toBe(`Snapshot ${index + 1}`))
    expect([...runSignals.values()].filter((signal) => !signal?.aborted)).toHaveLength(1)
  }

  act(() => hook.result.current.actions.selectThread("thread-onb"))
  await waitFor(() => expect(hook.result.current.data.historyThreadId).toBe("thread-onb"))
  expect([...runSignals.values()].filter((signal) => !signal?.aborted)).toHaveLength(1)
  hook.unmount()
  expect([...runSignals.values()].every((signal) => signal?.aborted)).toBe(true)
  await act(async () => runs.resolve())
})

test.each(["omitted", "cleared"] as const)("a workspace summary respects %s recovery lineage", async (projection) => {
  const api = createMockApi()
  const active = (await api.request("GET /threads/:id/runs", {}, { id: "thread-onb" })).runs[0]
  if (!active) throw new Error("Missing run fixture")
  const summary: Run = {
    ...active,
    id: "recovered-run",
    threadId: "thread-mark",
    botId: "bot-mark",
    status: "succeeded",
    finishedAt: 10,
    replyMessageId: "summary-reply",
  }
  const recovered: Run = { ...summary, replyMessageId: "selected-reply", automaticResumeFromRunId: "interrupted-run" }
  const reread = deferred()
  let holdRuns = false
  const request: ApiRequest = async (route, input, path) => {
    if (route === "GET /threads/:id/runs") {
      if (holdRuns) await reread.promise
      return { runs: [recovered] } as never
    }
    const response = await api.request(route, input, path)
    if (route === "GET /workspace/activity")
      return {
        ...response,
        runs: [projection === "cleared" ? { ...summary, automaticResumeFromRunId: null } : summary],
      } as never
    return response
  }
  const client = { ...api, request }
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() =>
    expect(hook.result.current.data.runs.find((row) => row.id === recovered.id)?.automaticResumeFromRunId).toBe(
      "interrupted-run",
    ),
  )

  holdRuns = true
  let refresh = Promise.resolve()
  act(() => {
    refresh = hook.result.current.actions.refresh()
  })
  await waitFor(() =>
    expect(hook.result.current.data.runs.find((row) => row.id === recovered.id)?.replyMessageId).toBe("summary-reply"),
  )
  const lineage = hook.result.current.data.runs.find((row) => row.id === recovered.id)?.automaticResumeFromRunId
  await act(async () => {
    reread.resolve()
    await refresh
  })

  expect(lineage).toBe(projection === "cleared" ? null : "interrupted-run")
})
