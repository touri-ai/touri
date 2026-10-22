import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import { t } from "../src/i18n"
import { getSidebarRowTime } from "../src/sidebarAttention"
import { chooseBotAction } from "./workspaceNavigation"

afterEach(() => {
  cleanup()
  localStorage.removeItem("touri.sidebar.mode")
})

const getSidebar = () => screen.getByRole("navigation", { name: "Barra lateral" })

const getBotRow = (botId: string): HTMLButtonElement => {
  const row = document.querySelector<HTMLButtonElement>(`[data-bot-entry="${botId}"] .bot-row-main`)
  if (!row) throw new Error(`Missing bot row ${botId}`)

  return row
}

it("opens a bot's latest conversation from its row without an inline panel of controls", async () => {
  const api = createMockApi()
  await api.request("POST /threads", { botId: "bot-onb", title: "Planejamento" })
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })

  fireEvent.click(getBotRow("bot-onb"))
  await screen.findByRole("textbox", { name: "Mensagem para onb" })

  const sidebar = getSidebar()
  expect(sidebar.querySelector(".bot-thread-tree")).toBeNull()
  for (const name of [/^Selecionar$/, /^Nova conversa$/, /^Arquivadas/, /^Apagar conversas automáticas antigas/])
    expect(within(sidebar).queryByRole("button", { name })).toBeNull()
  expect(getBotRow("bot-onb")).not.toHaveAttribute("aria-expanded")
  expect(within(sidebar).getByRole("button", { name: "Conversas de onb" })).toHaveAttribute("aria-expanded", "false")
})

it("gives each bot row a name, a last-activity time and one preview line", async () => {
  render(<App kernel={{ services: { api: createMockApi() } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })

  const row = getBotRow("bot-mark")

  expect(row.querySelector(".bot-row-top strong")).toHaveTextContent("mark")
  expect(row.querySelector(".bot-row-time")?.textContent).toMatch(/^\d{2}:\d{2}$|ontem|\d+ de /)
  expect(row.querySelectorAll(".bot-preview:not(.visually-hidden)")).toHaveLength(1)
})

it("keeps conversation housekeeping in the bot menu", async () => {
  render(<App kernel={{ services: { api: createMockApi() } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })

  fireEvent.click(screen.getByRole("button", { name: "Ações de mark" }))
  const menu = screen.getByRole("menu", { name: "Ações de mark" })

  expect(
    within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent),
  ).toEqual([
    "Nova conversa",
    "Selecionar conversas…",
    "Apagar conversas automáticas antigas…",
    "Arquivadas",
    "Avançado",
    "Rotinas",
    "Conversas",
    "Excluir bot",
  ])
})

it("starts a new conversation for the bot whose menu was used, even when another bot is open", async () => {
  const api = createMockApi()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })

  chooseBotAction("Nova conversa", "onb")

  await screen.findByRole("textbox", { name: "Mensagem para onb" })
  await waitFor(() =>
    expect(api.calls.filter((call) => call.route === "POST /threads").map((call) => call.input)).toEqual([
      { botId: "bot-onb", title: "Nova conversa" },
    ]),
  )
})

it("opens selection and archived conversations from the bot menu", async () => {
  render(<App kernel={{ services: { api: createMockApi() } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })

  chooseBotAction("Selecionar conversas…")
  const conversations = screen.getByRole("region", { name: "Conversas de mark" })
  expect(within(conversations).getByRole("button", { name: "Sair da seleção" })).toBeVisible()
  fireEvent.click(within(conversations).getByRole("button", { name: "Sair da seleção" }))
  fireEvent.click(
    within(screen.getByRole("dialog", { name: "Conversas de mark" })).getByRole("button", { name: "Fechar diálogo" }),
  )

  chooseBotAction("Arquivadas")
  const archive = screen.getByRole("region", { name: "Conversas de mark" })
  expect(within(archive).getByRole("button", { name: /^Arquivadas/ })).toHaveAttribute("aria-expanded", "true")
  expect(await within(archive).findByText("Não há conversas arquivadas.")).toBeVisible()
})

it("keeps the Work sidebar footer to the person and Advanced, with invite beside the channels", async () => {
  localStorage.setItem("touri.sidebar.mode", "work")
  render(<App kernel={{ services: { api: createMockApi() } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })

  const sidebar = getSidebar()
  const footer = sidebar.querySelector<HTMLElement>(".sidebar-footer")
  if (!footer) throw new Error("Missing sidebar footer")

  expect(within(sidebar).queryByRole("button", { name: "Buscar conversas", exact: true })).toBeNull()
  expect(within(sidebar).getByRole("button", { name: "Buscar canais e mensagens" })).toBeVisible()
  expect(sidebar.querySelector(".sidebar-invite")).toBeNull()
  expect(within(footer).queryByRole("button", { name: /Convidar/ })).toBeNull()
  expect(within(footer).queryByRole("button", { name: /Tarefas interrompidas/ })).toBeNull()
  const invite = within(screen.getByRole("region", { name: "Canais" })).queryByRole("button", {
    name: "Convidar pessoa",
  })
  if (invite) expect(invite).toHaveTextContent("+ Convidar")
})

it("shows the clock for today and a short date otherwise", () => {
  const now = new Date(2026, 9, 22, 18, 30).getTime()

  expect(getSidebarRowTime(new Date(2026, 9, 22, 9, 5).getTime(), now)).toBe("09:05")
  expect(getSidebarRowTime(new Date(2026, 9, 21, 9, 5).getTime(), now)).toBe("ontem")
  expect(getSidebarRowTime(new Date(2026, 9, 2, 9, 5).getTime(), now)).toBe("2 de out.")
  expect(getSidebarRowTime(0, now)).toBe("")
})

it("labels the new controls in both languages", () => {
  expect(t("Select conversations…", {}, "en")).toBe("Select conversations…")
  expect(t("See all conversations", {}, "en")).toBe("See all")
  expect(t("See all conversations count", { count: 7 }, "en")).toBe("See all 7 conversations")
  expect(t("Interrupted tasks count", { count: 2 }, "en")).toBe("Interrupted tasks: 2")
  expect(t("Invite short", {}, "en")).toBe("Invite")
  expect(t("Team actions", {}, "en")).toBe("Team actions")
  expect(t("Select conversations…", {}, "pt-BR")).toBe("Selecionar conversas…")
  expect(t("See all conversations", {}, "pt-BR")).toBe("Ver todas")
})
