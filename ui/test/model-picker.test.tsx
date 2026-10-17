import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ApiRoutes, Bot } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import App from "../src/App"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { BotModelModal } from "../src/components/Modals"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const catalog = {
  models: ["openrouter/deepseek/deepseek-v3.2", "openrouter/deepseek/deepseek-r1"],
  defaultModel: "openrouter/deepseek/deepseek-v3.2",
  available: true,
}
const openPicker = async (
  provider: Bot["provider"],
  listModels = async (): Promise<ApiRoutes["GET /providers/opencode/models"]["res"]> => catalog,
  model: string | null = null,
) => {
  const mock = createMockApi()
  const bot = mock.getState().bots[0]
  if (!bot) throw new Error("Missing bot")
  Object.assign(bot, { provider, model })
  const list = vi.fn(async (_input: unknown) => listModels())
  const request: ApiRequest = async (route, input, path) =>
    route === "GET /providers/opencode/models" ? ((await list(input)) as never) : mock.request(route, input, path)
  const api = { ...mock, request }
  render(<App kernel={{ services: { api } }} />)
  fireEvent.click(await screen.findByRole("button", { name: "Painel do bot", exact: true }))
  fireEvent.click(await screen.findByRole("button", { name: /^Modelo:/ }))
  const dialog = await screen.findByRole("dialog", { name: "Escolher modelo" })
  expect(within(dialog).queryByRole("tab", { name: "Geral" })).not.toBeInTheDocument()
  return { api, bot, dialog, list }
}

it("opens the provider model list from the bot panel, saves a choice and can restore the default", async () => {
  const { api, bot, dialog, list } = await openPicker("opencode")
  await within(dialog).findByRole("option", { name: "openrouter/deepseek/deepseek-r1" })
  const models = within(dialog).getByRole("combobox", { name: "Modelo" })
  expect(within(models).getAllByRole("option")).toHaveLength(3)
  expect(list).toHaveBeenCalledExactlyOnceWith({ botId: bot.id })
  expect(within(models).getByRole("option", { name: "openrouter/deepseek/deepseek-r1" })).toBeVisible()
  fireEvent.change(models, { target: { value: "openrouter/deepseek/deepseek-r1" } })
  fireEvent.click(within(dialog).getByRole("button", { name: "Salvar modelo" }))
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Escolher modelo" })).toBeNull())
  expect(api.calls).toContainEqual({
    route: "PATCH /bots/:id",
    input: { model: "openrouter/deepseek/deepseek-r1" },
    pathValues: { id: bot.id },
  })
  const chip = screen.getByRole("button", { name: "Modelo: OpenCode · openrouter/deepseek/deepseek-r1" })
  fireEvent.click(chip)
  const reopened = await screen.findByRole("dialog", { name: "Escolher modelo" })
  await within(reopened).findByRole("option", { name: "openrouter/deepseek/deepseek-r1" })
  const selected = within(reopened).getByRole("combobox", { name: "Modelo" })
  expect(selected).toHaveValue("openrouter/deepseek/deepseek-r1")
  fireEvent.change(selected, { target: { value: "" } })
  fireEvent.click(within(reopened).getByRole("button", { name: "Salvar modelo" }))
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Escolher modelo" })).toBeNull())
  expect(bot.model).toBeNull()
  expect(screen.getByRole("button", { name: "Modelo: OpenCode · Padrão do provedor" })).toBeVisible()
})

it.each([
  { provider: "codex" as const, name: "Codex" },
  { provider: "claude" as const, name: "Claude Code" },
])("explains the missing $name catalog and saves a manual model ID", async ({ provider, name }) => {
  const { bot, dialog, list } = await openPicker(provider)
  expect(within(dialog).getByText(new RegExp(`O ${name} não disponibiliza uma lista de modelos`))).toBeVisible()
  const field = within(dialog).getByRole("textbox", { name: "Modelo" })
  expect(field).toHaveAccessibleDescription(/Use o padrão do provedor ou informe um identificador/)
  expect(list).not.toHaveBeenCalled()
  fireEvent.change(field, { target: { value: " custom-model " } })
  fireEvent.click(within(dialog).getByRole("button", { name: "Salvar modelo" }))
  await waitFor(() => expect(bot.model).toBe("custom-model"))
  expect(await screen.findByRole("button", { name: `Modelo: ${name} · custom-model` })).toBeVisible()
})

it.each([
  { state: "empty", message: "não retornou modelos", result: { models: [], defaultModel: null, available: true } },
  {
    state: "unavailable",
    message: "OpenCode indisponível",
    result: { models: [], defaultModel: null, available: false },
  },
  { state: "failed", message: "Não foi possível listar", result: null },
])("explains an $state OpenCode catalog and lets the user keep the default", async ({ result, message }) => {
  const { bot, dialog } = await openPicker("opencode", async () => {
    if (!result) throw new Error("offline")
    return result
  })
  await waitFor(() => expect(within(dialog).getByRole("status")).toHaveTextContent(message))
  expect(within(dialog).getByLabelText("Modelo")).toHaveValue("")
  fireEvent.click(within(dialog).getByRole("button", { name: "Salvar modelo" }))
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Escolher modelo" })).toBeNull())
  expect(bot.model).toBeNull()
})

it("preserves a configured model missing from the list and does not save on cancel", async () => {
  const { api, dialog } = await openPicker("opencode", async () => catalog, "custom/model")
  await waitFor(() => expect(within(dialog).getByRole("option", { name: "custom/model" })).toBeInTheDocument())
  expect(within(dialog).getByLabelText("Modelo")).toHaveValue("custom/model")
  fireEvent.change(within(dialog).getByLabelText("Modelo"), { target: { value: catalog.models[0] } })
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }))
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Escolher modelo" })).toBeNull())
  expect(api.calls.filter((call) => call.route === "PATCH /bots/:id")).toHaveLength(0)
})

it("keeps the selected model after a save failure so the user can retry", async () => {
  const api = createMockApi()
  const bot = api.getState().bots[0]
  if (!bot) throw new Error("Missing bot")
  const save = vi.fn().mockRejectedValueOnce(new Error("Falha ao salvar modelo")).mockResolvedValueOnce(undefined)
  const close = vi.fn()
  render(<BotModelModal api={api} bot={bot} onSave={save} onClose={close} />)
  fireEvent.change(screen.getByLabelText("Modelo"), { target: { value: "custom-model" } })
  fireEvent.click(screen.getByRole("button", { name: "Salvar modelo" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("Falha ao salvar modelo")
  expect(close).not.toHaveBeenCalled()
  expect(screen.getByLabelText("Modelo")).toHaveValue("custom-model")
  fireEvent.click(screen.getByRole("button", { name: "Salvar modelo" }))
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(save).toHaveBeenLastCalledWith("custom-model")
})
