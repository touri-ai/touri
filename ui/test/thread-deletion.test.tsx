import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { Message, Thread } from "@touri/contracts"
import { afterEach, expect, it } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import { t } from "../src/i18n"

afterEach(() => {
  cleanup()
  localStorage.removeItem("touri.workspace.v1")
})

const getThreadFixture = (kind: Thread["kind"] = "chat", routineRunId: Thread["routineRunId"] = null) => {
  const api = createMockApi()
  const state = api.getState()
  const baseThread = state.threads.find((thread) => thread.id === "thread-mark")
  const baseMessage = state.messages[0]
  if (!baseThread || !baseMessage) throw new Error("Missing mock conversation")
  const now = Date.now()
  const thread: Thread = {
    ...baseThread,
    id: kind === "routine" ? "thread-old-routine" : "thread-lead-events",
    title: kind === "routine" ? "Eventos de leads" : "Eventos de leads",
    kind,
    routineRunId,
    createdAt: now - 45 * 24 * 60 * 60_000,
    updatedAt: now - 45 * 24 * 60 * 60_000,
    activeLeafId: "message-lead-event",
    unread: 0,
    archivedAt: null,
  }
  const message: Message = {
    ...baseMessage,
    id: "message-lead-event",
    threadId: thread.id,
    parentId: null,
    role: "assistant",
    text: "Uma atualização automática de exemplo.",
    parts: [{ type: "text", text: "Uma atualização automática de exemplo." }],
    createdAt: thread.updatedAt,
    updatedAt: thread.updatedAt,
  }
  state.threads.push(thread)
  state.messages.push(message)
  localStorage.setItem(
    "touri.workspace.v1",
    JSON.stringify({ botId: "bot-mark", threadId: "thread-mark", route: { section: "bots", screen: "chat" } }),
  )

  return { api, thread }
}

const getConversationRegion = async () => {
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  return screen.getByRole("region", { name: "Conversas de mark" })
}

const openThreadMenu = (title: string) => {
  const thread = screen.getByRole("button", { name: new RegExp(title) })
  const shell = thread.closest(".thread-row-shell")
  if (!(shell instanceof HTMLElement)) throw new Error("Missing conversation row")
  fireEvent.click(within(shell).getByRole("button", { name: "Ações da conversa" }))
}

it("archives a thread under Arquivadas and confirms deletion with a five-second undo", async () => {
  const { api, thread } = getThreadFixture()
  render(<App kernel={{ services: { api } }} />)
  const conversations = await getConversationRegion()
  const rowName = /Eventos de leads/

  expect(within(conversations).getByRole("button", { name: rowName })).toBeVisible()
  openThreadMenu(thread.title)
  fireEvent.click(screen.getByRole("menuitem", { name: "Arquivar conversa" }))
  await waitFor(() => expect(within(conversations).queryByRole("button", { name: rowName })).toBeNull())

  fireEvent.click(within(conversations).getByRole("button", { name: /Arquivadas/ }))
  const archiveList = document.querySelector(".archived-thread-list")
  if (!(archiveList instanceof HTMLElement)) throw new Error("Missing archived conversation list")
  await within(archiveList).findByRole("button", { name: rowName })
  openThreadMenu(thread.title)
  fireEvent.click(screen.getByRole("menuitem", { name: "Desarquivar conversa" }))
  await waitFor(() => expect(within(conversations).getByRole("button", { name: rowName })).toBeVisible())

  openThreadMenu(thread.title)
  fireEvent.click(screen.getByRole("menuitem", { name: "Apagar conversa…" }))
  const confirmation = await screen.findByRole("alertdialog", { name: "Apagar “Eventos de leads”?" })
  expect(confirmation).toHaveTextContent("1 mensagem")
  fireEvent.click(within(confirmation).getByRole("button", { name: "Apagar", exact: true }))
  const undoToast = document.querySelector(".thread-delete-toast")
  if (!(undoToast instanceof HTMLElement)) throw new Error("Missing undo toast")
  expect(undoToast).toHaveTextContent("A conversa será apagada em 5 segundos.")
  fireEvent.click(screen.getByRole("button", { name: "Desfazer" }))

  expect(within(conversations).getByRole("button", { name: rowName })).toBeVisible()
  expect(api.calls.some((call) => call.route === "DELETE /threads/:id")).toBe(false)
})

it("opens an archived conversation by restoring it", async () => {
  const { api, thread } = getThreadFixture()
  render(<App kernel={{ services: { api } }} />)
  const conversations = await getConversationRegion()
  openThreadMenu(thread.title)
  fireEvent.click(screen.getByRole("menuitem", { name: "Arquivar conversa" }))

  fireEvent.click(within(conversations).getByRole("button", { name: /Arquivadas/ }))
  const archiveList = document.querySelector(".archived-thread-list")
  if (!(archiveList instanceof HTMLElement)) throw new Error("Missing archived conversation list")
  fireEvent.click(await within(archiveList).findByRole("button", { name: "Abrir conversa arquivada Eventos de leads" }))

  await waitFor(() =>
    expect(within(conversations).getByRole("button", { name: /Eventos de leads/ })).toHaveClass("selected"),
  )
  expect(api.calls.some((call) => call.route === "PATCH /threads/:id")).toBe(true)
})

it("selects multiple bot conversations and opens one bulk confirmation", async () => {
  const { api, thread } = getThreadFixture()
  const second: Thread = { ...thread, id: "thread-lead-events-2", title: "Mais leads" }
  const firstMessage = api.getState().messages.find((candidate) => candidate.id === "message-lead-event")
  if (!firstMessage) throw new Error("Missing lead event message")
  const message: Message = {
    ...firstMessage,
    id: "message-lead-event-2",
    threadId: second.id,
  }
  api.getState().threads.push(second)
  api.getState().messages.push(message)
  render(<App kernel={{ services: { api } }} />)
  const conversations = await getConversationRegion()

  fireEvent.click(within(conversations).getByRole("button", { name: "Selecionar" }))
  fireEvent.click(within(conversations).getByRole("checkbox", { name: "Selecionar conversa Eventos de leads" }))
  fireEvent.click(within(conversations).getByRole("checkbox", { name: "Selecionar conversa Mais leads" }))
  expect(within(conversations).getByRole("status")).toHaveTextContent("Selecionadas: 2")
  fireEvent.click(within(conversations).getByRole("button", { name: "Apagar selecionadas…" }))

  const confirmation = await screen.findByRole("alertdialog", { name: "Apagar 2 conversas" })
  expect(confirmation).toHaveTextContent("2 conversas encontradas.")
  expect(confirmation).toHaveTextContent("2 mensagens no total")
  fireEvent.click(within(confirmation).getByRole("button", { name: "Cancelar" }))

  expect(within(conversations).getByRole("button", { name: "Sair da seleção" })).toBeVisible()
  expect(api.calls.some((call) => call.route === "POST /threads/delete")).toBe(false)
})

it("finds old automatic conversations using the selected age", async () => {
  const { api } = getThreadFixture("chat", "routine-run-old")
  render(<App kernel={{ services: { api } }} />)
  const conversations = await getConversationRegion()

  fireEvent.click(within(conversations).getByRole("button", { name: "Apagar conversas automáticas antigas…" }))
  const dialog = await screen.findByRole("dialog", { name: "Apagar conversas automáticas antigas" })
  const age = within(dialog).getByRole("spinbutton", { name: /Mais antigas que/ })
  expect(within(dialog).getByRole("status")).toHaveTextContent("1 conversa encontrada.")
  expect(age).toHaveValue(30)
  fireEvent.change(age, { target: { value: "60" } })
  expect(within(dialog).getByRole("status")).toHaveTextContent("Não há conversas automáticas antigas.")
  fireEvent.change(age, { target: { value: "30" } })
  expect(within(dialog).getByRole("status")).toHaveTextContent("1 conversa encontrada.")
  fireEvent.click(within(dialog).getByRole("button", { name: "Continuar" }))
  const confirmation = await screen.findByRole("alertdialog", { name: "Apagar “Eventos de leads”?" })
  expect(confirmation).toHaveTextContent("Isso remove a conversa e os anexos sem uso dela.")
  expect(confirmation).not.toHaveTextContent("0 mensagens")
})

it("provides English labels for archive, deletion confirmation and undo", () => {
  expect(t("Thread actions", {}, "en")).toBe("Conversation actions")
  expect(t("Thread actions for {title}", { title: "Lead events" }, "en")).toBe("Actions for Lead events")
  expect(t("Archive conversation", {}, "en")).toBe("Archive conversation")
  expect(t("Delete “{title}”?", { title: "Lead events" }, "en")).toBe("Delete “Lead events”?")
  expect(t("This removes {count} messages and their unused attachments.", { count: 3 }, "en")).toBe(
    "This removes 3 messages and their unused attachments.",
  )
  expect(t("This removes {count} messages and their unused attachments.", { count: 1 })).toBe(
    "Isso remove 1 mensagem e os anexos sem uso dela.",
  )
  expect(t("Undo", {}, "en")).toBe("Undo")
})

it("finds and restores archived message results after reopening the app", async () => {
  const { api, thread } = getThreadFixture()
  await api.request("PATCH /threads/:id", { archived: true }, { id: thread.id })
  render(<App kernel={{ services: { api } }} />)
  await getConversationRegion()

  fireEvent.keyDown(window, { key: "k", metaKey: true })
  const input = await screen.findByRole("combobox", { name: "Buscar bots, conversas e configurações" })
  fireEvent.change(input, { target: { value: "atualização automática" } })
  const result = await screen.findByRole("option", { name: /Uma atualização automática de exemplo/ })
  fireEvent.click(result)

  await waitFor(() => expect(api.getState().threads.find(({ id }) => id === thread.id)?.archivedAt).toBeNull())
  await waitFor(() => expect(screen.getByRole("button", { name: /Eventos de leads/ })).toHaveClass("selected"))
})

it("refreshes an already loaded archive after archiving a selection", async () => {
  const { api, thread } = getThreadFixture()
  render(<App kernel={{ services: { api } }} />)
  const conversations = await getConversationRegion()
  const toggle = within(conversations).getByRole("button", { name: /Arquivadas/ })
  fireEvent.click(toggle)
  await screen.findByText("Não há conversas arquivadas.")
  fireEvent.click(toggle)

  fireEvent.click(within(conversations).getByRole("button", { name: "Selecionar", exact: true }))
  fireEvent.click(within(conversations).getByRole("checkbox", { name: `Selecionar conversa ${thread.title}` }))
  fireEvent.click(within(conversations).getByRole("button", { name: "Arquivar selecionadas" }))
  await waitFor(() => expect(within(conversations).queryByRole("button", { name: /Eventos de leads/ })).toBeNull())
  fireEvent.click(toggle)

  await screen.findByRole("button", { name: "Abrir conversa arquivada Eventos de leads" })
})

it("returns to the main conversation when archiving the conversation in use", async () => {
  const { api, thread } = getThreadFixture()
  const mainTitle = api.getState().threads.find(({ id }) => id === "thread-mark")?.title
  if (!mainTitle) throw new Error("Missing main conversation")
  render(<App kernel={{ services: { api } }} />)
  const conversations = await getConversationRegion()
  fireEvent.click(within(conversations).getByRole("button", { name: /Eventos de leads/ }))
  await waitFor(() =>
    expect(within(conversations).getByRole("button", { name: /Eventos de leads/ })).toHaveClass("selected"),
  )

  openThreadMenu(thread.title)
  fireEvent.click(screen.getByRole("menuitem", { name: "Arquivar conversa" }))

  await waitFor(() => expect(within(conversations).queryByRole("button", { name: /Eventos de leads/ })).toBeNull())
  expect(document.querySelector(".thread-row.selected strong")).toHaveTextContent(mainTitle)
  expect(screen.getByRole("textbox", { name: "Mensagem para mark" })).toBeEnabled()
})

it("bounds selection pages and preserves selection while paging a large history", async () => {
  const { api, thread } = getThreadFixture()
  // The mock exposes a fixture-only mutable collection before the app mounts.
  api
    .getState()
    .threads.push(
      ...Array.from({ length: 220 }, (_, index) => ({ ...thread, id: `paged-${index}`, title: `Synthetic ${index}` })),
    )
  render(<App kernel={{ services: { api } }} />)
  const conversations = await getConversationRegion()

  fireEvent.click(within(conversations).getByRole("button", { name: "Selecionar", exact: true }))
  expect(within(conversations).getAllByRole("checkbox")).toHaveLength(100)
  fireEvent.click(within(conversations).getByRole("checkbox", { name: "Selecionar conversa Eventos de leads" }))
  fireEvent.click(within(conversations).getByRole("button", { name: "Próximas conversas" }))

  expect(within(conversations).getAllByRole("checkbox")).toHaveLength(100)
  expect(within(conversations).getByRole("status")).toHaveTextContent("Selecionadas: 1")
  fireEvent.click(within(conversations).getByRole("button", { name: "Conversas anteriores" }))
  expect(within(conversations).getByRole("checkbox", { name: "Selecionar conversa Eventos de leads" })).toBeChecked()
})

it("removes a conversation deleted while disconnected after a fresh snapshot", async () => {
  const { api, thread } = getThreadFixture()
  const disconnectedApi = {
    ...api,
    subscribe: (listener: Parameters<typeof api.subscribe>[0]) =>
      api.subscribe((event) => {
        if (event.type !== "thread.deleted") listener(event)
      }),
  }
  render(<App kernel={{ services: { api: disconnectedApi } }} />)
  const conversations = await getConversationRegion()
  fireEvent.click(within(conversations).getByRole("button", { name: /Eventos de leads/ }))

  await api.request("DELETE /threads/:id", {}, { id: thread.id })
  act(() => api.emit({ type: "transcript.resync" }))

  await waitFor(() => expect(within(conversations).queryByRole("button", { name: /Eventos de leads/ })).toBeNull())
})

it("removes externally deleted conversations from an already open archive", async () => {
  const { api, thread } = getThreadFixture()
  await api.request("PATCH /threads/:id", { archived: true }, { id: thread.id })
  render(<App kernel={{ services: { api } }} />)
  const conversations = await getConversationRegion()
  fireEvent.click(within(conversations).getByRole("button", { name: /Arquivadas/ }))
  await screen.findByRole("button", { name: "Abrir conversa arquivada Eventos de leads" })

  await api.request("DELETE /threads/:id", {}, { id: thread.id })

  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Abrir conversa arquivada Eventos de leads" })).toBeNull(),
  )
})

it("finds an archived conversation by its title after reopening the app", async () => {
  const { api, thread } = getThreadFixture()
  await api.request("PATCH /threads/:id", { archived: true }, { id: thread.id })
  render(<App kernel={{ services: { api } }} />)
  await getConversationRegion()

  fireEvent.keyDown(window, { key: "k", metaKey: true })
  const input = await screen.findByRole("combobox", { name: "Buscar bots, conversas e configurações" })
  fireEvent.change(input, { target: { value: "EVENTOS leads" } })
  fireEvent.click(await screen.findByRole("option", { name: /Eventos de leads/ }))

  await waitFor(() => expect(api.getState().threads.find(({ id }) => id === thread.id)?.archivedAt).toBeNull())
  expect(screen.getByRole("button", { name: /Eventos de leads/ })).toHaveClass("selected")
})
