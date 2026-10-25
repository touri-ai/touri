import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import type { Message } from "@touri/contracts"
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
