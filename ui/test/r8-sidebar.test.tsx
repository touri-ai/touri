import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { Message, NotificationRecord } from "@touri/contracts"
import { describe, expect, it } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import { pendingNotifications, relativeThreadDate } from "../src/sidebarAttention"
import { openRoutines } from "./workspaceNavigation"

const localDate = (day: number, hour = 12): number => new Date(2026, 9, day, hour).getTime()

const getBotEntry = (botId: string): HTMLElement => {
  const entry = document.querySelector<HTMLElement>(`[data-bot-entry="${botId}"]`)
  if (!entry) throw new Error(`Missing bot sidebar entry: ${botId}`)

  return entry
}

const notice = (patch: Partial<NotificationRecord>): NotificationRecord => ({
  id: 1,
  kind: "turn-failed",
  level: "error",
  title: "Resposta interrompida",
  body: "O provedor encerrou inesperadamente.",
  botId: "bot-mark",
  botName: "mark",
  botColor: "var(--accent-brand)",
  avatarShape: "classic-none",
  avatarSeed: null,
  threadId: "thread-mark",
  requestId: null,
  createdAt: 100,
  resolvedAt: null,
  resolution: null,
  ...patch,
})

describe("r8 sidebar: attention history", () => {
  it("sorts by recency and retires superseded failures without clearing real requests", () => {
    const historical = notice({ id: 1, createdAt: 100 })
    const completed = notice({ id: 2, createdAt: 200, kind: "done" })
    const approval = notice({ id: 3, createdAt: 50, kind: "approval", requestId: "approval-1" })
    const failureElsewhere = notice({ id: 4, createdAt: 90, threadId: "another-thread" })
    const question = notice({ id: 5, createdAt: 300, kind: "question" })
    expect(
      pendingNotifications([historical, question, failureElsewhere, approval, completed]).map((n) => n.id),
    ).toEqual([5, 4, 3])
    expect(historical.resolvedAt).toBeNull()
  })

  it("uses a later successful reply only for the failed conversation and leaves incidents pending", () => {
    const api = createMockApi()
    const base = api.getState().messages[0]
    if (!base) throw new Error("Fixture indisponível")
    const reply: Message = { ...base, threadId: "thread-mark", role: "assistant", status: "complete", updatedAt: 200 }
    const failure = notice({})
    const incident = notice({ id: 2, kind: "incident" })
    const routineFailure = notice({ id: 3, kind: "routine-failed" })
    expect(pendingNotifications([failure, incident, routineFailure], [reply]).map((n) => n.id)).toEqual([3, 2])
    expect(pendingNotifications([failure], [{ ...reply, threadId: "another-thread" }])).toEqual([failure])
    expect(pendingNotifications([notice({ resolvedAt: 300, resolution: "dismissed" })])).toEqual([])
  })

  it("uses local calendar days for relative dates, including midnight and year changes", () => {
    expect(relativeThreadDate(localDate(13, 0), localDate(13, 23))).toBe("hoje")
    expect(relativeThreadDate(localDate(12, 23), localDate(13, 0))).toBe("ontem")
    expect(relativeThreadDate(localDate(11), localDate(13))).toBe("11 de out.")
    expect(relativeThreadDate(new Date(2025, 9, 13).getTime(), localDate(13))).toContain("2025")
  })
})

it("shows one unread count for an expanded conversation and its aggregate when collapsed", async () => {
  const api = createMockApi()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })

  const mark = getBotEntry("bot-mark")
  expect(mark.querySelector(".bot-row .sidebar-unread")).toBeNull()
  expect(mark.querySelectorAll(".thread-row .sidebar-unread")).toHaveLength(1)
  expect(mark.querySelector(".thread-row .sidebar-unread")).toHaveTextContent("2")
  expect(within(mark).getByRole("img", { name: "2 mensagens não lidas" })).toBeVisible()

  const onbButton = getBotEntry("bot-onb").querySelector(".bot-row-main")
  if (!(onbButton instanceof HTMLButtonElement)) throw new Error("Missing bot row button")
  fireEvent.click(onbButton)

  await screen.findByRole("textbox", { name: "Mensagem para onb" })
  expect(mark.querySelector(".bot-row .sidebar-unread")).toHaveTextContent("2")
  expect(mark.querySelector(".bot-thread-tree")).toBeNull()
})

it("keeps each unread count on its conversation when several are visible", async () => {
  const api = createMockApi()
  await api.request("POST /threads", { botId: "bot-mark", title: "Campaign follow-up" })
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })

  const mark = getBotEntry("bot-mark")
  expect(mark.querySelector(".bot-row .sidebar-unread")).toBeNull()
  expect(Array.from(mark.querySelectorAll(".thread-row .sidebar-unread"), (badge) => badge.textContent)).toEqual([
    "2",
    "2",
  ])
})

it("keeps bots reachable beside global screens, footer integrations and creation", async () => {
  const api = createMockApi()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  const sidebar = screen.getByRole("navigation", { name: "Barra lateral" })
  openRoutines()
  expect(await screen.findByRole("heading", { name: "Rotinas" })).toBeVisible()
  expect(sidebar.querySelectorAll(".bot-entry")).toHaveLength(api.getState().bots.length)
  fireEvent.click(sidebar.querySelector('[data-bot-id="bot-onb"]')?.closest("button") as HTMLElement)
  expect(await screen.findByRole("textbox", { name: "Mensagem para onb" })).toBeVisible()
  fireEvent.click(within(sidebar).getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  fireEvent.click(within(sidebar).getByRole("button", { name: "Integrações", exact: true }))
  expect(await screen.findByRole("heading", { name: "Integrações" })).toBeVisible()
  fireEvent.click(within(sidebar).getByRole("button", { name: "Criar bot" }))
  expect(screen.getByRole("dialog", { name: "Criar um bot" })).toBeVisible()
})

it("cleans bot, thread and search previews and opens search with either shortcut", async () => {
  const api = createMockApi()
  const state = api.getState()
  const message = state.messages.find((message) => message.threadId === "thread-mark" && message.role === "assistant")
  if (!message) throw new Error("Fixture indisponível")
  message.text = "**21 arquivos `page.tsx`**\n- [ ] Revisar busca"
  message.parts = [{ type: "text", text: message.text }]
  message.createdAt = Date.now() + 1000
  const thread = state.threads.find((thread) => thread.id === "thread-mark")
  if (thread) thread.title = "**Teste** de busca"
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  expect(document.querySelector('[data-bot-entry="bot-mark"] .bot-preview')).toHaveTextContent(
    "21 arquivos page.tsx · Revisar busca",
  )
  expect(document.querySelector(".thread-copy strong")).toHaveTextContent("Teste de busca")
  fireEvent.keyDown(window, { key: "k", metaKey: true })
  const dialog = await screen.findByRole("dialog", { name: "Paleta de comandos" })
  const search = within(dialog).getByRole("combobox", { name: "Buscar bots, conversas e configurações" })
  expect(search).toHaveFocus()
  fireEvent.change(search, { target: { value: "page.tsx" } })
  expect(within(dialog).getByText("21 arquivos page.tsx · Revisar busca")).toBeVisible()
  fireEvent.keyDown(window, { key: "Escape" })
  fireEvent.keyDown(window, { key: "k", ctrlKey: true })
  const reopened = await screen.findByRole("dialog", { name: "Paleta de comandos" })
  expect(within(reopened).getByRole("combobox")).toHaveFocus()
})

it("opening a failure clears row and bell attention persistently, while keeping the history", async () => {
  const api = createMockApi()
  api.notify({
    kind: "turn-failed",
    botId: "bot-onb",
    threadId: "thread-onb",
    title: "Falha recente",
    body: "Tente novamente.",
    createdAt: Date.now() + 1000,
  })
  const first = render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  expect(screen.getByRole("button", { name: "Notificações, 1 precisa de atenção" })).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "Abrir falha de onb" }))
  await screen.findByRole("textbox", { name: "Mensagem para onb" })
  await waitFor(() => expect(screen.getByRole("button", { name: "Notificações" })).toBeVisible())
  expect(screen.queryByRole("button", { name: "Abrir falha de onb" })).toBeNull()
  expect(api.calls.some((call) => call.route === "POST /notifications/:id/dismiss")).toBe(true)
  first.unmount()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para onb" })
  fireEvent.click(screen.getByRole("button", { name: "Notificações" }))
  expect(
    within(screen.getByRole("region", { name: "Central de notificações" })).getByText(
      "Não foi possível concluir esta ação. Confira os detalhes do erro.",
    ),
  ).toBeVisible()
})

it("shows chronological notifications and leaves a superseded failure out of the bell count", async () => {
  const api = createMockApi()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  act(() => {
    api.notify({ kind: "done", botId: "bot-onb", title: "Conclusão recente", body: "Tudo pronto.", createdAt: 300 })
    api.notify({
      kind: "turn-failed",
      botId: "bot-onb",
      title: "Falha histórica",
      body: "Antes da conclusão.",
      createdAt: 100,
    })
    api.notify({ kind: "question", botId: "bot-mark", title: "Pergunta pendente", body: "Qual pasta?", createdAt: 200 })
  })
  fireEvent.click(screen.getByRole("button", { name: "Notificações, 1 precisa de atenção" }))
  const rows = within(screen.getByRole("region", { name: "Central de notificações" })).getAllByTestId(
    "notification-row",
  )
  expect(rows[0]).toHaveTextContent("Conclusão recente")
  expect(rows[1]).toHaveTextContent("Pergunta pendente")
  expect(rows[2]).toHaveTextContent("Não foi possível concluir esta ação. Confira os detalhes do erro.")
  expect(screen.queryByRole("button", { name: "Abrir falha de onb" })).toBeNull()
})

it("searches bots that do not have a conversation yet", async () => {
  const api = createMockApi()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  fireEvent.click(screen.getByRole("button", { name: "Buscar conversas" }))
  const dialog = screen.getByRole("dialog", { name: "Paleta de comandos" })
  fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "Panko" } })
  fireEvent.click(within(dialog).getByRole("option", { name: /Panko/ }))
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Paleta de comandos" })).toBeNull())
  expect(document.querySelector(".bot-row.selected .tb-avatar")).toHaveAttribute("data-bot-id", "bot-panko")
})
