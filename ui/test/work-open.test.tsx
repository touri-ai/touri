import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"
import App from "../src/App"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { GroupSidebar } from "../src/components/Groups"
import { setStorageScope } from "../src/storageScope"
import { useWorkspace } from "../src/useWorkspace"
import { getWorkChannelCache, saveWorkChannelCache } from "../src/workChannelCache"

afterEach(() => {
  cleanup()
  setStorageScope(null)
})

const getBarrier = () => {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const getChannelFixture = async () => {
  const api = createMockApi()
  const response = await api.request("POST /groups", {
    name: "Demonstração",
    color: "#558866",
    avatarShape: "cercle",
    memberIds: ["bot-mark"],
    coordinatorBotId: null,
  })
  return { api, ...response }
}

test("channel metadata renders and history starts while unrelated startup reads remain unresolved", async () => {
  const { api, group, thread } = await getChannelFixture()
  const barrier = getBarrier()
  const request: ApiRequest = async (route, input, path) => {
    if (route === "GET /machines") await barrier.promise
    return api.request(route, input, path)
  }
  const client = { ...api, request }
  const hook = renderHook(() => useWorkspace(client))

  await waitFor(() => expect(hook.result.current.data.groups).toContainEqual(group))
  await waitFor(() => expect(hook.result.current.data.threads).toContainEqual(thread))
  act(() => hook.result.current.actions.selectThread(thread.id))

  await waitFor(() => expect(hook.result.current.data.historyThreadId).toBe(thread.id))
  expect(hook.result.current.data.loaded).toBe(false)
  await act(async () => barrier.resolve())
})

test("a saved channel shows a skeleton instead of a conversation invitation until the first history completes", async () => {
  const { api, group, thread } = await getChannelFixture()
  saveWorkChannelCache({ groups: [group], threads: [thread], selectedThreadId: thread.id }, "owner")
  const barrier = getBarrier()
  const request: ApiRequest = async (route, input, path) => {
    if (route === "GET /threads/:id/messages") await barrier.promise
    return api.request(route, input, path)
  }
  const client = { ...api, request }

  render(<App kernel={{ services: { api: client } }} />)
  fireEvent.click(await screen.findByRole("tab", { name: /^Work,/ }))

  expect(await screen.findByRole("status", { name: "Carregando conversas…" })).toBeVisible()
  expect(screen.queryByRole("region", { name: "Comece a conversa em #Demonstração" })).not.toBeInTheDocument()
  expect(screen.queryByText(/Nenhum canal/)).not.toBeInTheDocument()
  await act(async () => barrier.resolve())
  await waitFor(() => expect(screen.queryByRole("status", { name: "Carregando conversas…" })).not.toBeInTheDocument())
})

test("cached channel metadata is immediately available while the websocket cursor is pending", async () => {
  const { api, group, thread } = await getChannelFixture()
  saveWorkChannelCache({ groups: [group], threads: [thread], selectedThreadId: thread.id }, "owner")
  const barrier = getBarrier()
  const client = { ...api, cursorReady: () => barrier.promise }

  const hook = renderHook(() => useWorkspace(client))

  expect(hook.result.current.data.groups).toEqual([group])
  expect(hook.result.current.data.selectedThreadId).toBe(thread.id)
  expect(hook.result.current.data.loaded).toBe(false)
  await act(async () => barrier.resolve())
})

test("unresolved identity loads authorized history without hydrating a person's channel cache", async () => {
  const { group, thread } = await getChannelFixture()
  saveWorkChannelCache({ groups: [group], threads: [thread], selectedThreadId: thread.id }, "owner")
  const api = createMockApi()

  const hook = renderHook(() => useWorkspace(api, true, true, null))

  await waitFor(() => expect(hook.result.current.data.loaded).toBe(true))
  await waitFor(() => expect(hook.result.current.data.historyThreadId).toBe(hook.result.current.data.selectedThreadId))
  expect(hook.result.current.data.groups).toEqual([])
  expect(hook.result.current.data.selectedThreadId).not.toBe(thread.id)
  expect(hook.result.current.data.messages.length).toBeGreaterThan(0)
})

test("channel cache excludes transcript context and is scoped by server and person with an expiry", async () => {
  const { group, thread } = await getChannelFixture()
  const privateThread = { ...thread, carryoverNote: "Private context", cwdOverride: "/private/project" }
  saveWorkChannelCache({ groups: [group], threads: [privateThread], selectedThreadId: thread.id }, "owner", 1)

  expect(getWorkChannelCache("owner", 2)?.threads[0]?.carryoverNote).toBeNull()
  expect(getWorkChannelCache("owner", 2)?.threads[0]?.cwdOverride).toBeNull()
  expect(getWorkChannelCache("another-person", 2)).toBeNull()
  expect(getWorkChannelCache("owner", 8 * 24 * 60 * 60 * 1000)).toBeNull()
  setStorageScope("https://demo.invalid")
  expect(getWorkChannelCache("owner", 2)).toBeNull()
})

test("a deferred cache write retains its original server destination", async () => {
  const { group, thread } = await getChannelFixture()
  const originalScope = "https://first.demo.invalid"
  setStorageScope("https://second.demo.invalid")

  saveWorkChannelCache({ groups: [group], threads: [thread], selectedThreadId: thread.id }, "owner", 1, originalScope)

  expect(getWorkChannelCache("owner", 2)).toBeNull()
  setStorageScope(originalScope)
  expect(getWorkChannelCache("owner", 2)?.groups).toEqual([group])
})

test("malformed and oversized cache entries are ignored", () => {
  const key = "touri.work-channels.v1:owner"
  localStorage.setItem(key, "invalid JSON")

  expect(getWorkChannelCache("owner")).toBeNull()

  localStorage.setItem(key, " ".repeat(32 * 1024 + 1))

  expect(getWorkChannelCache("owner")).toBeNull()
})

test("an early channel click opens its original conversation once the index arrives", async () => {
  const { group, thread } = await getChannelFixture()
  const onSelect = vi.fn()
  const onNewThread = vi.fn()
  const props = {
    groups: [group],
    selectedThreadId: null,
    onSelect,
    onNewThread,
    onCreate: vi.fn(),
    onEdit: vi.fn(),
  }
  const view = render(<GroupSidebar {...props} threads={[]} loading />)

  fireEvent.click(screen.getByText(group.name, { exact: true }))
  view.rerender(<GroupSidebar {...props} threads={[thread]} loading={false} />)

  expect(onSelect).toHaveBeenCalledWith(thread.id)
  expect(onNewThread).not.toHaveBeenCalled()
})

test("the selected history starts before an unrelated channel index finishes", async () => {
  const { api, thread } = await getChannelFixture()
  const { group: unrelated } = await api.request("POST /groups", {
    name: "Outro canal",
    color: "#558866",
    avatarShape: "cercle",
    memberIds: ["bot-mark"],
    coordinatorBotId: null,
  })
  const barrier = getBarrier()
  const request: ApiRequest = async (route, input, path) => {
    if (route === "GET /groups/:id/threads" && path?.id === unrelated.id) await barrier.promise
    return api.request(route, input, path)
  }
  const client = Object.assign({}, api, { request })
  const hook = renderHook(() => useWorkspace(client))

  await waitFor(() => expect(hook.result.current.data.threads).toContainEqual(thread))
  act(() => hook.result.current.actions.selectThread(thread.id))

  await waitFor(() => expect(hook.result.current.data.historyThreadId).toBe(thread.id))
  expect(hook.result.current.data.loaded).toBe(false)
  await act(async () => barrier.resolve())
})

test("a failed channel read does not prevent direct conversation startup", async () => {
  const api = createMockApi()
  const request: ApiRequest = async (route, input, path) => {
    if (route === "GET /groups") throw new Error("Channel request failed")
    return api.request(route, input, path)
  }
  const client = Object.assign({}, api, { request })

  const hook = renderHook(() => useWorkspace(client))

  await waitFor(() => expect(hook.result.current.data.loaded).toBe(true))
  await waitFor(() => expect(hook.result.current.data.historyThreadId).toBe(hook.result.current.data.selectedThreadId))
  expect(hook.result.current.data.messages.length).toBeGreaterThan(0)
})
