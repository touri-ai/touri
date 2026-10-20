import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"
import App from "../src/App"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { useWorkspace } from "../src/useWorkspace"
import { readWorkspaceState, saveWorkspaceState } from "../src/workspaceState"

type ThreadRequest = { botId: string; resolve: () => void }

type EmptyBotOptions = { failCreate?: boolean; holdCreate?: boolean; emptyBotIds?: readonly string[] }

const getApiWithEmptyBots = ({ failCreate = false, holdCreate = false, emptyBotIds = [] }: EmptyBotOptions = {}) => {
  const api = createMockApi()
  const request = api.request
  const absentBotIds = new Set(emptyBotIds)
  // Record callbacks locally so each test controls when its held requests settle.
  const held: Array<ThreadRequest> = []
  const wrapped: ApiRequest = async (route, input, pathValues) => {
    if (route === "GET /bots/:id/threads" && absentBotIds.has(pathValues?.id ?? "")) return { threads: [] } as never
    if (route === "POST /threads" && failCreate) throw new Error("offline")
    if (route === "POST /threads" && holdCreate) {
      const botId = (input as { botId: string }).botId
      await new Promise<void>((resolve) => held.push({ botId, resolve }))
    }
    return request(route, input, pathValues)
  }
  return { api: { ...api, request: wrapped }, held }
}

const renderWorkspace = async (options: { failCreate?: boolean; holdCreate?: boolean } = {}) => {
  const { api, held } = getApiWithEmptyBots({ ...options, emptyBotIds: ["bot-onb"] })
  await api.request("PATCH /bots/:id", { paused: false }, { id: "bot-panko" })
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))
  return { api, hook, held }
}

const getThreadPosts = (api: ReturnType<typeof createMockApi>) =>
  api.calls.filter((call) => call.route === "POST /threads")

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it("creates a real thread when a bot without threads is selected", async () => {
  const { hook } = await renderWorkspace()

  act(() => hook.result.current.actions.selectBot("bot-onb"))

  await waitFor(() => expect(hook.result.current.data.threadCreation).toBeNull())
  const { data } = hook.result.current
  expect(data.selectedBotId).toBe("bot-onb")
  expect(data.selectedThreadId).not.toMatch(/^draft:/)
  expect(data.threads.some((thread) => thread.id === data.selectedThreadId && thread.botId === "bot-onb")).toBe(true)
})

it("marks the draft failed instead of pending forever when creation fails", async () => {
  const { hook } = await renderWorkspace({ failCreate: true })

  act(() => hook.result.current.actions.selectBot("bot-onb"))

  await waitFor(() => expect(hook.result.current.data.threadCreation?.status).toBe("failed"))
  expect(hook.result.current.data.selectedThreadId).toBe("draft:bot:bot-onb")
})

it("creates the second draft after a creation that was in flight settles", async () => {
  const { hook, held } = await renderWorkspace({ holdCreate: true })

  act(() => hook.result.current.actions.selectBot("bot-onb"))
  await waitFor(() => expect(held).toHaveLength(1))
  act(() => hook.result.current.actions.selectBot("bot-panko"))
  await act(async () => held[0]?.resolve())
  await waitFor(() => expect(held).toHaveLength(2))
  await act(async () => held[1]?.resolve())

  await waitFor(() => expect(hook.result.current.data.threadCreation).toBeNull())
  const { data } = hook.result.current
  expect(held.map((entry) => entry.botId)).toEqual(["bot-onb", "bot-panko"])
  expect(data.selectedBotId).toBe("bot-panko")
  expect(data.threads.find((thread) => thread.id === data.selectedThreadId)?.botId).toBe("bot-panko")
})

it("keeps a paused bot on a draft without creating a thread until it resumes", async () => {
  const api = createMockApi()
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))

  act(() => hook.result.current.actions.selectBot("bot-panko"))

  expect(hook.result.current.data.threadCreation?.status).toBe("draft")
  expect(getThreadPosts(api)).toHaveLength(0)
  await act(async () => hook.result.current.actions.updateBot("bot-panko", { paused: false }))
  await waitFor(() => expect(hook.result.current.data.threadCreation).toBeNull())
  expect(getThreadPosts(api)).toHaveLength(1)
})

it("opens a focused composer for a paused bot and creates one thread after resuming", async () => {
  const user = userEvent.setup()
  const api = createMockApi()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })

  fireEvent.click(screen.getByRole("button", { name: /^Panko / }))

  const composer = await screen.findByRole("textbox", { name: "Mensagem para Panko" })
  expect(screen.queryByText("Escolha uma conversa")).toBeNull()
  await waitFor(() => expect(composer).toHaveFocus())
  expect(screen.getByText("Panko está pausado")).toBeVisible()
  expect(getThreadPosts(api)).toHaveLength(0)

  await user.click(screen.getByRole("button", { name: "Retomar bot" }))

  await waitFor(() => expect(getThreadPosts(api)).toHaveLength(1))
  await waitFor(() => expect(screen.queryByText("Panko está pausado")).toBeNull())
  expect(screen.getByRole("textbox", { name: "Mensagem para Panko" })).toHaveFocus()

  fireEvent.click(screen.getByRole("button", { name: /^mark / }))
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  fireEvent.click(screen.getByRole("button", { name: /^Panko / }))
  await screen.findByRole("textbox", { name: "Mensagem para Panko" })

  expect(getThreadPosts(api)).toHaveLength(1)
})

it("keeps a new conversation for a paused bot as a draft without creating a thread", async () => {
  const api = createMockApi()
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))
  act(() => hook.result.current.actions.selectBot("bot-panko"))

  await act(async () => hook.result.current.actions.createThread())

  expect(hook.result.current.data.threadCreation?.status).toBe("draft")
  expect(getThreadPosts(api)).toHaveLength(0)
})

it("waits for the chat to be on screen before creating the draft's thread", async () => {
  const { api } = getApiWithEmptyBots({ emptyBotIds: ["bot-mark"] })
  const hook = renderHook(({ chatOpen }) => useWorkspace(api, true, chatOpen), { initialProps: { chatOpen: false } })
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))

  expect(hook.result.current.data.threadCreation?.status).toBe("draft")
  expect(getThreadPosts(api)).toHaveLength(0)
  hook.rerender({ chatOpen: true })

  await waitFor(() => expect(hook.result.current.data.threadCreation).toBeNull())
  expect(getThreadPosts(api)).toHaveLength(1)
})

it("clears a failed resume notice after a successful retry", async () => {
  const user = userEvent.setup()
  const api = createMockApi()
  const resume = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined)
  const request: ApiRequest = async (route, input, pathValues) => {
    if (route === "PATCH /bots/:id" && pathValues?.id === "bot-panko") await resume()

    return api.request(route, input, pathValues)
  }
  render(<App kernel={{ services: { api: { ...api, request } } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  await user.click(screen.getByRole("button", { name: /^Panko / }))

  await user.click(screen.getByRole("button", { name: "Retomar bot" }))

  expect(await screen.findByRole("alert")).toBeVisible()
  expect(screen.getByText("Panko está pausado")).toBeVisible()

  await user.click(screen.getByRole("button", { name: "Retomar bot" }))

  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull())
  await waitFor(() => expect(screen.queryByText("Panko está pausado")).toBeNull())
  expect(screen.getByRole("textbox", { name: "Mensagem para Panko" })).toHaveFocus()
})

it("keeps sending disabled and preserves typing while a second draft waits for creation", async () => {
  const user = userEvent.setup()
  const { api, held } = getApiWithEmptyBots({ holdCreate: true, emptyBotIds: ["bot-onb"] })
  await api.request("PATCH /bots/:id", { paused: false }, { id: "bot-panko" })
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  await user.click(screen.getByRole("button", { name: /^onb / }))
  await waitFor(() => expect(held).toHaveLength(1))

  await user.click(screen.getByRole("button", { name: /^Panko / }))
  const composer = await screen.findByRole("textbox", { name: "Mensagem para Panko" })
  await user.type(composer, "Mensagem fictícia preservada")

  expect(screen.getByRole("button", { name: "Enviar", exact: true })).toBeDisabled()
  expect(screen.getByText("Criando conversa…")).toBeVisible()

  await act(async () => held[0]?.resolve())
  await waitFor(() => expect(held).toHaveLength(2))
  await act(async () => held[1]?.resolve())

  await waitFor(() => expect(screen.queryByText("Criando conversa…")).toBeNull())
  expect(composer).toHaveValue("Mensagem fictícia preservada")
  expect(screen.getByRole("button", { name: "Enviar", exact: true })).toBeEnabled()
})

it("reuses existing history when a bot is selected before the initial index finishes", async () => {
  const api = createMockApi()
  const history = Promise.withResolvers<void>()
  const request: ApiRequest = async (route, input, pathValues) => {
    if (route === "GET /bots/:id/threads") await history.promise

    return api.request(route, input, pathValues)
  }
  const client = { ...api, request }
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(hook.result.current.data.botsLoaded).toBe(true))

  act(() => hook.result.current.actions.selectBot("bot-onb"))

  expect(getThreadPosts(api)).toHaveLength(0)
  expect(hook.result.current.data.threadCreation).toBeNull()

  await act(async () => history.resolve())

  await waitFor(() => expect(hook.result.current.data.loaded).toBe(true))
  expect(hook.result.current.data.selectedThreadId).toBe("thread-onb")
  expect(getThreadPosts(api)).toHaveLength(0)
})

it("remembers a paused empty bot across remounts without saving a draft as real history", async () => {
  const api = createMockApi()
  const first = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(first.result.current.data.loaded).toBe(true))

  act(() => first.result.current.actions.selectBot("bot-panko"))

  await waitFor(() => expect(readWorkspaceState().botId).toBe("bot-panko"))
  expect(readWorkspaceState().threadId).toBeUndefined()
  first.unmount()

  const second = renderHook(() => useWorkspace(api))

  await waitFor(() => expect(second.result.current.data.loaded).toBe(true))
  expect(second.result.current.data.selectedBotId).toBe("bot-panko")
  expect(second.result.current.data.threadCreation?.status).toBe("draft")
  expect(getThreadPosts(api)).toHaveLength(0)
})

it("keeps the preview composer disabled while the paused conversation is only a draft", async () => {
  const user = userEvent.setup()
  const api = createMockApi()
  saveWorkspaceState({ botId: "bot-panko", route: { section: "bots", screen: "preview" } })
  render(<App kernel={{ services: { api } }} />)
  const composer = await screen.findByRole("textbox", { name: "Mensagem para o bot" })

  await user.type(composer, "Mensagem fictícia de prévia")

  expect(screen.getByRole("button", { name: "Enviar", exact: true })).toBeDisabled()
  expect(getThreadPosts(api)).toHaveLength(0)
})
