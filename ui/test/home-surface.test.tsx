import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import App from "../src/App"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { dictionaries, getHostLabel, t } from "../src/i18n"
import { openRoutines, showBotSettings } from "./workspaceNavigation"

afterEach(cleanup)

it("keeps Home, create, chat and collapsed advanced settings free of technical jargon", async () => {
  const api = createMockApi()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  const expectPlainSurface = () => {
    const jargon =
      /SOUL\.md|workspace-write|TOURI-E\d{4}|\b(?:MCP|sandbox|gateway|stdio|MiB|Xvfb|noVNC|VACUUM|WAL|sidecar|Keychain|egress|harness|seq|generation)\b/i
    for (const element of screen.queryAllByText(jargon)) expect(element).not.toBeVisible()
  }
  expectPlainSurface()
  fireEvent.click(screen.getByRole("button", { name: "Criar bot" }))
  await screen.findByText(/Usa o Codex/)
  expectPlainSurface()
  fireEvent.click(screen.getByRole("button", { name: "Fechar diálogo" }))
  const input = screen.getByRole("textbox", { name: "Mensagem para mark" })
  fireEvent.change(input, { target: { value: "Organize as tarefas de hoje." } })
  await waitFor(() => expect(screen.getByRole("button", { name: "Enviar" })).toBeEnabled())
  fireEvent.click(screen.getByRole("button", { name: "Enviar" }))
  await waitFor(() => expect(input).toHaveValue(""))
  expectPlainSurface()
  showBotSettings()
  expect(screen.getByRole("dialog").querySelector(".bot-settings-overview")).toBeVisible()
  expectPlainSurface()
  fireEvent.click(screen.getByRole("button", { name: "Fechar diálogo" }))
  fireEvent.click(screen.getByRole("button", { name: /Você Local/ }))
  const settings = screen.getByRole("dialog")
  for (const section of ["Aparência", "Privacidade", "Atualizações", "Notificações", "Diagnóstico"]) {
    fireEvent.click(within(settings).getByRole("tab", { name: section }))
    expectPlainSurface()
  }
})

it("limits primary navigation to the bot list and Advanced, with chat and composer at rest", async () => {
  render(<App kernel={{ services: { api: createMockApi() } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  const sidebar = screen.getByRole("navigation", { name: "Barra lateral" })
  const primary = sidebar.querySelectorAll(".sidebar-list-heading button, .sidebar-advanced > button")
  expect(Array.from(primary, (button) => button.textContent?.replace(/\d|⚙|›/g, "").trim())).toEqual([
    "Bots",
    "Avançado",
  ])
  expect(within(sidebar).queryAllByRole("tab")).toHaveLength(0)
  expect(document.querySelector(".bot-panel")).toBeNull()
  for (const name of ["Cron", "MCP", "Integrações", "Projetos", "Importar", "Verificar este servidor", "Rotinas"])
    expect(within(sidebar).queryByRole("button", { name, exact: true })).toBeNull()
  expect(sidebar.querySelectorAll("[data-bot-entry]")).toHaveLength(3)
  const advanced = within(sidebar).getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ })
  fireEvent.click(advanced)
  expect(
    within(screen.getByRole("navigation", { name: "Opções avançadas" }))
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual([
    "Trabalho",
    "Desempenho",
    "MCP",
    "Integrações",
    "Projetos",
    "Verificar este Mac",
    "Importar",
    "Reportar problema",
  ])
  fireEvent.keyDown(window, { key: "Escape" })
  expect(advanced).toHaveFocus()
  expect(screen.queryByRole("navigation", { name: "Opções avançadas" })).toBeNull()
})

it("shows one primary hire action and quiet secondary actions, even when checks fail", async () => {
  const api = createMockApi()
  api.getState().bots.splice(0)
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("button", { name: "Criar meu primeiro bot" })
  const landing = screen.getByRole("main")
  expect(within(landing).getByRole("heading", { name: "touri" })).toBeVisible()
  expect(landing.querySelectorAll(".button-brand")).toHaveLength(1)
  expect(
    within(landing)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["Criar meu primeiro bot→", "Importar", "Verificar este servidor"])
  expect(landing).toHaveTextContent(
    "O histórico fica neste servidor. Sua IA recebe o conteúdo necessário para responder. O touri não coleta telemetria.",
  )
  expect(landing).toHaveTextContent("Já usa outra ferramenta?")
  expect(landing).not.toHaveTextContent(/Prontas|Avisos|Falhas|\d/)
  expect(dictionaries.en["Create my first bot"]).toBe("Create my first bot")
  const privacy = t("onboarding.privacy", { host: getHostLabel("server", "en") }, "en")

  expect(privacy).toBe(
    "History stays on this server. Your AI receives the content needed to respond. touri collects no telemetry.",
  )
})

it("opens the full routines screen from the bot's Advanced settings", async () => {
  render(<App kernel={{ services: { api: createMockApi() } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  showBotSettings()
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("tab", { name: "Rotinas" }))
  expect(await screen.findByRole("heading", { name: "Rotinas" })).toBeVisible()
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  expect(
    within(screen.getByRole("group", { name: "Filtros de rotinas" })).getByRole("button", {
      name: "mark",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true")
})

it("returns focus to the bot actions button when Advanced closes", async () => {
  render(<App kernel={{ services: { api: createMockApi() } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  showBotSettings()
  await screen.findByRole("dialog", { name: "Configurações de mark" })
  fireEvent.click(screen.getByRole("button", { name: "Fechar diálogo" }))
  await waitFor(() => expect(screen.getByRole("button", { name: "Ações de mark" })).toHaveFocus())
})

it("keeps project processes available after opening the active bot's routines", async () => {
  render(<App kernel={{ services: { api: createMockApi() } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  openRoutines()
  fireEvent.click(screen.getByRole("button", { name: /^Bots/ }))
  expect(screen.queryByRole("complementary", { name: "Painel de mark" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Preview do projeto" })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Painel do bot" }))
  const panel = screen.getByRole("complementary", { name: "Painel de mark" })
  fireEvent.click(within(panel).getByRole("button", { name: "Preview do projeto" }))
  await waitFor(() => expect(screen.getByRole("button", { name: "Subir tudo" })).toBeEnabled())
  expect(document.querySelectorAll(".preview-process-entry")).toHaveLength(2)
})

it("names the server diagnostics consistently after onboarding and opens it", async () => {
  const api = createMockApi()
  const request = api.request
  api.request = (async (route, input, path) =>
    route === "GET /routines"
      ? { ...(await request(route, input, path)), host: "server" }
      : request(route, input, path)) as ApiRequest
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  const menu = screen.getByRole("navigation", { name: "Opções avançadas" })
  const action = within(menu).getByRole("button", { name: "Verificar este servidor", exact: true })
  expect(within(menu).queryByRole("button", { name: "Verificar este Mac" })).toBeNull()
  fireEvent.click(action)
  expect(await screen.findByRole("dialog", { name: "Diagnóstico" })).toBeVisible()
})
