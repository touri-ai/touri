import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import type { Message } from "@touri/contracts"
import { afterEach, expect, test } from "vitest"
import App from "../src/App"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { pendingApprovalTargets } from "../src/approvalNavigation"
import { latestPreview } from "../src/botPreview"
import { useWorkspace } from "../src/useWorkspace"

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

test("selection loads a thread while preserving visited histories and background live events", async () => {
  const api = createMockApi()
  offscreenMessage(api)
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() =>
    expect(hook.result.current.data.messages.some((message) => message.threadId === "thread-mark")).toBe(true),
  )
  expect(hook.result.current.data.messages.some((message) => message.threadId === "thread-onb")).toBe(false)
  const original = hook.result.current.data.messages[0]
  if (!original) throw new Error("Missing message fixture")
  act(() => {
    api.emit({
      type: "message.created",
      message: { ...original, id: "live-reply", threadId: "thread-onb", text: "Live reply", updatedSeq: 100 },
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
  expect(hook.result.current.data.messages).toContainEqual(original)
  expect(hook.result.current.data.messages.find((message) => message.id === "live-reply")?.text).toBe("Live reply")
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
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "Needle" } })
  expect(await screen.findByText("Needle archive")).toBeVisible()
  expect(api.calls.some((call) => call.route === "GET /search")).toBe(true)
  expect(
    api.calls
      .filter((call) => call.route === "GET /threads/:id/messages")
      .every((call) => call.pathValues.id === "thread-mark"),
  ).toBe(true)
})
