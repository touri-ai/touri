import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import { getRoutineSidebarFixture } from "./routine-sidebar-fixture"

const clearSidebarMode = (): void => window.localStorage.removeItem("touri.sidebar.mode")

beforeEach(clearSidebarMode)
afterEach(cleanup)

describe("sidebar work mode", () => {
  it("shows groups as channels only in Work mode", async () => {
    const api = createMockApi()
    await api.request("POST /groups", {
      name: "Equipe QA",
      color: "#dc2626",
      avatarShape: "classic-none",
      memberIds: ["bot-mark", "bot-onb"],
      coordinatorBotId: "bot-mark",
    })

    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    fireEvent.click(screen.getByRole("tab", { name: /^Work,/ }))

    const channels = screen.getByRole("region", { name: "Canais" })
    expect(within(channels).getByRole("button", { name: "Equipe QA" })).toBeVisible()
    expect(within(channels).getByRole("button", { name: "Novo canal" })).toBeVisible()
    expect(screen.getByRole("heading", { name: "Mensagens diretas" })).toBeVisible()

    fireEvent.click(screen.getByRole("tab", { name: /^Bots,/ }))

    expect(screen.queryByRole("region", { name: "Canais" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Equipe QA", exact: true })).toBeNull()
    expect(document.querySelector('[data-bot-entry="bot-mark"]')).toBeVisible()
    expect(screen.getByRole("tab", { name: /^Bots,/ })).toHaveAttribute("aria-selected", "true")
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

    const conversations = screen.getByRole("region", { name: "Conversas de mark" })
    const routineRow = within(conversations).getByRole("button", {
      name: "Abrir histórico da rotina Resumo diário",
    })
    expect(routineRow).toHaveTextContent("Rotina Resumo diário · 30 hoje")
    expect(conversations.querySelectorAll(".thread-row")).toHaveLength(2)

    fireEvent.click(routineRow)
    await screen.findByRole("heading", { name: "Rotinas", exact: true })
    const history = document.querySelector(".routine-run-history")
    if (!(history instanceof HTMLElement)) throw new Error("Missing routine history")

    expect(history).toHaveAttribute("open")
    expect(within(history).getByRole("combobox", { name: "Filtrar histórico por rotina" })).toHaveValue(routine.id)
    expect(within(history).getAllByRole("button", { name: "Abrir conversa" })).toHaveLength(30)
  })
})
