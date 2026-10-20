import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { apiModelErrors, getApiModelReference } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import App from "../src/App"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { ApiModelPicker } from "../src/components/ApiModelPicker"
import { ApiModelsSettings } from "../src/components/ApiModelsSettings"
import { BotCreateModal, BotSettingsModal } from "../src/components/Modals"
import { SettingsModal } from "../src/components/SettingsModal"
import { errorRecovery } from "../src/errorRecovery"
import { ApiError } from "../src/errors"
import { t } from "../src/i18n"
import type { WorkspaceActions } from "../src/useWorkspace"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const fill = () => {
  fireEvent.change(screen.getByLabelText("Provedor da API"), { target: { value: "deepseek" } })
  fireEvent.change(screen.getByLabelText("Chave de API"), { target: { value: "fixture-private-key" } })
  fireEvent.change(screen.getByLabelText("Identificador do modelo"), { target: { value: "demo-model" } })
}
const addModel = async (api: ReturnType<typeof createMockApi>) =>
  (
    await api.request("POST /api-models", {
      preset: "deepseek",
      apiKey: "fixture-private-key",
      modelId: "demo-model",
      name: "Pesquisa",
    })
  ).model

it("exposes API models in Settings and adds, discovers, tests and removes a masked key", async () => {
  const api = createMockApi()
  render(<SettingsModal api={api} settings={null} onSave={vi.fn()} onClose={vi.fn()} />)
  fireEvent.click(screen.getByRole("tab", { name: "Modelos por API" }))
  await screen.findByLabelText("Provedor da API")

  fill()
  expect(screen.getByLabelText("Chave de API")).toHaveAttribute("type", "password")
  fireEvent.click(screen.getByRole("button", { name: "Carregar modelos" }))
  await screen.findByText("Escolha um modelo da lista ou digite o identificador.")
  expect(document.querySelector('datalist option[value="demo-model"]')).not.toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Testar conexão", exact: true }))
  await screen.findByText("Conexão confirmada. O modelo está pronto para usar.")
  fireEvent.click(screen.getByRole("button", { name: "Salvar modelo por API" }))
  await screen.findByText("Chave guardada no cofre · ••••••••")
  expect(screen.getByLabelText("Chave de API")).toHaveValue("")
  expect(document.body.textContent).not.toContain("fixture-private-key")
  expect(JSON.stringify(api.calls)).not.toContain("fixture-private-key")
  fireEvent.click(screen.getByRole("button", { name: "Testar conexão com DeepSeek" }))
  await waitFor(() => expect(api.calls.some((call) => call.route === "POST /api-models/:id/test")).toBe(true))
  fireEvent.click(screen.getByRole("button", { name: "Remover DeepSeek" }))
  await screen.findByText("Modelo por API e chave removidos.")
  expect(screen.queryByText("Chave guardada no cofre · ••••••••")).toBeNull()
})

it.each(["invalid_key", "no_credit", "model_not_found", "rate_limit"] as const)(
  "explains %s in Portuguese and English",
  async (reason) => {
    const api = createMockApi()
    const request = api.request
    api.request = (async (route, input, path) =>
      route === "POST /api-models/test" ? { ok: false, reason } : request(route, input, path)) as ApiRequest
    render(<ApiModelsSettings api={api} />)
    fill()
    fireEvent.click(screen.getByRole("button", { name: "Testar conexão", exact: true }))
    expect(await screen.findByRole("alert")).toHaveTextContent(t(apiModelErrors[reason]))
    expect(t(apiModelErrors[reason], {}, "en")).toBe(apiModelErrors[reason])
    expect(errorRecovery(apiModelErrors[reason]).actions.some((action) => action.kind === "login")).toBe(false)
  },
)

it("allows a manual model when discovery is unsupported and preserves the form after a vault failure", async () => {
  const api = createMockApi()
  const request = api.request
  api.request = (async (route, input, path) => {
    if (route === "POST /api-models/models") return { models: [], reason: "model_not_found" }
    if (route === "POST /api-models") throw new ApiError(503, "unavailable", "api_model_secret_unavailable")
    return request(route, input, path)
  }) as ApiRequest
  render(<ApiModelsSettings api={api} />)
  fill()
  fireEvent.click(screen.getByRole("button", { name: "Carregar modelos" }))
  await screen.findByText(
    "O provedor não listou modelos. Digite o identificador do modelo que aparece na sua conta do provedor.",
  )
  fireEvent.click(screen.getByRole("button", { name: "Salvar modelo por API" }))
  expect(await screen.findByRole("alert")).toHaveTextContent(t(apiModelErrors.secret_unavailable))
  expect(screen.getByLabelText("Identificador do modelo")).toHaveValue("demo-model")
  expect(screen.getByLabelText("Chave de API")).toHaveValue("fixture-private-key")
})

it("creates a bot with a saved API model without requiring an agent account login", async () => {
  const api = createMockApi()
  const model = await addModel(api)
  const request = api.request
  api.request = (async (route, input, path) =>
    route === "GET /bots/:id/provider-login/flow"
      ? { provider: "codex", state: "cancelled" }
      : request(route, input, path)) as ApiRequest
  const create = vi.fn().mockResolvedValue(undefined)
  render(<BotCreateModal api={api} onCreate={create} onClose={vi.fn()} />)
  await screen.findByRole("option", { name: "Pesquisa · demo-model" })
  fireEvent.change(screen.getByLabelText("Modelos por API"), { target: { value: getApiModelReference(model) } })
  fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Pesquisa" } })
  fireEvent.click(screen.getByRole("button", { name: "Criar bot", exact: true }))
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "opencode", model: getApiModelReference(model) }),
    ),
  )
  expect(create.mock.calls[0]).toHaveLength(1)
})

it("changes an existing bot to an API model from its settings", async () => {
  const api = createMockApi()
  const model = await addModel(api)
  const bot = api.getState().bots[0]
  if (!bot) throw new Error("Missing fixture")
  const updateBot = vi.fn().mockResolvedValue(undefined)
  render(
    <BotSettingsModal
      api={api}
      bot={bot}
      projects={[]}
      routines={[]}
      actions={{ updateBot } as WorkspaceActions}
      onClose={vi.fn()}
    />,
  )
  await screen.findByRole("option", { name: "Pesquisa · demo-model" })
  fireEvent.change(screen.getByLabelText("Modelos por API"), { target: { value: getApiModelReference(model) } })
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Salvar/ }))
  await waitFor(() =>
    expect(updateBot).toHaveBeenCalledWith(
      bot.id,
      expect.objectContaining({ provider: "opencode", model: getApiModelReference(model) }),
    ),
  )
})

it("sends the first API bot message without opening a CLI account login", async () => {
  const api = createMockApi()
  const model = await addModel(api)
  const bot = api.getState().bots[0]
  if (!bot) throw new Error("Missing fixture")
  await api.request("PATCH /bots/:id", { provider: "opencode", model: getApiModelReference(model) }, { id: bot.id })
  const original = api.request
  const loginReads = vi.fn()
  const request: ApiRequest = async (route, input, path) => {
    if (route === "GET /bots/:id/provider-login/flow") {
      loginReads()
      return { provider: "opencode", state: "idle" } as never
    }
    return original(route, input, path)
  }
  const connected = Object.assign({}, api, { request })
  render(<App kernel={{ services: { api: connected } }} />)

  const message = await screen.findByRole("textbox", { name: `Mensagem para ${bot.name}` })
  fireEvent.change(message, { target: { value: "Olá, organize minhas ideias." } })
  fireEvent.click(screen.getByRole("button", { name: "Enviar", exact: true }))

  await waitFor(() => expect(api.calls.some((call) => call.route === "POST /threads/:id/messages")).toBe(true))
  expect(loginReads).not.toHaveBeenCalled()
})

it("keeps native bot settings usable when an older endpoint returns no API catalog", async () => {
  const api = createMockApi()
  const bot = api.getState().bots[0]
  if (!bot) throw new Error("Missing fixture")
  const catalog = vi.fn(async () => ({}))
  const request: ApiRequest = async (route, input, path) =>
    route === "GET /api-models" ? ((await catalog()) as never) : api.request(route, input, path)
  const connected = Object.assign({}, api, { request })
  const actions = { updateBot: vi.fn() } as WorkspaceActions

  render(<BotSettingsModal api={connected} bot={bot} projects={[]} routines={[]} actions={actions} onClose={vi.fn()} />)

  await waitFor(() => expect(catalog).toHaveBeenCalledOnce())
  expect(screen.getByLabelText("Nome")).toBeVisible()
  expect(screen.queryByLabelText("Modelos por API")).toBeNull()
})

it("shows the model name while saved provider metadata is unavailable", async () => {
  const api = createMockApi()
  const value = getApiModelReference({ id: "missing-provider", modelId: "demo-model" })

  render(<ApiModelPicker api={api} id="missing-api-model" value={value} onChange={vi.fn()} />)

  expect(await screen.findByRole("option", { name: "demo-model" })).toBeInTheDocument()
  expect(document.body.textContent).not.toContain("touri-api-missing-provider")
})

it("browser assistance requires a visible opt-in and can be disabled without deleting the key", async () => {
  const api = createMockApi()
  await api.request("POST /api-models", {
    preset: "openrouter",
    apiKey: "fixture-private-key",
    modelId: "demo-model",
    name: "Navegador",
  })
  render(<ApiModelsSettings api={api} />)
  const consent = await screen.findByRole("switch", { name: "Usar esta chave para ajudar nas escolhas do navegador" })

  expect(consent).not.toBeChecked()
  expect(consent).toHaveAccessibleDescription(/modelo remoto JEV.*consumir créditos/)
  fireEvent.click(consent)
  await waitFor(() => expect(consent).toBeChecked())
  fireEvent.click(consent)
  await waitFor(() => expect(consent).not.toBeChecked())
  expect((await api.request("GET /api-models", {})).models).toHaveLength(1)
  expect(document.body.textContent).not.toContain("fixture-private-key")
})
