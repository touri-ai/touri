import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { Bot, Message } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import { t } from "../src/i18n"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const setup = async (patch: Partial<Message> = {}, followingUser = false, botPatch: Partial<Bot> = {}) => {
  const api = createMockApi()
  const state = api.getState()
  const bot = state.bots[0]
  const thread = state.threads.find((thread) => thread.botId === bot?.id)
  const base = state.messages[0]
  if (!bot || !thread || !base) throw new Error("Missing data connection fixture")
  bot.name = "Dados"
  bot.projectId = null
  bot.mcpServers = []
  Object.assign(bot, botPatch)
  const reply: Message = {
    ...base,
    id: "missing-data-reply",
    threadId: thread.id,
    parentId: null,
    role: "assistant",
    status: "complete",
    runId: null,
    text: "Preciso dos dados. Anexe um CSV, permita uma pasta ou escolha uma ferramenta do catálogo.\n\n<!-- touri:connect-data -->",
    parts: [],
    ...patch,
  }
  state.messages.splice(0, state.messages.length, reply)
  thread.activeLeafId = reply.id
  if (followingUser) {
    state.messages.push({ ...reply, id: "next-request", parentId: reply.id, role: "user", text: "Outra tarefa" })
    thread.activeLeafId = "next-request"
  }
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para Dados" })
  await waitFor(() => expect(document.querySelector('[data-message-id="missing-data-reply"]')).toBeInTheDocument())
  return { api }
}

it("offers an inline data card and opens the existing CSV attachment chooser", async () => {
  await setup()
  const card = screen.getByRole("region", { name: "Conectar dados" })
  expect(within(card).getByRole("button", { name: "Dar acesso a uma pasta" })).toBeVisible()
  expect(within(card).getByRole("button", { name: "Adicionar ferramenta do catálogo" })).toBeVisible()
  const input = screen.getByLabelText("Anexar arquivos")
  expect(input).toHaveAttribute("accept", expect.stringContaining(".csv"))
  const choose = vi.spyOn(input as HTMLInputElement, "click")
  fireEvent.click(within(card).getByRole("button", { name: "Anexar arquivo/CSV" }))
  expect(choose).toHaveBeenCalledOnce()
  expect(document.body).not.toHaveTextContent("<!-- touri:connect-data -->")
})

it("opens the existing folder permission flow without granting access", async () => {
  const { api } = await setup()
  fireEvent.click(screen.getByRole("button", { name: "Dar acesso a uma pasta" }))
  const dialog = await screen.findByRole("dialog", { name: "Permissões do bot" })
  expect(within(dialog).getByText("Pastas que este bot pode acessar")).toBeVisible()
  expect(within(dialog).getByRole("button", { name: "Adicionar pasta…" })).toBeVisible()
  expect(api.calls.filter((call) => call.route === "PATCH /bots/:id")).toEqual([])
})

it("opens the existing tool catalog without connecting a server", async () => {
  const { api } = await setup()
  fireEvent.click(screen.getByRole("button", { name: "Adicionar ferramenta do catálogo" }))
  const catalog = await screen.findByRole("region", { name: "Catálogo de integrações MCP" })
  expect(within(catalog).getAllByRole("button", { name: "Conectar", exact: true })).toHaveLength(2)
  expect(screen.queryByLabelText("Transporte MCP")).not.toBeInTheDocument()
  expect(screen.queryByLabelText("Argumentos MCP (lista JSON)")).not.toBeInTheDocument()
  expect(api.calls.filter((call) => call.route === "PUT /bots/:id/mcp/:name")).toEqual([])
})

it("also offers data connections when a project is linked but the requested source is missing", async () => {
  await setup({}, false, { projectId: "project-fixture" })
  expect(screen.getByRole("region", { name: "Conectar dados" })).toBeVisible()
})

it("offers supported connections on cloud bots without offering host folder access", async () => {
  await setup({}, false, { machine: "cloud" })
  const card = screen.getByRole("region", { name: "Conectar dados" })
  expect(within(card).getByRole("button", { name: "Anexar arquivo/CSV" })).toBeVisible()
  expect(within(card).getByRole("button", { name: "Adicionar ferramenta do catálogo" })).toBeVisible()
  expect(within(card).queryByRole("button", { name: "Dar acesso a uma pasta" })).not.toBeInTheDocument()
  const choose = vi.spyOn(screen.getByLabelText("Anexar arquivos") as HTMLInputElement, "click")
  expect(screen.getByRole("button", { name: "Anexar arquivo", exact: true })).toBeDisabled()
  fireEvent.click(within(card).getByRole("button", { name: "Anexar arquivo/CSV" }))
  expect(choose).not.toHaveBeenCalled()
})

it("localizes the data choices in English", () => {
  expect(t("Conectar dados", {}, "en")).toBe("Connect data")
  expect(t("Anexar arquivo/CSV", {}, "en")).toBe("Attach a file/CSV")
  expect(t("Dar acesso a uma pasta", {}, "en")).toBe("Grant folder access")
  expect(t("Adicionar ferramenta do catálogo", {}, "en")).toBe("Add a tool from the catalog")
})

it.each([
  [{ status: "streaming" }, false],
  [{ status: "failed" }, false],
  [{ text: "Não tenho esses dados." }, false],
  [{ role: "user" }, false],
  [{}, true],
] as const)("does not offer a stale or unrequested connection: %o, following user %s", async (patch, followingUser) => {
  await setup(patch, followingUser)
  expect(screen.queryByRole("region", { name: "Conectar dados" })).not.toBeInTheDocument()
})
