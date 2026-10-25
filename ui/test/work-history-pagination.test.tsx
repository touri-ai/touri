import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import type { ApiRoutes, Message } from "@touri/contracts"
import { afterEach, expect, test } from "vitest"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { useWorkspace } from "../src/useWorkspace"

afterEach(cleanup)

test("channel history opens the latest page, prepends older messages and restores a cached page without a read", async () => {
  const api = createMockApi()
  const first = await getChannel(api, "Plano fictício")
  const second = await getChannel(api, "Avisos fictícios")
  const requests: Array<{ id: string; before?: string }> = []
  const request: ApiRequest = async (route, input, path, transport) => {
    if (route === "GET /threads/:id/messages") requests.push({ id: path?.id ?? "", ...(input as { before?: string }) })
    return api.request(route, input, path, transport)
  }
  const client = { ...api, request }
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(hook.result.current.data.loaded).toBe(true))

  act(() => hook.result.current.actions.selectThread(first))
  await waitFor(() => expect(hook.result.current.data.historyThreadId).toBe(first))

  expect(hook.result.current.data.messages).toHaveLength(40)
  expect(hook.result.current.data.messages[0]?.id).toBe(`${first}-4960`)
  expect(hook.result.current.data.messages.at(-1)?.id).toBe(`${first}-4999`)
  await act(() => hook.result.current.actions.loadOlderMessages())
  expect(hook.result.current.data.messages).toHaveLength(80)
  expect(hook.result.current.data.messages[0]?.id).toBe(`${first}-4920`)
  expect(requests.filter((request) => request.id === first).at(-1)?.before).toBe(`${first}-4960`)

  act(() => hook.result.current.actions.selectThread(second))
  await waitFor(() => expect(hook.result.current.data.historyThreadId).toBe(second))
  const readCount = requests.length
  act(() => hook.result.current.actions.selectThread(first))

  expect(hook.result.current.data.historyThreadId).toBe(first)
  expect(hook.result.current.data.messages).toHaveLength(40)
  expect(hook.result.current.data.messages.at(-1)?.id).toBe(`${first}-4999`)
  expect(requests).toHaveLength(readCount)
})

test("an older search hydrates one contiguous page and returning to the channel restores its latest page", async () => {
  const api = createMockApi()
  const threadId = await getChannel(api, "Pesquisa fictícia")
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(hook.result.current.data.loaded).toBe(true))
  act(() => hook.result.current.actions.selectThread(threadId))
  await waitFor(() => expect(hook.result.current.data.historyThreadId).toBe(threadId))

  act(() => hook.result.current.actions.selectThread(threadId, { messageId: `${threadId}-100` }))
  await waitFor(() => expect(hook.result.current.data.messages.at(-1)?.id).toBe(`${threadId}-100`))

  expect(hook.result.current.data.messages).toHaveLength(40)
  expect(hook.result.current.data.messages[0]?.id).toBe(`${threadId}-61`)
  act(() => hook.result.current.actions.selectThread(threadId))
  expect(hook.result.current.data.messages.at(-1)?.id).toBe(`${threadId}-4999`)
  expect(hook.result.current.data.messages).toHaveLength(40)
})

test("hover prefetch is reused and a background message invalidates the cached page", async () => {
  const api = createMockApi()
  const threadId = await getChannel(api, "Canal fictício")
  const requests: string[] = []
  const request: ApiRequest = async (route, input, path, transport) => {
    if (route === "GET /threads/:id/messages") requests.push(path?.id ?? "")
    return api.request(route, input, path, transport)
  }
  const client = { ...api, request }
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(hook.result.current.data.loaded).toBe(true))
  const initialThread = hook.result.current.data.selectedThreadId
  if (!initialThread) throw new Error("Missing synthetic thread")

  act(() => hook.result.current.actions.prefetchThread(threadId))
  await waitFor(() => expect(requests.filter((id) => id === threadId)).toHaveLength(1))
  act(() => hook.result.current.actions.selectThread(threadId))
  await waitFor(() => expect(hook.result.current.data.historyThreadId).toBe(threadId))
  expect(requests.filter((id) => id === threadId)).toHaveLength(1)
  act(() => hook.result.current.actions.selectThread(initialThread))
  const incoming = getMessage(threadId, 5000)
  api.getState().messages.push(incoming)
  act(() => api.emit({ type: "message.created", message: incoming }))
  act(() => hook.result.current.actions.selectThread(threadId))
  await waitFor(() => expect(hook.result.current.data.messages.at(-1)?.id).toBe(incoming.id))

  expect(requests.filter((id) => id === threadId)).toHaveLength(2)
})

test("a live message arriving during a selected hover prefetch is recovered by a fresh page", async () => {
  const api = createMockApi()
  const threadId = await getChannel(api, "Fluxo fictício")
  const held = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const reads: string[] = []
  const request: ApiRequest = async (route, input, path, transport) => {
    const snapshot = await api.request(route, input, path, transport)
    if (route !== "GET /threads/:id/messages" || path?.id !== threadId) return snapshot
    reads.push(threadId)
    if (reads.length === 1) {
      started.resolve()
      await held.promise
    }
    return snapshot
  }
  const client = { ...api, request }
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(hook.result.current.data.loaded).toBe(true))
  act(() => hook.result.current.actions.prefetchThread(threadId))
  await started.promise
  act(() => hook.result.current.actions.selectThread(threadId))
  const incoming = getMessage(threadId, 5000)
  api.getState().messages.push(incoming)

  act(() => api.emit({ type: "message.created", message: incoming }))
  await act(async () => held.resolve())
  await waitFor(() => expect(hook.result.current.data.historyThreadId).toBe(threadId))

  expect(hook.result.current.data.messages.at(-1)?.id).toBe(incoming.id)
  expect(reads).toHaveLength(2)
})

test("switching to an older DM branch keeps a bounded page and caches that selected branch", async () => {
  const api = createMockApi()
  const { thread } = await api.request("POST /threads", { botId: "bot-mark", title: "Ramo fictício" })
  api.getState().messages.push(...Array.from({ length: 5000 }, (_, index) => getMessage(thread.id, index)))
  await api.request("PATCH /threads/:id", { activeLeafId: `${thread.id}-4999` }, { id: thread.id })
  const other = await getChannel(api, "Outro canal fictício")
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(hook.result.current.data.loaded).toBe(true))
  act(() => hook.result.current.actions.selectThread(thread.id))
  await waitFor(() => expect(hook.result.current.data.historyThreadId).toBe(thread.id))

  await act(() => hook.result.current.actions.switchBranch(thread.id, `${thread.id}-100`))
  await waitFor(() => expect(hook.result.current.data.messages.at(-1)?.id).toBe(`${thread.id}-100`))
  expect(hook.result.current.data.messages).toHaveLength(40)
  act(() => hook.result.current.actions.selectThread(other))
  await waitFor(() => expect(hook.result.current.data.historyThreadId).toBe(other))
  const reads = api.calls.filter((call) => call.route === "GET /threads/:id/messages").length
  act(() => hook.result.current.actions.selectThread(thread.id))

  expect(hook.result.current.data.messages.at(-1)?.id).toBe(`${thread.id}-100`)
  expect(hook.result.current.data.historyThreadId).toBe(thread.id)
  expect(api.calls.filter((call) => call.route === "GET /threads/:id/messages")).toHaveLength(reads)
})

test("updates to an unloaded old reply stay in activity without refetching or polluting the latest page", async () => {
  const api = createMockApi()
  const threadId = await getChannel(api, "Atividade fictícia")
  const old = getStoredMessage(api, threadId, 0)
  Object.assign(old, {
    role: "assistant",
    status: "streaming",
    runId: "old-stream",
    text: "Antiga",
    parts: [{ type: "text", text: "Antiga" }],
    updatedSeq: 1,
  })
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(hook.result.current.data.loaded).toBe(true))
  act(() => hook.result.current.actions.selectThread(threadId))
  await waitFor(() => expect(hook.result.current.data.historyThreadId).toBe(threadId))
  const reads = api.calls.filter((call) => call.route === "GET /threads/:id/messages").length

  act(() => api.emit({ type: "message.updated", message: { ...old, text: "Antiga atualizada", updatedSeq: 2 } }))
  Array.from({ length: 20 }, (_, index) => index).forEach((index) => {
    act(() =>
      api.emit({
        type: "message.delta",
        threadId,
        messageId: old.id,
        partIndex: 0,
        offset: 16 + index,
        delta: ".",
        updatedSeq: index + 3,
      }),
    )
  })

  expect(hook.result.current.data.messages).toHaveLength(40)
  expect(hook.result.current.data.messages[0]?.id).toBe(`${threadId}-4960`)
  expect(hook.result.current.data.messages.at(-1)?.id).toBe(`${threadId}-4999`)
  expect(api.calls.filter((call) => call.route === "GET /threads/:id/messages")).toHaveLength(reads)
})

test("a gap in an older loaded reply reads one message and preserves the older-page cursor", async () => {
  const api = createMockApi()
  const threadId = await getChannel(api, "Reparo fictício")
  const old = getStoredMessage(api, threadId, 4930)
  Object.assign(old, {
    role: "assistant",
    status: "streaming",
    text: "Oi",
    parts: [{ type: "text", text: "Oi" }],
    updatedSeq: 1,
  })
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(hook.result.current.data.loaded).toBe(true))
  act(() => hook.result.current.actions.selectThread(threadId))
  await waitFor(() => expect(hook.result.current.data.historyThreadId).toBe(threadId))
  await act(() => hook.result.current.actions.loadOlderMessages())
  const before = hook.result.current.data.historyBefore
  Object.assign(old, { text: "Oi mundo", parts: [{ type: "text", text: "Oi mundo" }], updatedSeq: 2 })

  act(() =>
    api.emit({
      type: "message.delta",
      threadId,
      messageId: old.id,
      partIndex: 0,
      offset: 8,
      delta: "!",
      updatedSeq: 3,
    }),
  )
  await waitFor(() =>
    expect(hook.result.current.data.messages.find((message) => message.id === old.id)?.text).toBe("Oi mundo!"),
  )

  const last = api.calls.filter((call) => call.route === "GET /threads/:id/messages").at(-1)
  expect(last?.input).toMatchObject({ limit: 1, around: old.id })
  expect(hook.result.current.data.messages).toHaveLength(80)
  expect(hook.result.current.data.historyBefore).toBe(before)
})

test("an unknown old stream is looked up once and subsequent deltas stay offscreen", async () => {
  const api = createMockApi()
  const threadId = await getChannel(api, "Replay fictício")
  const old = getStoredMessage(api, threadId, 0)
  Object.assign(old, {
    role: "assistant",
    status: "streaming",
    runId: "unknown-old-stream",
    text: "Oi!",
    parts: [{ type: "text", text: "Oi!" }],
    updatedSeq: 2,
  })
  const request: ApiRequest = async (route, input, path, transport) => {
    if (route === "GET /workspace/activity")
      return { ...(await api.request("GET /workspace/activity", {})), messages: [] } as never
    return api.request(route, input, path, transport)
  }
  const client = { ...api, request }
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(hook.result.current.data.loaded).toBe(true))
  act(() => hook.result.current.actions.selectThread(threadId))
  await waitFor(() => expect(hook.result.current.data.historyThreadId).toBe(threadId))
  const reads = api.calls.filter((call) => call.route === "GET /threads/:id/messages").length

  act(() =>
    api.emit({
      type: "message.delta",
      threadId,
      messageId: old.id,
      partIndex: 0,
      offset: 2,
      delta: "!",
      updatedSeq: 2,
    }),
  )
  await waitFor(() =>
    expect(hook.result.current.data.activityMessages.some((message) => message.id === old.id)).toBe(true),
  )
  Array.from({ length: 20 }, (_, index) => index).forEach((index) => {
    act(() =>
      api.emit({
        type: "message.delta",
        threadId,
        messageId: old.id,
        partIndex: 0,
        offset: 3 + index,
        delta: ".",
        updatedSeq: index + 3,
      }),
    )
  })

  expect(hook.result.current.data.messages).toHaveLength(40)
  expect(api.calls.filter((call) => call.route === "GET /threads/:id/messages")).toHaveLength(reads + 1)
})

test("simultaneous repairs serialize their reads and carry each message's overlapping delta", async () => {
  const api = createMockApi()
  const threadId = await getChannel(api, "Reparos paralelos fictícios")
  const replies = [4930, 4940].map((index) => getStoredMessage(api, threadId, index))
  replies.forEach((reply) => {
    Object.assign(reply, {
      role: "assistant",
      status: "streaming",
      text: "Oi",
      parts: [{ type: "text", text: "Oi" }],
      updatedSeq: 1,
    })
  })
  const held = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const request: ApiRequest = async (route, input, path, transport) => {
    const response = await api.request(route, input, path, transport)
    const page = input as ApiRoutes["GET /threads/:id/messages"]["req"]
    if (route === "GET /threads/:id/messages" && page.limit === 1 && page.around === replies[0]?.id) {
      started.resolve()
      await held.promise
    }
    return response
  }
  const client = { ...api, request }
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(hook.result.current.data.loaded).toBe(true))
  act(() => hook.result.current.actions.selectThread(threadId))
  await waitFor(() => expect(hook.result.current.data.historyThreadId).toBe(threadId))
  await act(() => hook.result.current.actions.loadOlderMessages())
  replies.forEach((reply) => {
    Object.assign(reply, { text: "Oi mundo", parts: [{ type: "text", text: "Oi mundo" }], updatedSeq: 2 })
  })

  act(() =>
    replies.forEach((reply) => {
      api.emit({
        type: "message.delta",
        threadId,
        messageId: reply.id,
        partIndex: 0,
        offset: 8,
        delta: "!",
        updatedSeq: 3,
      })
    }),
  )
  await started.promise
  await act(async () => held.resolve())
  await waitFor(() =>
    expect(
      replies.every(
        (reply) => hook.result.current.data.messages.find((message) => message.id === reply.id)?.text === "Oi mundo!",
      ),
    ).toBe(true),
  )

  expect(hook.result.current.data.messages).toHaveLength(80)
})

const getStoredMessage = (api: ReturnType<typeof createMockApi>, threadId: string, index: number): Message => {
  const message = api.getState().messages.find((message) => message.id === `${threadId}-${index}`)
  if (!message) throw new Error("Missing synthetic message")

  return message
}

const getChannel = async (api: ReturnType<typeof createMockApi>, name: string): Promise<string> => {
  const { thread } = await api.request("POST /groups", {
    name,
    color: "#558866",
    avatarShape: "cercle",
    memberIds: ["bot-mark"],
    coordinatorBotId: null,
  })
  // Fresh mock state is the test server's writable fixture, never shared with another test.
  api.getState().messages.push(...Array.from({ length: 5000 }, (_, index) => getMessage(thread.id, index)))

  return thread.id
}

const getMessage = (threadId: string, index: number): Message => ({
  id: `${threadId}-${index}`,
  threadId,
  parentId: index ? `${threadId}-${index - 1}` : null,
  role: "user",
  kind: "text",
  status: "complete",
  runId: null,
  text: `Registro fictício ${index}`,
  parts: [],
  sender: null,
  source: "local",
  createdAt: index + 1,
  updatedAt: index + 1,
})

test("an unavailable old search is read once and does not restart history loading", async () => {
  const api = createMockApi()
  const threadId = await getChannel(api, "Pesquisa fictícia")
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(hook.result.current.data.loaded).toBe(true))
  act(() => hook.result.current.actions.selectThread(threadId, { messageId: "removed-message" }))
  await waitFor(() => expect(hook.result.current.data.historyFocusId).toBe("removed-message"))

  const thread = api.getState().threads.find((thread) => thread.id === threadId)
  if (!thread) throw new Error("Missing synthetic thread")
  act(() => api.emit({ type: "thread.updated", thread: { ...thread, unread: 1 } }))
  await waitFor(() => expect(hook.result.current.data.historyThreadId).toBe(threadId))
  expect(
    api.calls.filter((call) => call.route === "GET /threads/:id/messages" && call.pathValues?.id === threadId),
  ).toHaveLength(1)
  expect(hook.result.current.data.messages).toEqual([])
})

test("a hover page opens before held run metadata and never downloads its messages twice", async () => {
  const api = createMockApi()
  const threadId = await getChannel(api, "Canal fictício")
  const held = Promise.withResolvers<void>()
  const reads: string[] = []
  const request: ApiRequest = async (route, input, path, transport) => {
    const response = await api.request(route, input, path, transport)
    if (path?.id === threadId) {
      reads.push(route)
      if (route === "GET /threads/:id/runs") await held.promise
    }
    return response
  }
  const client = { ...api, request }
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(hook.result.current.data.loaded).toBe(true))
  act(() => hook.result.current.actions.prefetchThread(threadId))
  await waitFor(() => expect(reads).toContain("GET /threads/:id/messages"))
  act(() => hook.result.current.actions.selectThread(threadId))
  await waitFor(() => expect(hook.result.current.data.historyThreadId).toBe(threadId))

  expect(hook.result.current.data.messages).toHaveLength(40)
  expect(reads.filter((route) => route === "GET /threads/:id/messages")).toHaveLength(1)
  expect(reads.filter((route) => route === "GET /threads/:id/runs")).toHaveLength(1)
  await act(async () => held.resolve())
})

test("a new DM reply on an old fork opens its ancestors and retains sibling controls in cache", async () => {
  const api = createMockApi()
  const { thread } = await api.request("POST /threads", { botId: "bot-mark", title: "Ramo fictício" })
  const history = Array.from({ length: 5000 }, (_, index) => getMessage(thread.id, index))
  const fork = { ...getMessage(thread.id, 5000), id: "new-fork", parentId: `${thread.id}-100` }
  api.getState().messages.push(...history, fork)
  await api.request("PATCH /threads/:id", { activeLeafId: fork.id }, { id: thread.id })
  const other = await getChannel(api, "Outro canal fictício")
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(hook.result.current.data.loaded).toBe(true))
  act(() => hook.result.current.actions.selectThread(thread.id))
  await waitFor(() => expect(hook.result.current.data.historyThreadId).toBe(thread.id))

  expect(hook.result.current.data.messages).toHaveLength(40)
  expect(hook.result.current.data.messages[0]?.id).toBe(`${thread.id}-62`)
  expect(hook.result.current.data.messages.at(-1)?.id).toBe(fork.id)
  expect(hook.result.current.data.historyContext?.siblings.map((message) => message.id)).toContain(`${thread.id}-101`)
  act(() => hook.result.current.actions.selectThread(other))
  await waitFor(() => expect(hook.result.current.data.historyThreadId).toBe(other))
  act(() => hook.result.current.actions.selectThread(thread.id))
  expect(hook.result.current.data.messages).toHaveLength(40)
  expect(hook.result.current.data.historyContext?.siblings.map((message) => message.id)).toContain(`${thread.id}-101`)
})

test("an unknown old delta during selected hover loading still opens the full latest page", async () => {
  const api = createMockApi()
  const threadId = await getChannel(api, "Canal fictício")
  const old = getStoredMessage(api, threadId, 0)
  Object.assign(old, {
    role: "assistant",
    status: "streaming",
    text: "Oi",
    parts: [{ type: "text", text: "Oi" }],
    updatedSeq: 1,
  })
  const held = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  let reads = 0
  const request: ApiRequest = async (route, input, path, transport) => {
    const snapshot = await api.request(route, input, path, transport)
    if (route === "GET /threads/:id/messages" && path?.id === threadId && ++reads === 1) {
      started.resolve()
      await held.promise
    }
    return snapshot
  }
  const client = { ...api, request }
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(hook.result.current.data.loaded).toBe(true))
  act(() => hook.result.current.actions.prefetchThread(threadId))
  await started.promise
  act(() => hook.result.current.actions.selectThread(threadId))
  act(() =>
    api.emit({
      type: "message.delta",
      threadId,
      messageId: old.id,
      partIndex: 0,
      offset: 2,
      delta: "!",
      updatedSeq: 2,
    }),
  )
  await act(async () => held.resolve())
  await waitFor(() => expect(hook.result.current.data.historyThreadId).toBe(threadId))
  await waitFor(() => expect(hook.result.current.data.messages).toHaveLength(40))

  expect(hook.result.current.data.messages.at(-1)?.id).toBe(`${threadId}-4999`)
  expect(hook.result.current.data.messages.some((message) => message.id === old.id)).toBe(false)
})

test("a search inside the loaded page still exposes a return to the latest page", async () => {
  const api = createMockApi()
  const threadId = await getChannel(api, "Pesquisa fictícia")
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(hook.result.current.data.loaded).toBe(true))
  act(() => hook.result.current.actions.selectThread(threadId))
  await waitFor(() => expect(hook.result.current.data.historyThreadId).toBe(threadId))

  act(() => hook.result.current.actions.selectThread(threadId, { messageId: `${threadId}-4990` }))

  expect(hook.result.current.data.historyFocusId).toBe(`${threadId}-4990`)
  act(() => hook.result.current.actions.selectThread(threadId))
  expect(hook.result.current.data.historyFocusId).toBeNull()
  expect(hook.result.current.data.messages.at(-1)?.id).toBe(`${threadId}-4999`)
})

test("sending from an older search restores latest history before adding the new turn", async () => {
  const api = createMockApi()
  const threadId = await getChannel(api, "Pesquisa fictícia")
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(hook.result.current.data.loaded).toBe(true))
  act(() => hook.result.current.actions.selectThread(threadId))
  await waitFor(() => expect(hook.result.current.data.historyThreadId).toBe(threadId))
  act(() => hook.result.current.actions.selectThread(threadId, { messageId: `${threadId}-100` }))
  await waitFor(() => expect(hook.result.current.data.messages.at(-1)?.id).toBe(`${threadId}-100`))

  await act(() => hook.result.current.actions.sendMessage("Nova mensagem fictícia"))

  expect(hook.result.current.data.messageFocus).toBeNull()
  expect(hook.result.current.data.historyFocusId).toBeNull()
  expect(hook.result.current.data.messages.some((message) => message.id === `${threadId}-4999`)).toBe(true)
  expect(hook.result.current.data.messages.some((message) => message.text === "Nova mensagem fictícia")).toBe(true)
})
