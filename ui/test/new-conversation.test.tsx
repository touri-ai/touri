import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import App from "../src/App"
import type { ApiRequest, TauriInvoke } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { setStorageScope } from "../src/storageScope"
import { useWorkspace } from "../src/useWorkspace"
import { openConversations } from "./workspaceNavigation"

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }))

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__")
  setStorageScope(null)
})

const setup = async (mode = "web", fail = false) => {
  if (mode !== "web") Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} })
  const api = createMockApi()
  let release: () => void = () => undefined
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let failNext = fail
  const request: ApiRequest = async (route, input, path) => {
    if (route === "POST /threads") {
      await pending
      if (failNext) {
        failNext = false
        throw new Error("Connection unavailable")
      }
    }
    return api.request(route, input, path)
  }
  const client = { ...api, request }
  const invoke = (async (command: string) =>
    command === "server_mode_status"
      ? { mode: mode === "server" ? "server" : "local", url: mode === "server" ? "https://touri.example" : null }
      : {}) as TauriInvoke
  render(<App kernel={{ services: { api: client, invoke } }} />)
  const input = await screen.findByRole("textbox", { name: "Mensagem para mark" })
  fireEvent.change(input, { target: { value: "Rascunho da conversa anterior" } })
  fireEvent.click(within(openConversations()).getByRole("button", { name: "Nova conversa" }))
  return { api, release }
}

it.each(["web", "local", "server"])(
  "keeps the first draft and sends only to the new conversation (%s)",
  async (mode) => {
    const { api, release } = await setup(mode)
    let input = screen.getByRole("textbox", { name: "Mensagem para mark" })
    fireEvent.change(input, { target: { value: "Revise este novo assunto" } })
    expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled()
    expect(screen.getByText("Criando conversa…")).toBeVisible()
    fireEvent.submit(screen.getByRole("form", { name: "Compor mensagem" }))
    expect(api.calls.filter((call) => call.route === "POST /threads/:id/messages")).toHaveLength(0)
    await act(async () => release())
    await waitFor(() => expect(screen.queryByText("Criando conversa…")).not.toBeInTheDocument())
    input = screen.getByRole("textbox", { name: "Mensagem para mark" })
    expect(input).toHaveValue("Revise este novo assunto")
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }))
    await waitFor(() => expect(api.calls.filter((call) => call.route === "POST /threads/:id/messages")).toHaveLength(1))
    const sent = api.calls.find((call) => call.route === "POST /threads/:id/messages")
    const created = api.getState().threads.find((thread) => thread.id !== "thread-mark" && thread.botId === "bot-mark")
    expect(created).toBeDefined()
    expect(sent?.pathValues.id).toBe(created?.id)
    expect(sent?.input).toMatchObject({ text: "Revise este novo assunto", parentId: null })
    expect(localStorage.getItem("touri.composer-draft.v1:thread-mark")).toBe(
      mode === "server" ? null : "Rascunho da conversa anterior",
    )
  },
)

it("retains the draft after creation fails and retries without sending to the old history", async () => {
  const { api, release } = await setup("web", true)
  fireEvent.change(screen.getByRole("textbox", { name: "Mensagem para mark" }), {
    target: { value: "Não perca esta tarefa" },
  })
  await act(async () => release())
  const retry = await screen.findByRole("button", { name: "Tentar criar conversa novamente" })
  expect(screen.getByRole("textbox", { name: "Mensagem para mark" })).toHaveValue("Não perca esta tarefa")
  expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled()
  fireEvent.submit(screen.getByRole("form", { name: "Compor mensagem" }))
  expect(api.calls.filter((call) => call.route === "POST /threads/:id/messages")).toHaveLength(0)
  expect(retry).toBeEnabled()
  fireEvent.click(retry)
  await waitFor(() => expect(screen.getByRole("button", { name: "Enviar" })).toBeEnabled())
  expect(screen.getByRole("textbox", { name: "Mensagem para mark" })).toHaveValue("Não perca esta tarefa")
  fireEvent.click(screen.getByRole("button", { name: "Enviar" }))
  await waitFor(() => expect(api.calls.filter((call) => call.route === "POST /threads/:id/messages")).toHaveLength(1))
  expect(api.calls.find((call) => call.route === "POST /threads/:id/messages")?.pathValues.id).not.toBe("thread-mark")
})

it("does not replace a conversation opened while creation is pending", async () => {
  const { api, release } = await setup()
  fireEvent.change(screen.getByRole("textbox", { name: "Mensagem para mark" }), {
    target: { value: "Voltar a esta tarefa depois" },
  })
  fireEvent.click(screen.getByRole("button", { name: /^onb / }))
  await screen.findByRole("textbox", { name: "Mensagem para onb" })
  await act(async () => release())
  expect(screen.getByRole("textbox", { name: "Mensagem para onb" })).toBeVisible()
  const created = api.getState().threads.find((thread) => thread.botId === "bot-mark" && thread.id !== "thread-mark")
  expect(localStorage.getItem(`touri.composer-draft.v1:${created?.id}`)).toBe("Voltar a esta tarefa depois")
})

it("guards the workspace action before React can render the pending state", async () => {
  const api = createMockApi()
  let release: () => void = () => undefined
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const request: ApiRequest = async (route, input, path) => {
    if (route === "POST /threads") await pending
    return api.request(route, input, path)
  }
  const client = { ...api, request }
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))
  await act(async () => {
    const actions = hook.result.current.actions
    const creation = actions.createThread()
    await expect(actions.sendMessage("Must never reach the old context")).rejects.toThrow("Criando conversa…")
    release()
    await creation
  })
  expect(api.calls.filter((call) => call.route === "POST /threads/:id/messages")).toHaveLength(0)
})

it("also blocks the group conversation action until the group's new id exists", async () => {
  const api = createMockApi()
  const { thread } = await api.request("POST /groups", {
    name: "Equipe",
    color: "#888888",
    avatarShape: "circle",
    memberIds: ["bot-mark", "bot-onb"],
    coordinatorBotId: null,
  })
  let release: () => void = () => undefined
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const request: ApiRequest = async (route, input, path) => {
    if (route === "POST /groups/:id/threads") await pending
    return api.request(route, input, path)
  }
  const client = { ...api, request }
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))
  act(() => hook.result.current.actions.selectThread(thread.id))
  let creation: Promise<void> | undefined
  act(() => {
    creation = hook.result.current.actions.createThread()
  })
  expect(hook.result.current.data.threadCreation?.thread.groupId).toBe(thread.groupId)
  await act(async () => {
    await expect(hook.result.current.actions.sendMessage("Tarefa da equipe")).rejects.toThrow("Criando conversa…")
    release()
    await creation
  })
  await act(async () => hook.result.current.actions.sendMessage("Tarefa da equipe"))
  const sent = api.calls.find((call) => call.route === "POST /threads/:id/messages")
  expect(sent?.pathValues.id).toBe(hook.result.current.data.selectedThreadId)
  expect(sent?.pathValues.id).not.toBe(thread.id)
})

it("keeps the project preview composer disabled until the new conversation is ready", async () => {
  const { api, release } = await setup()
  if (!screen.queryByRole("button", { name: "Preview do projeto" }))
    fireEvent.click(screen.getByRole("button", { name: "Painel do bot" }))
  await screen.findByRole("complementary", { name: /^Painel de / })
  fireEvent.click(screen.getByRole("button", { name: "Preview do projeto" }))
  const input = await screen.findByRole("textbox", { name: "Mensagem para o bot" })
  fireEvent.change(input, { target: { value: "Confira o projeto nesta conversa" } })
  expect(screen.getByText("Criando conversa…")).toBeVisible()
  expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled()
  await act(async () => release())
  await waitFor(() => expect(screen.getByRole("button", { name: "Enviar" })).toBeEnabled())
  expect(input).toHaveValue("Confira o projeto nesta conversa")
  fireEvent.click(screen.getByRole("button", { name: "Enviar" }))
  await waitFor(() => expect(api.calls.filter((call) => call.route === "POST /threads/:id/messages")).toHaveLength(1))
  expect(api.calls.find((call) => call.route === "POST /threads/:id/messages")?.pathValues.id).not.toBe("thread-mark")
})

it("recovers a failed creation's draft when returning to Nova conversa after navigation", async () => {
  const { release } = await setup("web", true)
  fireEvent.change(screen.getByRole("textbox", { name: "Mensagem para mark" }), {
    target: { value: "Guardar esta nova tarefa" },
  })
  await act(async () => release())
  await screen.findByRole("button", { name: "Tentar criar conversa novamente" })
  fireEvent.click(screen.getByRole("button", { name: /^onb / }))
  await screen.findByRole("textbox", { name: "Mensagem para onb" })
  fireEvent.click(screen.getByRole("button", { name: /^mark / }))
  fireEvent.click(within(openConversations()).getByRole("button", { name: "Nova conversa" }))
  await waitFor(() => expect(screen.getByRole("button", { name: "Enviar" })).toBeEnabled())
  expect(screen.getByRole("textbox", { name: "Mensagem para mark" })).toHaveValue("Guardar esta nova tarefa")
})

it("keeps a newly created conversation selected when an older refresh finishes later", async () => {
  const api = createMockApi()
  let delay = false
  let release: () => void = () => undefined
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const request: ApiRequest = async (route, input, path) => {
    const response = await api.request(route, input, path)
    if (delay && route === "GET /bots/:id/threads" && path?.id === "bot-onb") await pending
    return response
  }
  const client = { ...api, request }
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))
  api.calls.splice(0)
  delay = true
  let refresh: Promise<void> | undefined
  act(() => {
    refresh = hook.result.current.actions.refresh()
  })
  await waitFor(() => expect(api.calls.filter((call) => call.route === "GET /bots/:id/threads")).toHaveLength(3))
  await act(async () => hook.result.current.actions.createThread())
  const createdId = hook.result.current.data.selectedThreadId
  expect(createdId).not.toBe("thread-mark")
  await act(async () => {
    release()
    await refresh
  })
  expect(hook.result.current.data.selectedThreadId).toBe(createdId)
  await act(async () => hook.result.current.actions.sendMessage("Tarefa da conversa nova"))
  expect(api.calls.find((call) => call.route === "POST /threads/:id/messages")?.pathValues.id).toBe(createdId)
})
