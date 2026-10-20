import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ApiRoutes, Bot } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import App from "../src/App"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const catalog = {
  models: ["openrouter/deepseek/deepseek-v3.2", "openrouter/deepseek/deepseek-r1"],
  defaultModel: "openrouter/deepseek/deepseek-v3.2",
  available: true,
}

const openComposerPicker = async (
  provider: Bot["provider"],
  listModels = async (): Promise<ApiRoutes["GET /providers/opencode/models"]["res"]> => catalog,
  model: string | null = null,
  requestPatch?: ApiRequest,
  listApiModels = async (): Promise<ApiRoutes["GET /api-models"]["res"]> => ({ models: [] }),
) => {
  const mock = createMockApi()
  const bot = mock.getState().bots[0]
  if (!bot) throw new Error("Missing bot")
  Object.assign(bot, { provider, model })
  const list = vi.fn(async (_input: unknown) => listModels())
  const apiModels = vi.fn(async () => listApiModels())
  const request: ApiRequest = async (route, input, path) => {
    if (route === "GET /providers/opencode/models") return (await list(input)) as never
    if (route === "GET /api-models") return (await apiModels()) as never
    if (requestPatch && route === "PATCH /bots/:id") return requestPatch(route, input, path)
    return mock.request(route, input, path)
  }
  const api = { ...mock, request }
  render(<App kernel={{ services: { api } }} />)
  const chip = await screen.findByRole("button", { name: /^Escolher modelo:/ })
  fireEvent.click(chip)
  const listbox = await screen.findByRole("listbox", {
    name: `Modelos de ${provider === "claude" ? "Claude Code" : provider === "opencode" ? "OpenCode" : "Codex"}`,
  })
  return { api, bot, chip, listbox, list, apiModels }
}

it("opens the composer list, marks the current model and saves a picked model immediately", async () => {
  const { api, bot, chip, listbox } = await openComposerPicker("codex", undefined, "gpt-6.1-sol")

  expect(within(listbox).getByRole("option", { name: "gpt-6.1-sol" })).toHaveAttribute("aria-selected", "true")
  expect(within(listbox).getByRole("option", { name: "gpt-6-luna" })).toBeVisible()
  fireEvent.click(within(listbox).getByRole("option", { name: "gpt-6-luna" }))

  await waitFor(() => expect(bot.model).toBe("gpt-6-luna"))
  expect(api.calls).toContainEqual({
    route: "PATCH /bots/:id",
    input: { model: "gpt-6-luna" },
    pathValues: { id: bot.id },
  })
  expect(await screen.findByRole("button", { name: "Escolher modelo: Codex · gpt-6-luna" })).toBeVisible()
  expect(chip).toHaveAccessibleName("Escolher modelo: Codex · gpt-6-luna")
})

it("opens the same list from the bot settings model field and saves immediately", async () => {
  const mock = createMockApi()
  const bot = mock.getState().bots[0]
  if (!bot) throw new Error("Missing bot")
  Object.assign(bot, { provider: "codex", model: null })
  render(<App kernel={{ services: { api: mock } }} />)
  fireEvent.click(await screen.findByRole("button", { name: "Painel do bot", exact: true }))
  fireEvent.click(screen.getByRole("button", { name: /^Modelo:/ }))

  const dialog = await screen.findByRole("dialog", { name: `Configurações de ${bot.name}` })
  const modelField = dialog.querySelector<HTMLButtonElement>("#settings-model")
  if (!modelField) throw new Error("Missing settings model field")
  expect(modelField).toHaveAccessibleDescription("Deixe em branco para usar o padrão do provedor.")
  fireEvent.click(modelField)
  const listbox = await within(dialog).findByRole("listbox", { name: "Modelos de Codex" })
  fireEvent.keyDown(within(listbox).getByRole("option", { name: "gpt-6-luna" }), { key: "Escape" })
  expect(within(dialog).getByRole("button", { name: "Fechar diálogo" })).toBeVisible()
  expect(within(dialog).queryByRole("listbox")).toBeNull()
  fireEvent.click(modelField)
  const reopenedListbox = await within(dialog).findByRole("listbox", { name: "Modelos de Codex" })
  fireEvent.click(within(reopenedListbox).getByRole("option", { name: "gpt-6-luna" }))

  await waitFor(() => expect(bot.model).toBe("gpt-6-luna"))
  expect(mock.calls).toContainEqual({
    route: "PATCH /bots/:id",
    input: { model: "gpt-6-luna" },
    pathValues: { id: bot.id },
  })
  expect(dialog).toBeVisible()
})

it("shows discovered OpenCode and saved API models and saves the selected model immediately", async () => {
  const { api, bot, listbox, list, apiModels } = await openComposerPicker(
    "opencode",
    undefined,
    null,
    undefined,
    async () => ({
      models: [
        {
          id: "saved-model",
          preset: "openrouter",
          name: "Planejamento",
          baseUrl: "https://openrouter.ai/api/v1",
          modelId: "deepseek-chat",
        },
      ],
    }),
  )

  await within(listbox).findByRole("option", { name: "openrouter/deepseek/deepseek-r1" })
  expect(list).toHaveBeenCalledExactlyOnceWith({ botId: bot.id })
  expect(apiModels).toHaveBeenCalledExactlyOnceWith()
  expect(within(listbox).getByRole("option", { name: "Planejamento · deepseek-chat" })).toBeVisible()
  fireEvent.click(within(listbox).getByRole("option", { name: "Planejamento · deepseek-chat" }))

  await waitFor(() => expect(bot.model).toBe("touri-api-saved-model/deepseek-chat"))
  expect(api.calls).toContainEqual({
    route: "PATCH /bots/:id",
    input: { model: "touri-api-saved-model/deepseek-chat" },
    pathValues: { id: bot.id },
  })
})

it("saves a trimmed custom model from the inline field", async () => {
  const { api, bot, listbox } = await openComposerPicker("codex")

  fireEvent.click(within(listbox).getByRole("option", { name: "Outro modelo…" }))
  const input = screen.getByRole("textbox", { name: "Nome do modelo" })
  fireEvent.change(input, { target: { value: " custom-model " } })
  fireEvent.keyDown(input, { key: "Enter" })

  await waitFor(() => expect(bot.model).toBe("custom-model"))
  expect(api.calls).toContainEqual({
    route: "PATCH /bots/:id",
    input: { model: "custom-model" },
    pathValues: { id: bot.id },
  })
})

it("rejects hidden characters in a custom model name", async () => {
  const { api, listbox } = await openComposerPicker("codex")

  fireEvent.click(within(listbox).getByRole("option", { name: "Outro modelo…" }))
  const input = screen.getByRole("textbox", { name: "Nome do modelo" })
  fireEvent.change(input, { target: { value: "model\u200bname" } })
  fireEvent.keyDown(input, { key: "Enter" })

  expect(await screen.findByRole("alert")).toHaveTextContent("caracteres invisíveis ou de controle")
  expect(api.calls.filter((call) => call.route === "PATCH /bots/:id")).toHaveLength(0)
})

it("supports arrow navigation, Enter to choose and Escape to close", async () => {
  const { bot, chip, listbox } = await openComposerPicker("codex")
  const defaultModel = within(listbox).getByRole("option", { name: "Padrão do provedor" })
  defaultModel.focus()
  fireEvent.keyDown(defaultModel, { key: "ArrowDown" })
  fireEvent.keyDown(screen.getByRole("option", { name: "gpt-6.1-sol" }), { key: "ArrowDown" })
  const nextModel = screen.getByRole("option", { name: "gpt-6-luna" })
  expect(nextModel).toHaveFocus()
  fireEvent.keyDown(nextModel, { key: "Enter" })

  await waitFor(() => expect(bot.model).toBe("gpt-6-luna"))
  fireEvent.click(await screen.findByRole("button", { name: "Escolher modelo: Codex · gpt-6-luna" }))
  const reopened = await screen.findByRole("listbox", { name: "Modelos de Codex" })
  fireEvent.keyDown(within(reopened).getByRole("option", { name: "gpt-6-luna" }), { key: "Escape" })

  expect(screen.queryByRole("listbox")).toBeNull()
  expect(screen.getByRole("button", { name: "Escolher modelo: Codex · gpt-6-luna" })).toHaveFocus()
  expect(chip).toHaveAccessibleName("Escolher modelo: Codex · gpt-6-luna")
})

it("virtualizes long catalogs while keeping keyboard access to the final model", async () => {
  const models = Array.from({ length: 80 }, (_, index) => `provider/model-${index}`)
  const { bot, listbox } = await openComposerPicker("opencode", async () => ({
    models,
    defaultModel: null,
    available: true,
  }))
  const defaultModel = await within(listbox).findByRole("option", { name: "Padrão do provedor" })

  await waitFor(() => expect(defaultModel).toHaveAttribute("aria-setsize", "82"))
  expect(within(listbox).getAllByRole("option")).toHaveLength(20)
  fireEvent.keyDown(defaultModel, { key: "End" })
  const otherModel = within(listbox).getByRole("option", { name: "Outro modelo…" })
  await waitFor(() => expect(otherModel).toHaveFocus())
  fireEvent.keyDown(otherModel, { key: "ArrowUp" })
  const lastModel = within(listbox).getByRole("option", { name: "provider/model-79" })
  await waitFor(() => expect(lastModel).toHaveFocus())
  fireEvent.keyDown(lastModel, { key: "Enter" })

  await waitFor(() => expect(bot.model).toBe("provider/model-79"))
})

it("rolls back an optimistic selection and shows a toast when saving fails", async () => {
  const mock = createMockApi()
  const bot = mock.getState().bots[0]
  if (!bot) throw new Error("Missing bot")
  Object.assign(bot, { provider: "codex", model: "gpt-6.1-sol" })
  let rejectSave: (error: Error) => void = () => {}
  const request: ApiRequest = async (route, input, path) => {
    if (route === "PATCH /bots/:id")
      return new Promise((_, reject) => {
        rejectSave = reject
      })
    return mock.request(route, input, path)
  }
  const api = { ...mock, request }
  render(<App kernel={{ services: { api } }} />)
  fireEvent.click(await screen.findByRole("button", { name: "Escolher modelo: Codex · gpt-6.1-sol" }))
  const listbox = await screen.findByRole("listbox", { name: "Modelos de Codex" })
  fireEvent.click(within(listbox).getByRole("option", { name: "gpt-6-luna" }))

  expect(screen.getByRole("button", { name: "Escolher modelo: Codex · gpt-6-luna" })).toBeVisible()
  rejectSave(new Error("Falha ao salvar modelo"))
  const errorMessage = await screen.findByText("Não foi possível concluir esta ação. Confira os detalhes do erro.")
  expect(errorMessage.closest(".notice-bar")).toHaveAttribute("role", "status")
  expect(errorMessage.closest(".notice-bar")).toBeVisible()
  await waitFor(() => expect(bot.model).toBe("gpt-6.1-sol"))
  expect(screen.getByRole("button", { name: "Escolher modelo: Codex · gpt-6.1-sol" })).toBeVisible()
})

it("uses the Claude Code aliases in the same compact list", async () => {
  const { bot, listbox, list } = await openComposerPicker("claude")

  expect(within(listbox).getByRole("option", { name: "Opus" })).toBeVisible()
  expect(within(listbox).getByRole("option", { name: "Sonnet" })).toBeVisible()
  expect(within(listbox).getByRole("option", { name: "Haiku" })).toBeVisible()
  expect(list).not.toHaveBeenCalled()
  fireEvent.click(within(listbox).getByRole("option", { name: "Sonnet" }))

  await waitFor(() => expect(bot.model).toBe("sonnet"))
})
