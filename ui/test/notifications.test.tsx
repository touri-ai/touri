import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import App from "../src/App"
import type { TauriInvoke } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { type DeepLink, parseDeepLink } from "../src/deepLink"
import { t } from "../src/i18n"
import type { DeepLinkRequest } from "../src/nativeDeepLinks"

const nativeLinks = vi.hoisted(() => ({ handler: null as ((event: { payload: DeepLinkRequest }) => void) | null }))
const sound = vi.hoisted(() => ({ play: vi.fn(), unlock: vi.fn() }))
vi.mock("../src/notificationAudio", () => ({ createBellAudioSink: () => sound }))
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
  sound.play.mockClear()
  vi.restoreAllMocks()
  window.history.replaceState(null, "", "/")
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__")
})

const setFocusedWindow = () => vi.spyOn(document, "hasFocus").mockReturnValue(true)

it("sounds for the selected conversation while the user is viewing another page", async () => {
  setFocusedWindow()
  const api = createMockApi()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  fireEvent.click(screen.getByRole("button", { name: "Integrações", exact: true }))
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Mensagem para mark" })).not.toBeInTheDocument())

  act(() => {
    api.notify({
      kind: "question",
      title: "Escolher ambiente",
      body: "Qual ambiente usar?",
      botId: "bot-mark",
      threadId: "thread-mark",
      requestId: "question-another-page",
    })
  })

  await waitFor(() => expect(sound.play).toHaveBeenCalledOnce())
})

it("keeps the capped notification badge in the bell's accessible name", async () => {
  const api = createMockApi()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })

  act(() => {
    Array.from({ length: 10 }, (_, index) =>
      api.notify({
        kind: "question",
        title: "Question",
        body: "Which option?",
        requestId: `req-${index}`,
        botId: "bot-mark",
      }),
    )
  })

  const bell = await screen.findByRole("button", { name: "Notificações, 9+ precisam de atenção" })
  expect(bell).toHaveTextContent("9+")
  expect(t("Notifications over nine need attention", {}, "en")).toBe("Notifications, 9+ need attention")
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
  expect(parseDeepLink(window.location.href)).toEqual({ bot: "bot-onb", thread: "thread-onb" })
})

it("selects the requested thread even when it is not the bot's default thread", async () => {
  const api = createMockApi()
  const { thread } = await api.request("POST /threads", { botId: "bot-onb", title: "Web link target" })
  window.history.replaceState(null, "", `/?bot=bot-onb&thread=${thread.id}`)
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para onb" }, { timeout: 5000 })
  expect(screen.getByRole("button", { name: /^Bots/ })).toHaveAttribute("aria-current", "page")
  expect(screen.getByRole("button", { name: /Web link target/ })).toHaveClass("selected")
  expect(parseDeepLink(window.location.href)).toEqual({ bot: "bot-onb", thread: thread.id })
})

it("opens a notification's bot and thread from the touri tab", async () => {
  const api = createMockApi()
  const { thread } = await api.request("POST /threads", { botId: "bot-onb", title: "Notification target" })
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  if (!screen.queryByRole("button", { name: "Preview do projeto" }))
    fireEvent.click(screen.getByRole("button", { name: "Painel do bot" }))
  fireEvent.click(screen.getByRole("button", { name: "Preview do projeto" }))
  fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
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

it("shows the needs-you bar and focuses the selected pending card", async () => {
  const api = createMockApi()
  api.notify({
    kind: "question",
    title: "Escolher ambiente",
    body: "Qual ambiente usar?",
    botId: "bot-onb",
    threadId: "thread-onb",
    requestId: "question-focus",
  })
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })

  const bar = screen.getAllByRole("button", { name: "Abrir pendência de onb" })[0]
  expect(bar).toBeDefined()
  expect(bar).toHaveTextContent("Precisa de você")
  fireEvent.click(bar)

  await screen.findByRole("textbox", { name: "Mensagem para onb" })
  const row = await screen.findByTestId("notification-row")
  expect(row).toHaveTextContent("Qual ambiente usar?")
  expect(row).toHaveFocus()
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
  fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  fireEvent.click(screen.getByRole("button", { name: "Integrações", exact: true }))
  act(() => {
    nativeLinks.handler?.({ payload: parseDeepLink(`touri://open?bot=bot-onb&thread=${thread.id}`) as DeepLink })
  })
  await screen.findByRole("textbox", { name: "Mensagem para onb" })
  expect(screen.getByRole("button", { name: /^Bots/ })).toHaveAttribute("aria-current", "page")
  expect(screen.getByRole("button", { name: /Native link target/ })).toHaveClass("selected")
})

it("opens and focuses the exact card from a native notification click", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true })
  const api = createMockApi()
  const { thread } = await api.request("POST /threads", { botId: "bot-onb", title: "Native card target" })
  const notification = api.notify({
    kind: "question",
    title: "Escolher ambiente",
    body: "Qual ambiente usar?",
    botId: "bot-onb",
    threadId: thread.id,
    requestId: "native-question",
  })
  const invoke = (async (command: string) => {
    if (command === "server_mode_status") return { mode: "local", url: null }
    if (command === "deep_link_pending") return null
    return {}
  }) as TauriInvoke
  render(<App kernel={{ services: { api, invoke } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  await waitFor(() => expect(nativeLinks.handler).not.toBeNull())

  act(() => {
    nativeLinks.handler?.({
      payload: { bot: "bot-onb", thread: thread.id, notificationId: notification.id, requestId: 1 },
    })
  })

  await screen.findByRole("textbox", { name: "Mensagem para onb" })
  const row = await screen.findByTestId("notification-row")
  expect(row).toHaveTextContent("Qual ambiente usar?")
  expect(row).toHaveFocus()
})

it("keeps the clicked conversation when another workspace reuses the notification id", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true })
  const api = createMockApi()
  const notification = api.notify({
    kind: "question",
    title: "Outra pendência",
    body: "Qual ambiente usar?",
    botId: "bot-mark",
    threadId: "thread-mark",
    requestId: "other-workspace-question",
  })
  const invoke = (async (command: string) => {
    if (command === "server_mode_status") return { mode: "local", url: null }
    if (command === "deep_link_pending") return null
    return {}
  }) as TauriInvoke
  render(<App kernel={{ services: { api, invoke } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  await waitFor(() => expect(nativeLinks.handler).not.toBeNull())

  act(() => {
    nativeLinks.handler?.({
      payload: { bot: "bot-onb", thread: "thread-onb", notificationId: notification.id, requestId: 1 },
    })
  })

  await screen.findByRole("textbox", { name: "Mensagem para onb" })
  expect(screen.queryByRole("region", { name: "Central de notificações" })).not.toBeInTheDocument()
})

it("clears ordinary notifications while guiding uncertain work to the recovery center", async () => {
  const api = createMockApi({ scenario: "interrupted-tasks" })
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  fireEvent.click(screen.getByRole("button", { name: /Notificações,/ }))
  const bell = screen.getByRole("region", { name: "Central de notificações" })

  fireEvent.click(within(bell).getByRole("button", { name: "Limpar", exact: true }))

  expect(await within(bell).findByRole("status")).toHaveTextContent(
    "Notificações que precisam de revisão em Tarefas interrompidas: 1.",
  )
  expect(within(bell).queryByRole("alert")).not.toBeInTheDocument()
  await waitFor(() => expect(within(bell).getAllByTestId("notification-row")).toHaveLength(1))
  fireEvent.click(within(bell).getByRole("button", { name: "Tarefas interrompidas" }))
  const center = await screen.findByRole("dialog", { name: "Tarefas interrompidas", exact: true })
  expect(within(center).getByRole("checkbox")).toBeVisible()
})
