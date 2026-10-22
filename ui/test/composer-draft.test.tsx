import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (path: string) => path }))
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(vi.fn()) }))
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: vi.fn().mockResolvedValue(vi.fn()) }),
}))

import App from "../src/App"
import type { ApiRequest, TauriInvoke } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { chooseBotAction, openConversations } from "./workspaceNavigation"

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__")
})

const fixture = (blocked = false) => {
  const api = createMockApi()
  const bot = api.getState().bots[0]
  if (!bot) throw new Error("Missing bot")
  bot.machine = "vm"
  const request = api.request
  api.request = (async (route, input, path) => {
    if (blocked && route === "GET /bots/:id/provider-login/flow") return { state: "waiting", provider: bot.provider }
    return request(route, input, path)
  }) as ApiRequest
  return api
}
const invoke = (async (command: string) => {
  if (command === "server_mode_status") return { mode: "local", url: null }
  if (command === "deep_link_pending") return null
  return {}
}) as TauriInvoke
const mount = (api: ReturnType<typeof createMockApi>) => render(<App kernel={{ services: { api, invoke } }} />)
const composer = () => screen.findByRole("textbox", { name: "Mensagem para mark" })
const restoreWorkspace = (threadId: string) => {
  // A fresh entry without a deep link falls back to the saved workspace.
  window.history.replaceState(null, "", "/")
  localStorage.setItem("touri.workspace.v1", JSON.stringify({ botId: "bot-mark", threadId }))
}

test.each(["web", "desktop"])("%s restores a login-blocked draft after the app remounts", async (surface) => {
  if (surface === "desktop") Object.assign(window, { __TAURI_INTERNALS__: {} })
  const api = fixture(true)
  const view = mount(api)
  const input = await composer()
  fireEvent.change(input, { target: { value: "Oi! Em uma linha, o que você faz?" } })
  view.unmount()
  mount(api)
  expect(await composer()).toHaveValue("Oi! Em uma linha, o que você faz?")
  expect(api.calls.filter((call) => call.route === "POST /threads/:id/messages")).toHaveLength(0)
})

test("drafts stay with each conversation and successful sending clears only the sent draft", async () => {
  const api = fixture()
  let view = mount(api)
  fireEvent.change(await composer(), { target: { value: "Primeiro rascunho" } })
  chooseBotAction("Nova conversa")
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Mensagem para mark" })).toHaveValue(""))
  fireEvent.change(await composer(), { target: { value: "Segundo rascunho" } })
  const threads = api.getState().threads.filter((thread) => thread.botId === "bot-mark")
  const first = threads.find((thread) => thread.id === "thread-mark")
  if (!first) throw new Error("Missing first thread")
  // Select through the workspace API by restoring the navigation saved by the first mount.
  view.unmount()
  restoreWorkspace(first.id)
  view = mount(api)
  expect(await composer()).toHaveValue("Primeiro rascunho")
  const form = screen.getByRole("textbox", { name: "Mensagem para mark" }).closest("form")
  if (!form) throw new Error("Missing composer form")
  await act(async () => fireEvent.submit(form))
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Mensagem para mark" })).toHaveValue(""))
  view.unmount()
  view = mount(api)
  expect(await composer()).toHaveValue("")
  view.unmount()
  const second = threads.find((thread) => thread.id !== first.id)
  if (!second) throw new Error("Missing second thread")
  restoreWorkspace(second.id)
  mount(api)
  expect(await composer()).toHaveValue("Segundo rascunho")
})

test("a rejected send keeps the durable draft for retry after restarting", async () => {
  const api = fixture()
  const request = api.request
  api.request = (async (route, input, path) => {
    if (route === "POST /threads/:id/messages") throw new Error("Não foi possível enviar")
    return request(route, input, path)
  }) as ApiRequest
  const view = mount(api)
  const input = await composer()
  fireEvent.change(input, { target: { value: "Não perder" } })
  fireEvent.keyDown(input, { key: "Enter" })
  await screen.findByRole("alert")
  view.unmount()
  mount(api)
  expect(await composer()).toHaveValue("Não perder")
})

test("storage failure keeps the editable text and tells the user to copy it before closing", async () => {
  const api = fixture(true)
  mount(api)
  const input = await composer()
  const save = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage full")
  })
  try {
    fireEvent.change(input, { target: { value: "Texto recuperável" } })
    expect(input).toHaveValue("Texto recuperável")
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Não foi possível salvar o rascunho. Copie sua mensagem antes de fechar o touri.",
    )
  } finally {
    save.mockRestore()
  }
})

test("sending after navigation clears the old draft and keeps an identical new draft", async () => {
  const api = fixture()
  const request = api.request
  let finish: (() => void) | undefined
  api.request = (async (route, input, path) => {
    if (route === "POST /threads/:id/messages")
      await new Promise<void>((resolve) => {
        finish = resolve
      })
    return request(route, input, path)
  }) as ApiRequest
  const view = mount(api)
  const input = await composer()
  fireEvent.change(input, { target: { value: "Texto igual" } })
  fireEvent.keyDown(input, { key: "Enter" })
  await waitFor(() => expect(finish).toBeDefined())
  chooseBotAction("Nova conversa")
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Mensagem para mark" })).toHaveValue(""))
  fireEvent.change(await composer(), { target: { value: "Texto igual" } })
  await act(async () => finish?.())
  expect(await composer()).toHaveValue("Texto igual")
  view.unmount()
  const reopened = mount(api)
  expect(await composer()).toHaveValue("Texto igual")
  reopened.unmount()
  restoreWorkspace("thread-mark")
  mount(api)
  expect(await composer()).toHaveValue("")
})

test("an earlier send preserves edits made after reopening the same conversation", async () => {
  const api = fixture()
  const thread = api.getState().threads.find((item) => item.id === "thread-mark")
  if (!thread) throw new Error("Missing thread")
  thread.title = "Conversa original"
  const request = api.request
  let finish: (() => void) | undefined
  api.request = (async (route, input, path) => {
    if (route === "POST /threads/:id/messages")
      await new Promise<void>((resolve) => {
        finish = resolve
      })
    return request(route, input, path)
  }) as ApiRequest
  const view = mount(api)
  fireEvent.change(await composer(), { target: { value: "Mensagem enviada" } })
  fireEvent.keyDown(await composer(), { key: "Enter" })
  await waitFor(() => expect(finish).toBeDefined())
  chooseBotAction("Nova conversa")
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Mensagem para mark" })).toHaveValue(""))
  const conversations = await waitFor(() => openConversations("mark"))
  fireEvent.click(within(conversations).getByRole("button", { name: /Conversa original/ }))
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Mensagem para mark" })).toHaveValue("Mensagem enviada"),
  )
  fireEvent.change(await composer(), { target: { value: "Novo rascunho" } })
  await act(async () => finish?.())
  view.unmount()
  mount(api)
  expect(await composer()).toHaveValue("Novo rascunho")
})
