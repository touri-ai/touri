import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import { getRoutineSidebarFixture } from "./routine-sidebar-fixture"
import { openConversations } from "./workspaceNavigation"

const clearSidebarMode = (): void => window.localStorage.removeItem("touri.sidebar.mode")

beforeEach(clearSidebarMode)
afterEach(cleanup)

describe("sidebar work mode", () => {
  it("keeps channel requests reachable without duplicating the bot-row action in Bots mode", async () => {
    const api = createMockApi()
    const { thread } = await api.request("POST /groups", {
      name: "Equipe QA",
      color: "#dc2626",
      avatarShape: "classic-none",
      memberIds: ["bot-mark"],
      coordinatorBotId: null,
    })
    api.notify({
      kind: "takeover",
      title: "Lia precisa de ajuda",
      body: "Conclua o acesso no navegador.",
      botId: "bot-mark",
      threadId: thread.id,
      requestId: "channel-browser-request",
    })

    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    await waitFor(() => expect(screen.getByRole("tab", { name: /^Work,/ })).toHaveAttribute("aria-selected", "true"))

    expect(document.querySelectorAll(".sidebar-needs-you")).toHaveLength(1)
    const workPanel = document.getElementById("sidebar-mode-panel-work")
    if (!workPanel) throw new Error("Missing Work navigation")
    expect(within(workPanel).queryByRole("button", { name: "Abrir pendência de mark" })).toBeNull()

    fireEvent.click(screen.getByRole("tab", { name: /^Bots,/ }))

    expect(document.querySelector(".sidebar-needs-you")).toBeNull()
    expect(screen.getByRole("button", { name: "Abrir pendência de mark" })).toBeVisible()
  })

  it("opens Work by default for existing channels and keeps both mode panels mounted", async () => {
    const api = createMockApi()
    const { thread } = await api.request("POST /groups", {
      name: "Equipe QA",
      color: "#dc2626",
      avatarShape: "classic-none",
      memberIds: ["bot-mark", "bot-onb"],
      coordinatorBotId: "bot-mark",
    })
    await api.request("PATCH /threads/:id", { unread: 3 }, { id: thread.id })

    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    await waitFor(() => expect(screen.getByRole("tab", { name: /^Work,/ })).toHaveAttribute("aria-selected", "true"))

    const workPanel = document.getElementById("sidebar-mode-panel-work")
    const botsPanel = document.getElementById("sidebar-mode-panel-bots")
    if (!workPanel || !botsPanel) throw new Error("Missing persistent sidebar mode panels")
    const botEntry = document.querySelector('[data-bot-entry="bot-mark"]')
    const dmEntry = document.querySelector('[data-work-bot-entry="bot-mark"]')
    if (!botEntry || !dmEntry) throw new Error("Both navigation lists should remain mounted")
    expect(workPanel).not.toHaveAttribute("hidden")
    expect(botsPanel).toHaveAttribute("hidden")
    expect(screen.getByRole("tab", { name: "Work, 3 mensagens não lidas" })).toBeVisible()
    expect(screen.getByRole("tab", { name: "Bots, 0 aguardando" }).querySelector(".sidebar-unread")).toBeNull()

    const channels = screen.getByRole("region", { name: "Canais" })
    expect(within(channels).getByRole("button", { name: "Equipe QA, 3 mensagens não lidas" })).toBeVisible()
    expect(within(channels).getByRole("button", { name: "Novo canal" })).toBeVisible()
    expect(screen.getByRole("heading", { name: "Mensagens diretas" })).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Buscar canais e mensagens" }))
    expect(await screen.findByRole("dialog", { name: "Paleta de comandos" })).toBeVisible()
    fireEvent.keyDown(window, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Paleta de comandos" })).toBeNull())

    fireEvent.click(screen.getByRole("tab", { name: /^Bots,/ }))

    expect(screen.queryByRole("region", { name: "Canais" })).toBeNull()
    expect(screen.queryByRole("button", { name: /^Equipe QA/ })).toBeNull()
    expect(document.getElementById("sidebar-mode-panel-work")).toBe(workPanel)
    expect(workPanel).toHaveAttribute("hidden")
    expect(botsPanel).not.toHaveAttribute("hidden")
    expect(document.querySelector('[data-bot-entry="bot-mark"]')).toBe(botEntry)
    expect(document.querySelector('[data-work-bot-entry="bot-mark"]')).toBe(dmEntry)
    expect(screen.getByRole("tab", { name: /^Bots,/ })).toHaveAttribute("aria-selected", "true")

    fireEvent.click(screen.getByRole("tab", { name: /^Work,/ }))
    expect(document.getElementById("sidebar-mode-panel-work")).toBe(workPanel)
    expect(workPanel).not.toHaveAttribute("hidden")
    expect(document.querySelector('[data-bot-entry="bot-mark"]')).toBe(botEntry)
    expect(document.querySelector('[data-work-bot-entry="bot-mark"]')).toBe(dmEntry)
    const restoredChannel = within(screen.getByRole("region", { name: "Canais" })).getByRole("button", {
      name: /^Equipe QA/,
    })
    expect(restoredChannel).toBeVisible()
    fireEvent.click(restoredChannel)
    await screen.findByRole("textbox", { name: "Mensagem para Equipe QA" })
    expect(document.querySelector(".group-header .chat-header-crumb")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Editar canal" }))
    const editChannel = screen.getByRole("dialog", { name: "Editar canal" })
    expect(within(editChannel).getByRole("textbox", { name: "Nome do canal" })).toHaveValue("Equipe QA")
  })

  it("remembers the selected mode on this device after the sidebar remounts", async () => {
    const api = createMockApi()
    const firstSidebar = render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    fireEvent.click(screen.getByRole("tab", { name: /^Work,/ }))
    expect(window.localStorage.getItem("touri.sidebar.mode")).toBe("work")

    firstSidebar.unmount()
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })

    expect(screen.getByRole("tab", { name: /^Work,/ })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("region", { name: "Canais" })).toBeVisible()
  })

  it("moves between tabs with the arrow keys and keeps the focused tab selected", async () => {
    render(<App kernel={{ services: { api: createMockApi() } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })

    const botsTab = screen.getByRole("tab", { name: /^Bots,/ })
    const workTab = screen.getByRole("tab", { name: /^Work,/ })
    botsTab.focus()
    fireEvent.keyDown(botsTab, { key: "ArrowRight" })

    expect(workTab).toHaveFocus()
    expect(workTab).toHaveAttribute("aria-selected", "true")

    fireEvent.keyDown(workTab, { key: "ArrowLeft" })

    expect(botsTab).toHaveFocus()
    expect(botsTab).toHaveAttribute("aria-selected", "true")
  })

  it("collapses thirty automatic threads into one routine row that opens its history", async () => {
    const { api, routines } = await getRoutineSidebarFixture(30, { todayRuns: true })
    const routine = routines[0]
    if (!routine) throw new Error("Missing routine fixture")
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })

    const conversations = openConversations()
    const routineRow = within(conversations).getByRole("button", { name: /^Rotinas/ })
    expect(routineRow).toHaveTextContent(/Rotinas\s*30 hoje/)
    expect(conversations.querySelectorAll(".thread-row")).toHaveLength(2)

    fireEvent.click(routineRow)
    await screen.findByRole("button", { name: "Histórico de execuções" })
    const history = document.querySelector(".routine-run-history")
    if (!(history instanceof HTMLElement)) throw new Error("Missing routine history")

    expect(history).toHaveAttribute("data-open", "true")
    expect(within(history).getByRole("combobox", { name: "Filtrar histórico por rotina" })).toHaveValue(routine.id)
    expect(within(history).getAllByRole("button", { name: "Abrir conversa" })).toHaveLength(30)
  })
})

describe("sidebar design", () => {
  const createChannels = async (api: ReturnType<typeof createMockApi>, unread: number[]): Promise<void> => {
    const created = await Promise.all(
      unread.map((_, index) =>
        api.request("POST /groups", {
          name: `Canal ${index + 1}`,
          color: "#dc2626",
          avatarShape: "classic-none",
          memberIds: ["bot-mark", "bot-onb"],
          coordinatorBotId: "bot-mark",
        }),
      ),
    )
    await Promise.all(
      created.map(({ thread }, index) =>
        api.request("PATCH /threads/:id", { unread: unread[index] ?? 0 }, { id: thread.id }),
      ),
    )
  }

  it("shows a count for channel unread messages and direct messages that need you", async () => {
    const api = createMockApi()
    const { thread } = await api.request("POST /groups", {
      name: "Equipe QA",
      color: "#dc2626",
      avatarShape: "classic-none",
      memberIds: ["bot-mark", "bot-onb"],
      coordinatorBotId: "bot-mark",
    })
    await api.request("PATCH /threads/:id", { unread: 2 }, { id: thread.id })
    const { thread: directMessage } = await api.request("POST /threads", {
      botId: "bot-onb",
      title: "Conversa da loja",
    })
    await api.request("PATCH /threads/:id", { unread: 3 }, { id: directMessage.id })
    api.notify({
      kind: "question",
      botId: "bot-onb",
      threadId: directMessage.id,
      title: "Uma pergunta",
      body: "Qual caminho devo seguir?",
    })
    window.localStorage.setItem("touri.sidebar.mode", "work")
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })

    const workTab = screen.getByRole("tab", {
      name: "Work, 1 item precisa da sua atenção, 5 mensagens não lidas",
    })
    const botsTab = screen.getByRole("tab", { name: "Bots, 1 item precisa da sua atenção" })

    expect(workTab.querySelector('.sidebar-unread[data-tone="attention"]')).toHaveTextContent("1")
    expect(workTab.querySelector('.sidebar-unread[data-tone="unread"]')).toHaveTextContent("5")
    expect(botsTab.querySelector('.sidebar-unread[data-tone="attention"]')).toHaveTextContent("1")
    expect(workTab).toHaveAccessibleName("Work, 1 item precisa da sua atenção, 5 mensagens não lidas")
  })

  it("keeps channel unread messages out of the compact direct-message row", async () => {
    const api = createMockApi()
    await Promise.all(
      api
        .getState()
        .threads.filter((candidate) => !candidate.groupId)
        .map((candidate) => api.request("PATCH /threads/:id", { unread: 0 }, { id: candidate.id })),
    )
    const { thread } = await api.request("POST /groups", {
      name: "Equipe QA",
      color: "#dc2626",
      avatarShape: "classic-none",
      memberIds: ["bot-mark", "bot-onb"],
      coordinatorBotId: "bot-mark",
    })
    await api.request("PATCH /threads/:id", { unread: 4 }, { id: thread.id })
    window.localStorage.setItem("touri.sidebar.mode", "work")
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })

    expect(screen.getByRole("tab", { name: "Work, 4 mensagens não lidas" })).toBeVisible()
    expect(screen.getByRole("button", { name: "Equipe QA, 4 mensagens não lidas" })).toBeVisible()
    const directMessageRow = document.querySelector('[data-work-bot-entry="bot-mark"]')
    if (!directMessageRow) throw new Error("Missing direct-message row")
    expect(directMessageRow.querySelector(".sidebar-unread")).toBeNull()
  })

  it("hides both mode counts when there is nothing unread or waiting", async () => {
    render(<App kernel={{ services: { api: createMockApi() } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })

    for (const name of ["Bots, 0 aguardando", "Work, 0 aguardando"]) {
      expect(screen.getByRole("tab", { name }).querySelector(".sidebar-unread")).toBeNull()
    }
  })

  it("gives channels and direct messages the same row with at most one marker", async () => {
    const api = createMockApi()
    await createChannels(api, [12, 0, 3])
    window.localStorage.setItem("touri.sidebar.mode", "work")
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })

    const rows = Array.from(document.querySelectorAll("#sidebar-mode-panel-work .sidebar-row"))
    const channelRows = rows.filter((row) => row.querySelector(".group-select"))
    const botRows = rows.filter((row) => row.querySelector(".bot-row-main"))

    expect(channelRows).toHaveLength(3)
    expect(botRows.length).toBeGreaterThan(0)
    expect(rows).toHaveLength(channelRows.length + botRows.length)
    for (const row of rows) {
      expect(row.querySelectorAll(".sidebar-row-main > :is(.sidebar-unread, .sidebar-status-dot)").length).toBeLessThan(
        2,
      )
      expect(row.querySelector(".sidebar-row-leading")).not.toBeNull()
    }
    expect(channelRows[0]?.querySelector(".sidebar-unread")).toHaveTextContent("12")
    expect(channelRows[0]?.querySelector(".group-mascots")).toBeNull()
    expect(screen.getByRole("button", { name: "Buscar canais e mensagens" })).toBeVisible()
    expect(channelRows[0]?.querySelectorAll(".channel-bot-avatar")).toHaveLength(0)
  })

  it("shows one quiet preview per direct message and keeps the channel header free of counts", async () => {
    const api = createMockApi()
    await createChannels(api, [2])
    window.localStorage.setItem("touri.sidebar.mode", "work")
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })

    const channels = screen.getByRole("region", { name: "Canais" })

    expect(within(channels).getByRole("heading", { name: "Canais" })).toBeVisible()
    expect(within(channels).getByRole("button", { name: "Convidar pessoa" })).toHaveTextContent("+ Convidar")
    expect(
      document.querySelectorAll("#sidebar-mode-panel-work .bot-preview:not(.visually-hidden):not(.paused)"),
    ).toHaveLength(api.getState().bots.filter((bot) => !bot.paused).length)
  })

  it("explains channels in the empty state and offers one way to create the first", async () => {
    window.localStorage.setItem("touri.sidebar.mode", "work")
    render(<App kernel={{ services: { api: createMockApi() } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })

    const channels = screen.getByRole("region", { name: "Canais" })

    expect(within(channels).getByText("Nenhum canal ainda")).toBeVisible()
    expect(within(channels).getByText("Canais reúnem bots e pessoas em torno de um assunto.")).toBeVisible()
    fireEvent.click(within(channels).getByRole("button", { name: "Criar canal" }))
    expect(await screen.findByRole("dialog", { name: "Criar canal" })).toBeVisible()
  })

  it.each(["bots", "work"])("keeps %s rows compact through repeated pointer and keyboard selection", async (mode) => {
    const user = userEvent.setup()
    const { api } = await getRoutineSidebarFixture(30, { todayRuns: true })
    window.localStorage.setItem("touri.sidebar.mode", mode)
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    const panel = document.getElementById(`sidebar-mode-panel-${mode}`)
    if (!panel) throw new Error("Missing bot navigation")
    const markRow = panel.querySelector<HTMLButtonElement>('.bot-row-main:has([data-bot-id="bot-mark"])')
    const otherRow = panel.querySelector<HTMLButtonElement>('.bot-row-main:has([data-bot-id="bot-onb"])')
    if (!markRow || !otherRow) throw new Error("Missing bot rows")

    await user.click(otherRow)
    await screen.findByRole("textbox", { name: "Mensagem para onb" })
    await user.click(markRow)
    await user.click(markRow)
    markRow.focus()
    await user.keyboard("{Enter}")

    expect(panel.querySelectorAll(".bot-thread-tree, .thread-list-tools, .thread-row")).toHaveLength(0)
    expect(markRow).not.toHaveAttribute("aria-expanded")

    await user.keyboard(" ")

    expect(markRow).toHaveAttribute("aria-current", "page")
    expect(markRow).not.toHaveAttribute("aria-expanded")
    expect(markRow).not.toHaveAttribute("aria-haspopup")
    expect(markRow.querySelectorAll(".bot-preview:not(.visually-hidden)")).toHaveLength(1)
    expect(panel.querySelectorAll(".bot-thread-tree, .thread-list-tools, .thread-row")).toHaveLength(0)
    expect(screen.queryByRole("region", { name: "Conversas de mark" })).toBeNull()
    expect(screen.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    expect(api.calls.some((call) => call.route === "POST /threads" || call.route === "POST /threads/delete")).toBe(
      false,
    )
  })

  it("opens management explicitly with the keyboard and returns focus without changing conversation", async () => {
    const user = userEvent.setup()
    render(<App kernel={{ services: { api: createMockApi() } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    const actions = screen.getByRole("button", { name: "Ações de mark" })

    actions.focus()
    await user.keyboard("{ArrowDown}{End}{ArrowUp}{Enter}")

    const dialog = screen.getByRole("dialog", { name: "Conversas de mark" })
    expect(dialog).toHaveAttribute("aria-modal", "true")
    expect(within(dialog).getByRole("button", { name: "Selecionar", exact: true })).toBeVisible()
    expect(within(dialog).getByRole("button", { name: "Nova conversa", exact: true })).toBeVisible()
    expect(within(dialog).getByRole("button", { name: "Apagar conversas automáticas antigas…" })).toBeVisible()
    expect(within(dialog).getByRole("button", { name: /Arquivadas/ })).toBeVisible()
    expect(document.querySelector(".bot-row.selected .tb-avatar")).toHaveAttribute("data-bot-id", "bot-mark")
    expect(within(dialog).getByRole("button", { name: "Fechar diálogo" })).toHaveFocus()

    await user.keyboard("{Escape}")

    expect(screen.queryByRole("dialog", { name: "Conversas de mark" })).toBeNull()
    expect(actions).toHaveFocus()
    expect(actions).toHaveAttribute("aria-expanded", "false")
  })

  it("shows the working summary only when nothing needs the user", async () => {
    const api = createMockApi()
    window.localStorage.setItem("touri.sidebar.mode", "bots")
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })

    expect(document.querySelectorAll(".sidebar-needs-you, .sidebar-work-badge").length).toBeLessThan(2)
  })
})
