import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ApprovalPart, Message } from "@touri/contracts"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import { ApprovalCard } from "../src/components/ApprovalCard"
import { Sidebar } from "../src/components/BotSidebar"
import { VirtualMessageList } from "../src/components/ChatPanel"
import { settingsIndex } from "../src/features/commandPalette/settingsRegistry"
import { openRoutines, showBotSettings } from "./workspaceNavigation"

beforeEach(() => {
  document.documentElement.dataset.motion = "reduce"
})
afterEach(() => {
  delete document.documentElement.dataset.motion
})

it("F012 offers explicit routine activation in the chat approval card", async () => {
  const api = createMockApi()
  const part: ApprovalPart = {
    type: "approval",
    approvalId: "routine-approval",
    request: "permission",
    decision: "pending",
    allowStanding: false,
    scope: { source: "mcp", server: "touri", tool: "routine_create" },
    detail:
      'routine_create: {"routineId":"routine-daily","name":"Resumo diário QA","prompt":"Me mande aqui um resumo","cron":"0 9 * * *","timezone":"America/Sao_Paulo"}',
  }
  const message = {
    ...api.getState().messages[0],
    id: "routine-reply",
    role: "assistant",
    text: "",
    parts: [part],
  } as Message
  render(<VirtualMessageList messages={[message]} api={api} onSwitchBranch={vi.fn()} onRetry={vi.fn()} />)
  const card = screen.getByRole("article", { name: "Aprovação de ferramenta" })
  expect(card).toHaveTextContent("Resumo diário QA")
  expect(card).toHaveTextContent("Todo dia às 09:00 · horário de São Paulo")
  expect(within(card).queryByRole("button", { name: "Permitir sempre nesta ferramenta" })).toBeNull()
  fireEvent.click(within(card).getByRole("button", { name: "Ativar rotina “Resumo diário QA”" }))
  await waitFor(() =>
    expect(api.calls).toContainEqual({
      route: "POST /approvals/:id",
      input: { decision: "approved", standing: false },
      pathValues: { id: "routine-approval" },
    }),
  )
})

it("F012 distinguishes creation permission from the later activation action", () => {
  render(
    <ApprovalCard
      api={createMockApi()}
      part={{
        type: "approval",
        approvalId: "creation-approval",
        request: "permission",
        decision: "pending",
        allowStanding: false,
        scope: { source: "mcp", server: "touri", tool: "routine_create" },
        detail: 'routine_create: {"name":"Resumo diário QA","cron":"0 9 * * *","timezone":"America/Sao_Paulo"}',
      }}
    />,
  )
  expect(screen.getByText("Criar rotina")).toBeVisible()
  expect(screen.getByRole("button", { name: "Aprovar", exact: true })).toBeVisible()
  expect(screen.queryByRole("button", { name: "Ativar rotina" })).toBeNull()
})

it("F013 opens the bot routines screen directly from the settings tab", async () => {
  const api = createMockApi()
  await api.request("PATCH /routines/:id", { cron: "0 9 * * *" }, { id: "routine-daily" })
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  showBotSettings()
  const dialog = screen.getByRole("dialog")
  fireEvent.click(within(dialog).getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  fireEvent.click(within(dialog).getByRole("tab", { name: "Rotinas" }))
  await waitFor(() => expect(dialog).not.toBeInTheDocument())
  expect(await screen.findByRole("heading", { name: "Rotinas" })).toBeVisible()
  expect(screen.getByRole("button", { name: /Criar rotina/ })).toBeVisible()
  const routines = screen.getByRole("region", { name: "Rotinas" })
  expect(within(routines).getByText("Todo dia às 09:00 · horário de São Paulo")).toBeVisible()
  await waitFor(() => expect(routines).toHaveFocus())
})

it("F013 names the routines page Rotinas in the command palette", () => {
  const entry = settingsIndex({ hasBot: false }).find(
    (item) => item.destination.kind === "page" && item.destination.page === "cron",
  )
  expect(entry?.label).toBe("Rotinas")
  expect(entry?.keywords).toContain("cron")
})

it("F014 closes another bot's menu through navigation, settings and outside interaction", async () => {
  const api = createMockApi()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  const open = (name: string) => fireEvent.click(screen.getByRole("button", { name: `Ações de ${name}` }))
  open("mark")
  expect(screen.getByRole("menu", { name: "Ações de mark" })).toBeVisible()
  const sidebar = screen.getByRole("navigation", { name: "Barra lateral" })
  fireEvent.click(sidebar.querySelector('[data-bot-entry="bot-onb"] .bot-row-main') as HTMLElement)
  await screen.findByRole("textbox", { name: "Mensagem para onb" })
  expect(screen.queryByRole("menu")).toBeNull()
  open("onb")
  await act(async () => {
    fireEvent.click(screen.getByRole("menuitem", { name: "Avançado" }))
  })
  const dialog = screen.getByRole("dialog")
  fireEvent.click(within(dialog).getByRole("button", { name: "Fechar diálogo" }))
  await waitFor(() => expect(dialog).not.toBeInTheDocument())
  expect(screen.queryByRole("menu")).toBeNull()
  open("onb")
  fireEvent.mouseDown(screen.getByRole("textbox", { name: "Mensagem para onb" }))
  expect(screen.queryByRole("menu")).toBeNull()
  open("onb")
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" })
  expect(screen.queryByRole("menu")).toBeNull()
})

it.each([
  { section: "advanced" as const, advancedPage: "mcp" as const },
  { advancedPage: "integracoes" as const },
  { selectedBotId: "bot-onb" },
  { selectedThreadId: "another-thread" },
])("F014 dismisses stale menus on navigation without a pointer event: %j", (navigation) => {
  const state = createMockApi().getState()
  const props: Parameters<typeof Sidebar>[0] = {
    bots: state.bots,
    threads: state.threads,
    messages: [],
    notifications: [],
    showFakeTrafficLights: false,
    selectedBotId: "bot-mark",
    selectedThreadId: "thread-mark",
    section: "bots",
    advancedPage: null,
    onChat: vi.fn(),
    onAdvancedPage: vi.fn(),
    onRoutines: vi.fn(),
    onProject: vi.fn(),
    onImport: vi.fn(),
    onSelect: vi.fn(),
    onSelectThread: vi.fn(),
    onReviewApproval: vi.fn(),
    onNewThread: vi.fn(),
    onNewBot: vi.fn(),
    onBotSettings: vi.fn(),
    onSettings: vi.fn(),
    onDoctor: vi.fn(),
    onSearch: vi.fn(),
    onNotificationsOpen: vi.fn(),
    notificationActions: {
      open: vi.fn(),
      dismiss: vi.fn(),
      dismissAll: vi.fn(),
      respond: vi.fn(),
      reply: vi.fn(),
    },
  }
  const view = render(<Sidebar {...props} />)
  const trigger = screen.getByRole("button", { name: "Ações de mark" })
  fireEvent.click(trigger)
  expect(screen.getByRole("menu", { name: "Ações de mark" })).toBeVisible()
  view.rerender(<Sidebar {...props} {...navigation} />)
  expect(screen.queryByRole("menu")).toBeNull()
  expect(trigger).toHaveAttribute("aria-expanded", "false")
})

it("opens the empty bot's routines directly from Configure routines and focuses the list", async () => {
  const api = createMockApi()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  const sidebar = screen.getByRole("navigation", { name: "Barra lateral" })
  fireEvent.click(sidebar.querySelector('[data-bot-entry="bot-onb"] .bot-row-main') as HTMLElement)
  await screen.findByRole("textbox", { name: "Mensagem para onb" })
  fireEvent.click(screen.getByRole("button", { name: "Painel do bot" }))
  fireEvent.click(screen.getByRole("button", { name: "Configurar rotinas" }))
  const routines = await screen.findByRole("region", { name: "Rotinas" })
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(within(routines).getByRole("button", { name: "onb", exact: true })).toHaveAttribute("aria-pressed", "true")
  expect(within(routines).queryByText("Resumo diário")).toBeNull()
  await waitFor(() => expect(routines).toHaveFocus())
})

it.each(["mark", "onb"])("opens and focuses %s's routines from its actions menu", async (name) => {
  render(<App kernel={{ services: { api: createMockApi() } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  openRoutines(name)
  const routines = await screen.findByRole("region", { name: "Rotinas" })
  expect(within(routines).getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", "true")
  await waitFor(() => expect(routines).toHaveFocus())
})

it("restores the bot filter and list focus when reopening routines from settings on the routines page", async () => {
  render(<App kernel={{ services: { api: createMockApi() } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  openRoutines()
  const routines = await screen.findByRole("region", { name: "Rotinas", exact: true })
  fireEvent.click(within(routines).getByRole("button", { name: "Todos os bots", exact: true }))
  showBotSettings()
  const settings = screen.getByRole("dialog")
  fireEvent.click(within(settings).getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  fireEvent.click(within(settings).getByRole("tab", { name: "Rotinas", exact: true }))
  await waitFor(() => expect(settings).not.toBeInTheDocument())
  const destination = screen.getByRole("region", { name: "Rotinas", exact: true })
  expect(within(destination).getByRole("button", { name: "mark", exact: true })).toHaveAttribute("aria-pressed", "true")
  await waitFor(() => expect(destination).toHaveFocus())
})
