import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { CloudAccountState, MachineState } from "@touri/contracts"
import { createRef } from "react"
import { afterEach, expect, it, vi } from "vitest"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { BotComputer } from "../src/components/BotComputer"
import { Composer } from "../src/components/Composer"
import { DeleteBotDialog } from "../src/components/DeleteBotDialog"
import { BotCreateModal, SettingsModal } from "../src/components/Modals"

const connected: CloudAccountState = {
  enabled: true,
  connected: true,
  account: { id: "account", name: "Conta de demonstração", role: "owner", deviceId: "device" },
  plan: {
    name: "Cloud Solo · sandbox",
    priceCentavos: 7999,
    currency: "BRL",
    status: "active",
    includedSeconds: 72000,
    storageBytes: 10 * 1024 ** 3,
    subscribeUrl: "https://sandbox.example/v1/subscribe",
    sandbox: true,
  },
  usage: {
    usedSeconds: 7200,
    includedSeconds: 72000,
    storageBytes: 1024 ** 3,
    storageLimitBytes: 10 * 1024 ** 3,
    updatedAt: "2026-10-13T18:30:00Z",
  },
  pairing: null,
}
const setup = async (isConnected = true) => {
  const api = createMockApi()
  const settings = (await api.request("GET /settings", {})).settings
  const request = api.request
  const calls: string[] = []
  let state = isConnected ? connected : { ...connected, connected: false, account: null, plan: null, usage: null }
  api.request = (async (route, body, params) => {
    calls.push(route)
    if (route === "GET /cloud/account" || route === "POST /cloud/pair/poll") return state
    if (route === "POST /cloud/pair") {
      state = {
        ...state,
        pairing: {
          userCode: "ABCD-EFGH",
          verificationUri: "https://sandbox.example/v1/device/verify",
          intervalSeconds: 5,
          expiresAt: "2026-10-13T18:40:00Z",
        },
      }
      return state.pairing
    }
    if (route === "DELETE /cloud/account") {
      state = { ...state, connected: false, account: null, plan: null, usage: null, pairing: null }
      return {}
    }
    if (route === "POST /cloud/bots/:id/wake" || route === "POST /cloud/bots/:id/park")
      return { machine: machine(route.endsWith("wake") ? "running" : "hibernated") }
    return request(route, body, params)
  }) as ApiRequest
  return { api, settings, calls }
}
const machine = (state: "running" | "hibernated" | "waking"): MachineState => ({
  botId: "cloud-bot",
  status: state === "running" ? "running" : state === "waking" ? "starting" : "stopped",
  progress: null,
  error: null,
  memoryMb: 2048,
  createdMs: null,
  startMs: null,
  cloud: { state, generation: 2, usage: connected.usage as NonNullable<CloudAccountState["usage"]> },
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it("flag OFF hides Nuvem and makes no cloud requests in settings or wizard", async () => {
  const { api, settings, calls } = await setup()
  const view = render(
    <SettingsModal api={api} settings={{ ...settings, cloud: false }} onClose={vi.fn()} onSave={vi.fn()} />,
  )
  expect(screen.queryByRole("tab", { name: "Nuvem" })).not.toBeInTheDocument()
  view.unmount()
  render(<BotCreateModal api={api} cloudEnabled={false} onClose={vi.fn()} onCreate={vi.fn()} />)
  expect(calls.filter((call) => call.includes("cloud"))).toHaveLength(0)
})

it("Nuvem shows server-supplied plan/usage and unpairs without changing subscription", async () => {
  const { api, settings, calls } = await setup()
  render(<SettingsModal api={api} settings={{ ...settings, cloud: true }} onClose={vi.fn()} onSave={vi.fn()} />)
  fireEvent.click(screen.getByRole("tab", { name: "Privacidade" }))
  fireEvent.click(screen.getByText("Dados, permissões e conexões"))
  await screen.findByText("Cloud Solo · sandbox")
  expect(screen.getByText("R$ 79,99/mês · Ativo")).toBeVisible()
  expect(screen.getByText("2 h de 20 h")).toBeVisible()
  expect(screen.getByRole("link", { name: "Assinar na web" })).toHaveAttribute(
    "href",
    "https://sandbox.example/v1/subscribe",
  )
  fireEvent.click(screen.getByRole("button", { name: "Desvincular aparelho" }))
  await screen.findByRole("button", { name: "Entrar em uma conta" })
  expect(calls).toContain("DELETE /cloud/account")
  expect(calls.some((call) => call.includes("subscription"))).toBe(false)
})

it("pairing presents only the short code and a web confirmation link", async () => {
  vi.spyOn(window, "open").mockReturnValue(null)
  const { api, settings } = await setup(false)
  const save = vi.fn(async () => undefined)
  render(
    <SettingsModal
      api={api}
      settings={{ ...settings, cloud: true, cloudBaseUrl: "https://sandbox.example" }}
      onClose={vi.fn()}
      onSave={save}
    />,
  )
  fireEvent.click(screen.getByRole("tab", { name: "Privacidade" }))
  fireEvent.click(screen.getByText("Dados, permissões e conexões"))
  fireEvent.click(await screen.findByRole("button", { name: "Entrar em uma conta" }))
  expect(await screen.findByText("ABCD-EFGH")).toBeVisible()
  expect(screen.getByRole("link", { name: "Confirmar no navegador" })).toHaveAttribute(
    "href",
    "https://sandbox.example/v1/device/verify",
  )
  expect(save).toHaveBeenCalledWith({ cloudBaseUrl: "https://sandbox.example" })
  expect(document.body.textContent).not.toContain("deviceCode")
})

it("wizard offers cloud only when connected and collects API-only BYOK", async () => {
  const { api } = await setup()
  const create = vi.fn(async () => undefined)
  render(<BotCreateModal api={api} cloudEnabled onClose={vi.fn()} onCreate={create} />)
  fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Clara" } })
  fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  const option = await screen.findByRole("option", { name: "Na nuvem" })
  expect(option).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText("Máquina", { exact: true }), { target: { value: "cloud" } })
  expect(screen.getByRole("button", { name: "Criar bot" })).toBeDisabled()
  const key = screen.getByLabelText("Chave API do OpenAI")
  expect(key).toHaveAttribute("type", "password")
  fireEvent.change(key, { target: { value: "test-api-key" } })
  fireEvent.click(screen.getByRole("button", { name: "Criar bot" }))
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        machine: "cloud",
        cloudApiKey: "test-api-key",
        vmProviderLogin: false,
        hostComputerUse: false,
        projectId: null,
      }),
    ),
  )
})

it("disconnected wizard never offers Na nuvem even with cloud flag enabled", async () => {
  const { api, calls } = await setup(false)
  render(<BotCreateModal api={api} cloudEnabled onClose={vi.fn()} onCreate={vi.fn()} />)
  fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Clara" } })
  fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  await waitFor(() => expect(calls).toContain("GET /cloud/account"))
  expect(screen.queryByRole("option", { name: "Na nuvem" })).not.toBeInTheDocument()
})

it("Computador shows hibernated/waking/running, usage and remote park/wake actions", async () => {
  const { api } = await setup()
  const fixtureBot = api.getState().bots[0]
  if (!fixtureBot) throw new Error("Missing bot")
  const bot = { ...fixtureBot, id: "cloud-bot", machine: "cloud" as const }
  const props = { api, bot }
  const view = render(<BotComputer {...props} machine={machine("hibernated")} />)
  expect(screen.getByRole("status")).toHaveTextContent("Hibernado")
  expect(screen.getByText("2 h")).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "Acordar" }))
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Rodando"))
  fireEvent.click(screen.getByRole("button", { name: "Hibernar" }))
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Hibernado"))
  view.rerender(<BotComputer {...props} machine={machine("waking")} />)
  expect(screen.getByRole("status")).toHaveTextContent("Acordando")
  expect(screen.getByRole("button", { name: "Acordar" })).toBeDisabled()
})

for (const [status, label] of [
  ["pending", "Pendente"],
  ["active", "Ativo"],
  ["past_due", "Inadimplente"],
  ["canceled", "Cancelado"],
] as const) {
  it(`account displays ${status} from the cloud state`, async () => {
    const { api, settings } = await setup()
    const request = api.request
    if (!connected.account || !connected.plan) throw new Error("Missing account fixture")
    const identity = connected.account,
      plan = connected.plan
    api.request = (async (route, body, params) =>
      route === "GET /cloud/account"
        ? {
            ...connected,
            account: { ...identity, email: "conta@example.invalid" },
            plan: { ...plan, status },
          }
        : request(route, body, params)) as ApiRequest
    render(<SettingsModal api={api} settings={{ ...settings, cloud: true }} onClose={vi.fn()} onSave={vi.fn()} />)
    fireEvent.click(screen.getByRole("tab", { name: "Privacidade" }))
    fireEvent.click(screen.getByText("Dados, permissões e conexões"))
    expect(await screen.findByText(`R$ 79,99/mês · ${label}`)).toBeVisible()
    expect(screen.getByText("conta@example.invalid")).toBeVisible()
  })
}
it("running lifecycle with runtime unavailable shows em breve and makes no runtime request", async () => {
  const { api, calls } = await setup()
  const fixtureBot = api.getState().bots[0]
  if (!fixtureBot) throw new Error("Missing bot fixture")
  const bot = { ...fixtureBot, id: "cloud-bot", machine: "cloud" as const }
  render(<BotComputer api={api} bot={bot} machine={machine("running")} />)
  await waitFor(() => expect(calls).toContain("GET /cloud/account"))
  expect(screen.getAllByText("Execução na nuvem chega em breve").length).toBeGreaterThan(0)
  expect(screen.queryByRole("button", { name: "Entrar no computador" })).not.toBeInTheDocument()
  expect(screen.queryByLabelText("Terminal na nuvem")).not.toBeInTheDocument()
  expect(calls.some((call) => call.includes("shell") || call.includes("desktop-sessions"))).toBe(false)
})

it("cloud composer blocks runtime submission before execution is available", async () => {
  const { api } = await setup()
  const fixtureBot = api.getState().bots[0]
  if (!fixtureBot) throw new Error("Missing bot")
  const bot = { ...fixtureBot, machine: "cloud" as const }
  const send = vi.fn()
  render(
    <Composer
      api={api}
      bot={bot}
      threadId="cloud-thread"
      parentId={null}
      draft="teste"
      onDraft={vi.fn()}
      inputRef={createRef<HTMLTextAreaElement>()}
      activeRun={null}
      queuedCount={0}
      onSend={send}
      onCancel={vi.fn()}
    />,
  )
  expect(await screen.findByText("Execução na nuvem chega em breve")).toBeVisible()
  expect(screen.getByRole("textbox")).toBeDisabled()
  fireEvent.submit(screen.getByRole("form", { name: "Compor mensagem" }))
  expect(send).not.toHaveBeenCalled()
})
it("cloud deletion explicitly includes computer files in the confirmation", async () => {
  const { api } = await setup()
  const fixtureBot = api.getState().bots[0]
  if (!fixtureBot) throw new Error("Missing bot")
  const bot = { ...fixtureBot, machine: "cloud" as const },
    remove = vi.fn(async () => undefined)
  render(<DeleteBotDialog bot={bot} onDelete={remove} onClose={vi.fn()} />)
  expect(screen.getByRole("checkbox")).toBeChecked()
  expect(screen.getByRole("checkbox")).toBeDisabled()
  fireEvent.change(screen.getByLabelText(`Digite o nome do bot: ${bot.name}`), { target: { value: bot.name } })
  fireEvent.click(screen.getByRole("button", { name: "Excluir bot" }))
  await waitFor(() => expect(remove).toHaveBeenCalledWith(bot.id, bot.name, true))
})
