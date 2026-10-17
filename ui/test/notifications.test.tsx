import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import App from "../src/App"
import type { TauriInvoke } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { type DeepLink, parseDeepLink } from "../src/deepLink"

const nativeLinks = vi.hoisted(() => ({ handler: null as ((event: { payload: DeepLink }) => void) | null }))
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: DeepLink }) => void) => {
    if (name !== "deep-link") return Promise.resolve(() => undefined)
    nativeLinks.handler = handler
    return Promise.resolve(() => {
      nativeLinks.handler = null
    })
  }),
}))

afterEach(() => {
  vi.restoreAllMocks()
  window.history.replaceState(null, "", "/")
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__")
})

it("shows a badge for attention items and answers an approval from the bell", async () => {
  const api = createMockApi()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  act(() => {
    api.notify({
      kind: "approval",
      title: "Approve command",
      body: "rm -rf build",
      requestId: "req-1",
      botId: "bot-mark",
    })
    api.notify({ kind: "done", title: "Done", body: "all good", botId: "bot-mark" })
  })
  const bell = await screen.findByRole("button", { name: "Notificações, 1 precisa de atenção" })
  fireEvent.click(bell)
  expect(await screen.findByText("rm -rf build")).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "Aprovar" }))
  await waitFor(() =>
    expect(
      api.calls.some(
        (call) =>
          call.route === "POST /threads/:id/respond" &&
          JSON.stringify(call.input) === JSON.stringify({ requestId: "req-1", behavior: "allow" }),
      ),
    ).toBe(true),
  )
  await waitFor(() => expect(screen.getByRole("button", { name: "Notificações" })).toBeVisible())
})

it("replies to a question through the respond endpoint and dismisses a failure", async () => {
  const api = createMockApi()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  act(() => {
    api.notify({ kind: "question", title: "Question", body: "Which env?", requestId: "req-q", botId: "bot-mark" })
    api.notify({ kind: "turn-failed", title: "Turn failed", body: "cli_crash", botId: "bot-mark" })
  })
  fireEvent.click(await screen.findByRole("button", { name: "Notificações, 2 precisam de atenção" }))
  fireEvent.change(screen.getByRole("textbox", { name: "Responder" }), { target: { value: "staging" } })
  fireEvent.click(
    screen.getByRole("region", { name: "Central de notificações" }).querySelector("button[type=submit]") as HTMLElement,
  )
  await waitFor(() =>
    expect(
      api.calls.some(
        (call) => call.route === "POST /threads/:id/respond" && JSON.stringify(call.input).includes("staging"),
      ),
    ).toBe(true),
  )
  fireEvent.click(screen.getAllByRole("button", { name: "Marcar como lida" })[0] as HTMLElement)
  await waitFor(() => expect(api.calls.some((call) => call.route === "POST /notifications/:id/dismiss")).toBe(true))
})

it("selects the bot and thread named by the page query on load", async () => {
  window.history.replaceState(null, "", "/?bot=bot-onb")
  const api = createMockApi()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para onb" })
  expect(screen.getByRole("button", { name: /^Bots/ })).toHaveAttribute("aria-current", "page")
  expect(screen.getByRole("button", { name: /Welcome/ })).toHaveClass("selected")
  expect(window.location.search).toBe("")
})

it("selects the requested thread even when it is not the bot's default thread", async () => {
  const api = createMockApi()
  const { thread } = await api.request("POST /threads", { botId: "bot-onb", title: "Web link target" })
  window.history.replaceState(null, "", `/?bot=bot-onb&thread=${thread.id}`)
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para onb" }, { timeout: 5000 })
  expect(screen.getByRole("button", { name: /^Bots/ })).toHaveAttribute("aria-current", "page")
  expect(screen.getByRole("button", { name: /Web link target/ })).toHaveClass("selected")
  expect(window.location.search).toBe("")
})

it("opens a notification's bot and thread from the touri tab", async () => {
  const api = createMockApi()
  const { thread } = await api.request("POST /threads", { botId: "bot-onb", title: "Notification target" })
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  if (!screen.queryByRole("button", { name: "Preview do projeto" }))
    fireEvent.click(screen.getByRole("button", { name: "Painel do bot" }))
  fireEvent.click(screen.getByRole("button", { name: "Preview do projeto" }))
  fireEvent.click(screen.getByRole("button", { name: "Avançado", exact: true }))
  fireEvent.click(screen.getByRole("button", { name: "Integrações", exact: true }))
  act(() => {
    api.notify({
      kind: "question",
      title: "Open this thread",
      body: "Which env?",
      botId: "bot-onb",
      threadId: thread.id,
    })
  })
  fireEvent.click(await screen.findByRole("button", { name: "Notificações, 1 precisa de atenção" }))
  fireEvent.click(screen.getByRole("button", { name: "Abrir" }))
  await screen.findByRole("textbox", { name: "Mensagem para onb" })
  expect(screen.getByRole("button", { name: /^Bots/ })).toHaveAttribute("aria-current", "page")
  expect(screen.getByRole("button", { name: /Notification target/ })).toHaveClass("selected")
})

it("opens a native touri:// deep link from the touri tab", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true })
  const api = createMockApi()
  const { thread } = await api.request("POST /threads", { botId: "bot-onb", title: "Native link target" })
  const invoke = (async (command: string) => {
    if (command === "server_mode_status") return { mode: "local", url: null }
    if (command === "deep_link_pending") return null
    return {}
  }) as TauriInvoke
  render(<App kernel={{ services: { api, invoke } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  await waitFor(() => expect(nativeLinks.handler).not.toBeNull())
  fireEvent.click(screen.getByRole("button", { name: "Avançado", exact: true }))
  fireEvent.click(screen.getByRole("button", { name: "Integrações", exact: true }))
  act(() => {
    nativeLinks.handler?.({ payload: parseDeepLink(`touri://open?bot=bot-onb&thread=${thread.id}`) as DeepLink })
  })
  await screen.findByRole("textbox", { name: "Mensagem para onb" })
  expect(screen.getByRole("button", { name: /^Bots/ })).toHaveAttribute("aria-current", "page")
  expect(screen.getByRole("button", { name: /Native link target/ })).toHaveClass("selected")
})
