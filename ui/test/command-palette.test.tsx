import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ApprovalPart } from "@touri/contracts"
import axe from "axe-core"
import { afterEach, expect, it, vi } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import { matchScore, normalizeSearch, queryTokens } from "../src/features/commandPalette/fuzzy"
import * as paletteItems from "../src/features/commandPalette/paletteItems"
import { buildPaletteIndex, searchPalette } from "../src/features/commandPalette/paletteItems"
import { SETTINGS, settingsIndex } from "../src/features/commandPalette/settingsRegistry"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const DIALOG = "Paleta de comandos"
const INPUT = "Buscar bots, conversas e configurações"

const start = async (api = createMockApi()) => {
  render(<App kernel={{ services: { api } }} />)
  const composer = await screen.findByRole("textbox", { name: "Mensagem para mark" })
  return { api, composer }
}

const openPalette = async (): Promise<HTMLElement> => {
  fireEvent.keyDown(window, { key: "k", metaKey: true })
  return screen.findByRole("combobox", { name: INPUT })
}

const search = async (query: string): Promise<HTMLElement> => {
  const input = await openPalette()
  fireEvent.change(input, { target: { value: query } })
  return input
}

const activeOption = (input: HTMLElement): HTMLElement | null => {
  const id = input.getAttribute("aria-activedescendant")
  return id ? document.getElementById(id) : null
}

const closed = async (): Promise<void> => {
  await waitFor(() => expect(screen.queryByRole("dialog", { name: DIALOG })).toBeNull())
}

it("normalizes accents and case and fuzzy-matches labels", () => {
  expect(normalizeSearch("  Configuração  DO Bot ")).toBe("configuracao do bot")
  expect(
    matchScore(queryTokens("configuracao"), { label: normalizeSearch("Configuração"), extra: "" }),
  ).toBeGreaterThan(0)
  expect(
    matchScore(queryTokens("memria"), { label: normalizeSearch("Memória por computador"), extra: "" }),
  ).toBeGreaterThan(0)
  expect(matchScore(queryTokens("xyz"), { label: normalizeSearch("Memória"), extra: "" })).toBe(0)
  const settings = settingsIndex({ hasBot: true })
  const index = buildPaletteIndex({ bots: [], threads: [], settings, hasBot: true })
  const groups = searchPalette({ index, query: "notificacoes", messages: [], recentIds: [] })
  expect(groups[0]?.items[0]?.label).toBe("Notificações")
  expect(settings.some((entry) => entry.label === SETTINGS.sidebarFloatUpdates.label)).toBe(true)
  expect(settings.some((entry) => entry.label === "Nuvem")).toBe(false)
})

it("⌘K and Ctrl+K open, ⌘K toggles closed, and plain typing in the composer never opens it", async () => {
  const { composer } = await start()
  fireEvent.keyDown(composer, { key: "k" })
  expect(screen.queryByRole("dialog", { name: DIALOG })).toBeNull()
  const input = await openPalette()
  expect(screen.getByRole("dialog", { name: DIALOG })).toBeVisible()
  expect(input).toHaveFocus()
  expect(input).toHaveAttribute("aria-expanded", "true")
  fireEvent.keyDown(input, { key: "k", metaKey: true })
  await closed()
  act(() => composer.focus())
  fireEvent.keyDown(composer, { key: "k", ctrlKey: true })
  expect(screen.getByRole("combobox", { name: INPUT })).toHaveFocus()
})

it("Esc closes the palette and returns focus to where it was", async () => {
  const { composer } = await start()
  act(() => composer.focus())
  const input = await openPalette()
  expect(input).toHaveFocus()
  fireEvent.keyDown(input, { key: "Escape" })
  await closed()
  expect(composer).toHaveFocus()
})

it("shows recent conversations and actions with an empty query, then remembers what was opened", async () => {
  await start()
  await openPalette()
  const dialog = screen.getByRole("dialog", { name: DIALOG })
  expect(within(dialog).getByRole("group", { name: "Conversas recentes" })).toBeVisible()
  expect(within(dialog).getByRole("option", { name: /Novo bot/ })).toBeVisible()
  expect(within(dialog).queryByRole("group", { name: "Recentes" })).toBeNull()
  const input = screen.getByRole("combobox", { name: INPUT })
  fireEvent.change(input, { target: { value: "panko" } })
  fireEvent.keyDown(input, { key: "Enter" })
  await closed()
  await openPalette()
  const recent = screen.getByRole("group", { name: "Recentes" })
  expect(within(recent).getByRole("option", { name: /Panko/ })).toBeVisible()
})

it("arrow keys move the highlighted option, wrap, announce counts, and Enter opens a bot", async () => {
  await start()
  const input = await search("o")
  const options = screen.getAllByRole("option")
  expect(options.length).toBeGreaterThan(2)
  expect(screen.getByRole("status")).toHaveTextContent(`${options.length} resultados`)
  expect(activeOption(input)).toBe(options[0])
  expect(options[0]).toHaveAttribute("aria-selected", "true")
  fireEvent.keyDown(input, { key: "ArrowDown" })
  expect(activeOption(input)).toBe(options[1])
  expect(options[0]).toHaveAttribute("aria-selected", "false")
  fireEvent.keyDown(input, { key: "ArrowUp" })
  fireEvent.keyDown(input, { key: "ArrowUp" })
  expect(activeOption(input)).toBe(options.at(-1))
  fireEvent.mouseMove(options[1] as HTMLElement)
  expect(activeOption(input)).toBe(options[1])
  fireEvent.change(input, { target: { value: "panko" } })
  expect(activeOption(input)).toHaveTextContent("Panko")
  fireEvent.keyDown(input, { key: "Enter" })
  await closed()
  await waitFor(() =>
    expect(document.querySelector(".bot-row.selected .tb-avatar")).toHaveAttribute("data-bot-id", "bot-panko"),
  )
})

it("Tab stays inside the palette", async () => {
  await start()
  const input = await openPalette()
  fireEvent.keyDown(input, { key: "Tab" })
  fireEvent.keyDown(input, { key: "Tab", shiftKey: true })
  expect(screen.getByRole("dialog", { name: DIALOG })).toContainElement(document.activeElement as HTMLElement)
})

it("opens a conversation by its title and clicking a result works", async () => {
  await start()
  await search("welcome")
  const option = within(screen.getByRole("group", { name: "Conversas" })).getByRole("option", { name: /Welcome/ })
  fireEvent.click(option)
  await closed()
  await screen.findByRole("textbox", { name: "Mensagem para onb" })
})

it("opens a specific setting, focusing and highlighting it on the right tab", async () => {
  await start()
  const input = await search("memoria vm")
  expect(activeOption(input)).toHaveTextContent(SETTINGS.vmMemory.label)
  fireEvent.keyDown(input, { key: "Enter" })
  const dialog = await screen.findByRole("dialog", { name: "Configurações" })
  expect(within(dialog).getByRole("tab", { name: "Diagnóstico" })).toHaveAttribute("aria-selected", "true")
  const field = within(dialog).getByLabelText(SETTINGS.vmMemory.label)
  await waitFor(() => expect(field).toHaveFocus())
  expect(field.closest("[data-setting-id]")).toHaveAttribute("data-setting-highlight", "true")
})

it("finds the sidebar ordering preference without the accent and lands on its switch", async () => {
  await start()
  const input = await search("mover bots novidades")
  expect(activeOption(input)).toHaveTextContent("Mover bots com novidades para o topo")
  fireEvent.keyDown(input, { key: "Enter" })
  const dialog = await screen.findByRole("dialog", { name: "Configurações" })
  expect(within(dialog).getByRole("tab", { name: "Aparência" })).toHaveAttribute("aria-selected", "true")
  await waitFor(() =>
    expect(within(dialog).getByRole("switch", { name: "Mover bots com novidades para o topo" })).toHaveFocus(),
  )
})

it("navigates to pages and runs creation actions", async () => {
  await start()
  fireEvent.keyDown(await search("integracoes"), { key: "Enter" })
  expect(await screen.findByRole("heading", { name: "Integrações" })).toBeVisible()
  fireEvent.keyDown(await search("novo grupo"), { key: "Enter" })
  expect(await screen.findByRole("dialog", { name: /grupo/i })).toBeVisible()
})

it("never approves: approval cards are not palette results and Enter in the palette leaves them pending", async () => {
  const api = createMockApi()
  const message = api.getState().messages.find((row) => row.threadId === "thread-mark" && row.role === "assistant")
  if (!message) throw new Error("Fixture indisponível")
  const approval: ApprovalPart = {
    type: "approval",
    approvalId: "approval-palette",
    request: "permission",
    detail: "Executar comando aprovar",
    decision: "pending",
    allowStanding: true,
  }
  message.kind = "approval"
  message.parts = [approval]
  await start(api)
  const approve = await screen.findByRole("button", { name: "Aprovar" })
  act(() => approve.focus())
  for (const query of ["aprovar", "Executar comando", "permitir sempre nesta ferramenta"]) {
    await search(query)
    const labels = screen.queryAllByRole("option").map((option) => option.textContent ?? "")
    expect(labels.some((label) => /^Aprovar|Executar comando|Permitir sempre nesta ferramenta/.test(label))).toBe(false)
    fireEvent.keyDown(window, { key: "Escape" })
    await closed()
    expect(approve).toHaveFocus()
  }
  fireEvent.keyDown(await search("mark"), { key: "Enter" })
  await closed()
  expect(api.calls.some((call) => call.route.startsWith("POST /approvals"))).toBe(false)
  expect(screen.getByRole("button", { name: "Aprovar" })).toBeVisible()
})

it("does not open over another dialog", async () => {
  await start()
  fireEvent.click(screen.getByRole("button", { name: "Criar bot" }))
  expect(screen.getByRole("dialog", { name: "Criar um bot" })).toBeVisible()
  fireEvent.keyDown(window, { key: "k", metaKey: true })
  expect(screen.queryByRole("dialog", { name: DIALOG })).toBeNull()
})

it("opens provider login in the bot’s Access section", async () => {
  await start()
  const input = await search("login do provedor")
  expect(activeOption(input)).toHaveTextContent(SETTINGS.providerLogin.label)
  fireEvent.keyDown(input, { key: "Enter" })
  const dialog = await screen.findByRole("dialog", { name: "Configurações de mark" })
  expect(within(dialog).getByRole("tab", { name: "Acesso" })).toHaveAttribute("aria-selected", "true")
})

it("keeps results bounded with hundreds of bots and threads", () => {
  const state = createMockApi().getState()
  const [bot] = state.bots
  const [thread] = state.threads
  if (!bot || !thread) throw new Error("Fixture indisponível")
  const bots = Array.from({ length: 600 }, (_, index) => ({ ...bot, id: `bot-${index}`, name: `agente ${index}` }))
  const threads = Array.from({ length: 3000 }, (_, index) => ({
    ...thread,
    id: `thread-${index}`,
    botId: `bot-${index % 600}`,
    title: `Revisão ${index}`,
    updatedAt: index,
  }))
  const index = buildPaletteIndex({ bots, threads, settings: [], hasBot: true })
  const groups = searchPalette({ index, query: "agente 59", messages: [], recentIds: [] })
  const botGroup = groups.find((group) => group.id === "bots")
  expect(botGroup?.items).toHaveLength(8)
  expect(botGroup?.items[0]?.label).toBe("agente 59")
  const revisions = searchPalette({ index, query: "revisao", messages: [], recentIds: [] })
  expect(revisions.find((group) => group.id === "threads")?.items[0]?.label).toBe("Revisão 2999")
})

it("R13-05 ranks an exact action or setting above older message matches, messages last", () => {
  const api = createMockApi()
  const state = api.getState()
  const bot = state.bots[0]
  const thread = state.threads[0]
  if (!bot || !thread) throw new Error("fixture")
  const settings = settingsIndex({ hasBot: true })
  const index = buildPaletteIndex({ bots: [bot], threads: [thread], settings, hasBot: true })
  const message = (text: string, id: string) => ({
    message: { id, threadId: thread.id, text, createdAt: 1 } as never,
    thread,
    text: normalizeSearch(text),
  })
  const messages = [message("Quero um novo bot para o time de vendas", "m1"), message("memoria da VM esta cheia", "m2")]
  const novo = searchPalette({ index, query: "Novo bot", messages, recentIds: [] })
  expect(novo[0]?.id).toBe("actions")
  expect(novo[0]?.items[0]?.label).toBe("Novo bot")
  expect(novo.at(-1)?.id).toBe("messages")
  const memoria = searchPalette({ index, query: "memoria da VM", messages, recentIds: [] })
  expect(memoria[0]?.id).toBe("settings")
  expect(memoria.at(-1)?.id).toBe("messages")
  const only = searchPalette({ index, query: "vendas", messages, recentIds: [] })
  expect(only.map((group) => group.id)).toEqual(["messages"])
})

it("leaves search indexing idle while the palette is closed", async () => {
  const index = vi.spyOn(paletteItems, "buildPaletteIndex")
  const { composer } = await start()

  fireEvent.change(composer, { target: { value: "Organize minhas notas." } })

  expect(index).not.toHaveBeenCalled()

  const input = await openPalette()

  expect(input).toHaveFocus()
  expect(index).toHaveBeenCalled()
})

it("drops the listbox role when a query has no matches, announces empty results once, and has zero axe violations", async () => {
  await start()
  const input = await openPalette()
  const dialog = screen.getByRole("dialog", { name: DIALOG })

  expect(input).toHaveAttribute("aria-expanded", "true")
  expect(within(dialog).getByRole("listbox", { name: "Resultados" })).toBeVisible()
  const nonEmptyAxe = await axe.run(dialog, { rules: { "color-contrast": { enabled: false } } })
  expect(nonEmptyAxe.violations.map((v) => v.id)).toEqual([])

  fireEvent.change(input, { target: { value: "zzzz" } })

  expect(input).toHaveAttribute("aria-expanded", "false")
  expect(within(dialog).queryByRole("listbox")).toBeNull()
  const statuses = within(dialog).getAllByRole("status")
  expect(statuses).toHaveLength(1)
  expect(statuses[0]).toHaveClass("visually-hidden")
  expect(statuses[0]).toHaveTextContent("Nenhum resultado encontrado.")
  const emptyCopy = dialog.querySelector(".command-palette-empty")
  expect(emptyCopy).toHaveAttribute("aria-hidden", "true")
  expect(emptyCopy).not.toHaveAttribute("role")
  expect(emptyCopy).toHaveTextContent("Nenhum resultado encontrado.")

  const emptyAxe = await axe.run(dialog, { rules: { "color-contrast": { enabled: false } } })
  expect(emptyAxe.violations.map((v) => v.id)).toEqual([])
})

it("finds the Trabalho and Desempenho pages by their visible names", async () => {
  const index = buildPaletteIndex({ bots: [], threads: [], settings: settingsIndex({ hasBot: true }), hasBot: true })
  const getTop = (query: string) => searchPalette({ index, query, messages: [], recentIds: [] })[0]?.items[0]

  expect(getTop("trabalho")?.label).toBe("Trabalho")
  expect(getTop("desempenho")?.label).toBe("Desempenho")
})

it("returns a single result for the project dialog", async () => {
  const index = buildPaletteIndex({ bots: [], threads: [], settings: settingsIndex({ hasBot: true }), hasBot: true })
  const getLabels = (query: string) =>
    searchPalette({ index, query, messages: [], recentIds: [] }).flatMap((group) =>
      group.items.map((item) => item.label),
    )

  expect(getLabels("projeto").filter((label) => /^(Conectar projeto|Projetos)$/.test(label))).toEqual([
    "Conectar projeto",
  ])
  expect(getLabels("projetos")).toContain("Conectar projeto")
  expect(getLabels("projetos")).not.toContain("Projetos")
})

it("opens the Trabalho page, the Desempenho page and the projects dialog from the palette", async () => {
  await start()

  fireEvent.keyDown(await search("trabalho"), { key: "Enter" })
  await closed()

  expect(await screen.findByRole("heading", { name: /Trabalho/ })).toBeVisible()

  fireEvent.keyDown(await search("desempenho"), { key: "Enter" })
  await closed()

  expect(await screen.findByRole("heading", { name: /Desempenho/ })).toBeVisible()

  fireEvent.keyDown(await search("projetos"), { key: "Enter" })
  await closed()

  expect(await screen.findByRole("dialog", { name: /Conectar projeto/ })).toBeVisible()
})
