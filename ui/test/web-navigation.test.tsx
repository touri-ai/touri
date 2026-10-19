import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import { parseDeepLink } from "../src/deepLink"

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }))

afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__")
  Reflect.deleteProperty(document, "startViewTransition")
})

const locationIs = async (bot: string, thread: string) => {
  await waitFor(() => expect(parseDeepLink(window.location.href)).toEqual({ bot, thread }), { timeout: 2000 })
}
const selectBot = (id: string) => {
  const row = document.querySelector(`[data-bot-entry="${id}"] .bot-row-main`)
  if (!row) throw new Error("Missing bot row")
  fireEvent.click(row)
}

it("replaces the initial entry, pushes bot/thread changes and ignores repeated selections and data updates", async () => {
  const api = createMockApi()
  // An active run would intentionally navigate to its conversation on another bot click.
  await api.request("POST /runs/:id/cancel", {}, { id: "run-thread-onb" })
  const { thread } = await api.request("POST /threads", { botId: "bot-onb", title: "Another conversation" })
  thread.updatedAt = 0
  thread.createdAt = 0
  const replace = vi.spyOn(window.history, "replaceState")
  const push = vi.spyOn(window.history, "pushState")
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  await locationIs("bot-mark", "thread-mark")
  expect(replace).toHaveBeenCalledTimes(1)
  expect(push).not.toHaveBeenCalled()

  selectBot("bot-onb")
  await screen.findByRole("textbox", { name: "Mensagem para onb" })
  await waitFor(() => expect(push).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByRole("button", { name: /Another conversation/ }))
  await locationIs("bot-onb", thread.id)
  expect(push).toHaveBeenCalledTimes(2)
  selectBot("bot-onb")
  act(() => {
    api.emit({ type: "thread.updated", thread: { ...thread, title: "Renamed conversation" } })
    api.notify({ kind: "done", title: "Complete", body: "Done", botId: "bot-onb" })
  })
  await locationIs("bot-onb", thread.id)
  expect(push).toHaveBeenCalledTimes(2)
})

it("restores a thread-only URL over saved state and keeps its canonical link on reload", async () => {
  const api = createMockApi()
  const { thread } = await api.request("POST /threads", { botId: "bot-onb", title: "Shared conversation" })
  window.history.replaceState({ custom: true }, "", `/?mode=web&thread=${thread.id}#chat`)
  localStorage.setItem("touri.workspace.v1", JSON.stringify({ botId: "bot-mark", threadId: "thread-mark" }))
  const push = vi.spyOn(window.history, "pushState")
  const first = render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para onb" })
  await locationIs("bot-onb", thread.id)
  expect(screen.getByRole("button", { name: /Shared conversation/ })).toHaveClass("selected")
  expect(window.location.hash).toBe("#chat")
  expect(new URLSearchParams(window.location.search).get("mode")).toBe("web")
  expect(window.history.state).toMatchObject({ custom: true })
  expect(push).not.toHaveBeenCalled()
  first.unmount()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para onb" })
  expect(screen.getByRole("button", { name: /Shared conversation/ })).toHaveClass("selected")
  await locationIs("bot-onb", thread.id)
  expect(push).not.toHaveBeenCalled()
})

it("restores back/forward without creating entries, including when leaving a global page", async () => {
  const api = createMockApi()
  const push = vi.spyOn(window.history, "pushState")
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  await locationIs("bot-mark", "thread-mark")
  selectBot("bot-onb")
  await locationIs("bot-onb", "thread-onb")
  fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  fireEvent.click(screen.getByRole("button", { name: "Integrações", exact: true }))
  await screen.findByRole("heading", { name: "Integrações", exact: true })
  push.mockClear()
  act(() => window.history.back())
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  await locationIs("bot-mark", "thread-mark")
  act(() => window.history.forward())
  await screen.findByRole("heading", { name: "Integrações", exact: true })
  await locationIs("bot-onb", "thread-onb")
  expect(push).not.toHaveBeenCalled()
})

it("browser traversal supersedes a pending animated page navigation", async () => {
  const api = createMockApi()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  selectBot("bot-onb")
  await locationIs("bot-onb", "thread-onb")

  const media = new EventTarget() as EventTarget & { matches: boolean }
  media.matches = false
  vi.spyOn(window, "matchMedia").mockReturnValue(media as MediaQueryList)
  let snapshot: (() => void) | undefined
  let finish = (): void => undefined
  const finished = new Promise<void>((resolve) => {
    finish = resolve
  })
  const skip = vi.fn()
  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    value: (callback: () => void) => {
      snapshot = callback
      return { ready: Promise.resolve(), finished, skipTransition: skip }
    },
  })
  fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  fireEvent.click(screen.getByRole("button", { name: "Integrações", exact: true }))
  expect(snapshot).toBeDefined()
  act(() => window.history.back())
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  act(() => snapshot?.())
  expect(skip).toHaveBeenCalledOnce()
  expect(screen.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
  expect(screen.queryByRole("heading", { name: "Integrações", exact: true })).not.toBeInTheDocument()
  await act(async () => finish())
  await locationIs("bot-mark", "thread-mark")
})

it.each(["?bot=missing&thread=missing", "?bot=bot-onb&thread=missing"])(
  "normalizes unavailable destinations in place: %s",
  async (query) => {
    window.history.replaceState(null, "", `/${query}`)
    const push = vi.spyOn(window.history, "pushState")
    render(<App kernel={{ services: { api: createMockApi() } }} />)
    const bot = query.includes("bot-onb") ? "onb" : "mark"
    await screen.findByRole("textbox", { name: `Mensagem para ${bot}` })
    await locationIs(`bot-${bot}`, `thread-${bot}`)
    expect(push).not.toHaveBeenCalled()
  },
)

it("restores group conversations from their thread URL and through browser history", async () => {
  const api = createMockApi()
  const { group } = await api.request("POST /groups", {
    name: "Equipe QA",
    color: "#dc2626",
    avatarShape: "classic-none",
    memberIds: ["bot-mark", "bot-onb"],
    coordinatorBotId: null,
  })
  const { threads } = await api.request("GET /groups/:id/threads", {}, { id: group.id })
  const thread = threads[0]
  if (!thread) throw new Error("Missing group conversation")
  const first = render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  fireEvent.click(screen.getByRole("button", { name: "Equipe QA", exact: true }))
  await screen.findByRole("textbox", { name: "Mensagem para Equipe QA" })
  await locationIs(thread.botId, thread.id)
  selectBot("bot-onb")
  await locationIs("bot-onb", "thread-onb")
  act(() => window.history.back())
  await screen.findByRole("textbox", { name: "Mensagem para Equipe QA" })
  act(() => window.history.back())
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  act(() => window.history.forward())
  await screen.findByRole("textbox", { name: "Mensagem para Equipe QA" })
  await locationIs(thread.botId, thread.id)
  first.unmount()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para Equipe QA" })
  await locationIs(thread.botId, thread.id)
})

it("leaves desktop URLs and browser history untouched", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true })
  const replace = vi.spyOn(window.history, "replaceState")
  const push = vi.spyOn(window.history, "pushState")
  render(<App kernel={{ services: { api: createMockApi() } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  selectBot("bot-onb")
  await screen.findByRole("textbox", { name: "Mensagem para onb" })
  expect(window.location.search).toBe("")
  expect(push).not.toHaveBeenCalled()
  expect(replace).not.toHaveBeenCalled()
})

it("retains a requested destination when the initial workspace request fails", async () => {
  window.history.replaceState(null, "", "/?bot=bot-onb&thread=thread-onb")
  const api = createMockApi()
  const request = api.request
  let unavailable = true
  api.request = (async (route, ...args) => {
    if (unavailable && route === "GET /bots") throw new Error("Temporarily unavailable")
    return request(route, ...args)
  }) as typeof api.request
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("button", { name: "Criar meu primeiro bot" })
  expect(window.location.search).toBe("?bot=bot-onb&thread=thread-onb")
  act(() => {
    unavailable = false
    api.emit({ type: "transcript.resync" })
  })
  await screen.findByRole("textbox", { name: "Mensagem para onb" })
  await locationIs("bot-onb", "thread-onb")
})

it("replaces an unavailable selected bot in place rather than pushing its fallback", async () => {
  const api = createMockApi()
  const push = vi.spyOn(window.history, "pushState")
  const replace = vi.spyOn(window.history, "replaceState")
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  await locationIs("bot-mark", "thread-mark")
  selectBot("bot-onb")
  await locationIs("bot-onb", "thread-onb")
  push.mockClear()
  replace.mockClear()
  await act(async () => {
    await api.request("DELETE /bots/:id", { name: "onb", deleteVolumes: false }, { id: "bot-onb" })
  })
  await locationIs("bot-mark", "thread-mark")
  expect(push).not.toHaveBeenCalled()
  expect(replace).toHaveBeenCalledTimes(1)
})
