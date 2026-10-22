import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import App from "../src/App"
import type { ApiRequest, TauriInvoke } from "../src/api/client"
import { createMockApi } from "../src/api/mock"

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }))

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__")
})

it.each([false, true])(
  "renders the bot list as soon as bots arrive while all secondary requests remain pending (empty=%s)",
  async (empty) => {
    const api = createMockApi()
    if (empty) api.getState().bots.splice(0)
    let botsReady: () => void = () => undefined
    let detailsReady: () => void = () => undefined
    const bots = new Promise<void>((resolve) => {
      botsReady = resolve
    })
    const details = new Promise<void>((resolve) => {
      detailsReady = resolve
    })
    const request: ApiRequest = async (route, input, path) => {
      await (route === "GET /bots" ? bots : details)
      return api.request(route, input, path)
    }
    render(<App kernel={{ services: { api: { ...api, request } } }} />)
    expect(screen.getByText("Preparando o espaço de trabalho…")).toBeVisible()
    await act(async () => botsReady())
    await waitFor(() =>
      expect(document.querySelectorAll("#sidebar-mode-panel-bots .bot-entry")).toHaveLength(api.getState().bots.length),
    )
    expect(screen.queryByText("Preparando o espaço de trabalho…")).not.toBeInTheDocument()
    expect(api.calls.some((call) => call.route === "GET /machines")).toBe(false)
    await act(async () => detailsReady())
    if (!empty) await screen.findByRole("textbox", { name: "Mensagem para mark" })
  },
)

it("preserves a bot chosen before the slower workspace snapshot arrives", async () => {
  const api = createMockApi()
  let detailsReady: () => void = () => undefined
  const details = new Promise<void>((resolve) => {
    detailsReady = resolve
  })
  const request: ApiRequest = async (route, input, path) => {
    if (route !== "GET /bots") await details
    return api.request(route, input, path)
  }
  render(<App kernel={{ services: { api: { ...api, request } } }} />)
  const bot = await screen.findByRole("button", { name: /^onb / })
  fireEvent.click(bot)
  await act(async () => detailsReady())
  await screen.findByRole("textbox", { name: "Mensagem para onb" })
})

it("keeps a native conversation link pending until the thread index is ready", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} })
  const api = createMockApi()
  const { thread } = await api.request("POST /threads", { botId: "bot-mark", title: "Conversa anterior" })
  thread.updatedAt = 1
  let detailsReady: () => void = () => undefined
  const details = new Promise<void>((resolve) => {
    detailsReady = resolve
  })
  const request: ApiRequest = async (route, input, path) => {
    if (route !== "GET /bots") await details
    return api.request(route, input, path)
  }
  const link = { requestId: 7, bot: "bot-mark", thread: thread.id }
  const invoke = vi.fn(async (command: string) => {
    if (command === "server_mode_status") return { mode: "local", url: null }
    if (command === "deep_link_pending") return link
    return {}
  })
  render(<App kernel={{ services: { api: { ...api, request }, invoke: invoke as TauriInvoke } }} />)
  await waitFor(() =>
    expect(document.querySelectorAll("#sidebar-mode-panel-bots .bot-entry")).toHaveLength(api.getState().bots.length),
  )
  expect(invoke).not.toHaveBeenCalledWith("deep_link_ack", { requestId: 7 })
  await act(async () => detailsReady())
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("deep_link_ack", { requestId: 7 }))
  await waitFor(() => expect(JSON.parse(localStorage.getItem("touri.workspace.v1") ?? "{}").threadId).toBe(thread.id))
})
