import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ProviderLoginFlow } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import App from "../src/App"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { BotCreateModal } from "../src/components/Modals"
import { ApiError } from "../src/errors"
import { getJobTemplates } from "../src/features/jobs/catalog"
import { t } from "../src/i18n"
import { selectFolder } from "./folder-picker-helpers"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const accounts = (states: Partial<Record<ProviderLoginFlow["provider"], ProviderLoginFlow["state"]>>) => {
  const api = createMockApi()
  const request = api.request
  api.request = (async (route, input, path) => {
    if (route === "GET /bots/:id/provider-login/flow") {
      const { provider } = input as { provider: ProviderLoginFlow["provider"] }
      return { provider, state: states[provider] ?? "cancelled" }
    }
    return request(route, input, path)
  }) as ApiRequest
  return api
}

const openCreation = async (api: ReturnType<typeof createMockApi>, first: boolean) => {
  if (first) {
    api.getState().bots.splice(0)
    api.getState().threads.splice(0)
  }
  render(<App kernel={{ services: { api } }} />)
  fireEvent.click(await screen.findByRole("button", { name: first ? "Criar meu primeiro bot" : "Criar bot" }))
  fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Café Ideias" } })
  await screen.findByText(/Usa o Codex/)
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Criar bot", exact: true }))
}

const expectCreatedConversation = async (api: ReturnType<typeof createMockApi>) => {
  expect(await screen.findByRole("textbox", { name: "Mensagem para Café Ideias" }, { timeout: 3000 })).toBeVisible()
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  const bot = api.getState().bots.find((bot) => bot.name === "Café Ideias")
  expect(bot?.mainThreadId).toBeTruthy()
  await waitFor(() =>
    expect(JSON.parse(localStorage.getItem("touri.workspace.v1") ?? "{}")).toMatchObject({
      botId: bot?.id,
      threadId: bot?.mainThreadId,
    }),
  )
  expect(api.calls.filter((call) => call.route === "POST /bots")).toHaveLength(1)
}

it.each([true, false])(
  "keeps creation mounted through live events and opens its conversation (first=%s)",
  async (first) => {
    const api = accounts({ codex: "ready" })
    const original = api.request
    let finish: () => void = () => undefined
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const request = vi.fn(async (route, input, path) => {
      if (route === "POST /bots/:id/provider-login/flow" && input.action === "adopt") await pending
      return original(route, input, path)
    })
    api.request = request as ApiRequest
    await openCreation(api, first)
    await waitFor(() => expect(api.getState().bots.some((bot) => bot.name === "Café Ideias")).toBe(true))
    expect(screen.getByLabelText("Nome")).toHaveValue("Café Ideias")
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Criando…", exact: true })).toBeDisabled()
    expect(
      request.mock.calls.some(
        ([route, input]) => route === "POST /bots/:id/provider-login/flow" && input.action === "cancel",
      ),
    ).toBe(false)
    await act(async () => finish())
    await expectCreatedConversation(api)
    expect(screen.getByRole("status")).toHaveTextContent("Café Ideias criado.")
  },
)

it("retries a retryable 503 during creation and recovers without another click", async () => {
  const api = accounts({ codex: "ready" })
  const original = api.request
  let attempts = 0
  api.request = (async (route, input, path) => {
    if (route === "POST /bots/:id/provider-login/flow" && (input as { action: string }).action === "adopt") {
      if (++attempts === 1) throw new ApiError(503, "unavailable", "TOURI-E1009")
    }
    return original(route, input, path)
  }) as ApiRequest
  await openCreation(api, true)
  await expectCreatedConversation(api)
  expect(attempts).toBe(2)
})

it("bounds retries and automatically uses an available host login after adoption fails", async () => {
  const api = accounts({ codex: "ready" })
  const original = api.request
  let attempts = 0
  let hostUses = 0
  api.request = (async (route, input, path) => {
    if (route === "POST /bots/:id/provider-login/flow") {
      const action = (input as { action: string }).action
      if (action === "adopt") {
        attempts++
        throw new ApiError(503, "unavailable", "TOURI-E1009")
      }
      if (action === "use-host") hostUses++
    }
    if (route === "GET /bots/:id/provider-login/flow" && !path?.id?.startsWith("draft-"))
      return { provider: "codex", state: hostUses ? "ready" : "host-available", host: "server" }
    return original(route, input, path)
  }) as ApiRequest
  await openCreation(api, true)
  await expectCreatedConversation(api)
  expect(attempts).toBe(3)
  expect(hostUses).toBe(1)
  expect(screen.queryByRole("button", { name: "Usar login deste servidor" })).toBeNull()
})

it("finishes creation after a non-retryable login failure with a friendly message and a recovery action", async () => {
  const api = accounts({ codex: "ready" })
  const original = api.request
  let attempts = 0
  let denied = true
  api.request = (async (route, input, path) => {
    if (route === "POST /bots/:id/provider-login/flow") {
      const action = (input as { action: string }).action
      if (action === "adopt") attempts++
      if (denied && (action === "adopt" || action === "start"))
        throw new ApiError(403, "synthetic internal detail", "TOURI-E1010")
    }
    if (route === "GET /bots/:id/provider-login/flow" && !path?.id?.startsWith("draft-"))
      return { provider: "codex", state: "idle" }
    return original(route, input, path)
  }) as ApiRequest
  await openCreation(api, true)
  await expectCreatedConversation(api)
  expect(attempts).toBe(1)
  expect(screen.getByRole("status")).toHaveTextContent("Bot criado. Não foi possível conectar sua conta.")
  expect(await screen.findByRole("button", { name: "Entrar no Codex", exact: true })).toBeEnabled()
  expect(document.body.textContent).not.toMatch(/TOURI-E1010|synthetic internal detail/)
  expect(
    api.calls.some(
      (call) =>
        call.route === "POST /bots/:id/provider-login/flow" && (call.input as { action?: string }).action === "start",
    ),
  ).toBe(false)
  denied = false
  fireEvent.click(screen.getByRole("button", { name: "Entrar no Codex", exact: true }))
  await waitFor(() => expect(screen.queryByRole("button", { name: "Entrar no Codex", exact: true })).toBeNull())
  expect(api.calls.filter((call) => call.route === "POST /bots")).toHaveLength(1)
})

it("creates from the landing with only a name in two clicks and no technical fields", async () => {
  const api = createMockApi()
  api.getState().bots.splice(0)
  api.getState().threads.splice(0)
  render(<App kernel={{ services: { api } }} />)
  let clicks = 0
  fireEvent.click(await screen.findByRole("button", { name: "Criar meu primeiro bot" }))
  clicks++
  const dialog = screen.getByRole("dialog")
  expect(screen.getByLabelText("Nome")).toHaveFocus()
  expect(dialog.textContent).not.toMatch(/SOUL\.md|provider|provedor|model|MCP|sandbox|\bVM\b/i)
  expect(screen.queryByRole("button", { name: "Continuar" })).toBeNull()
  expect(screen.queryByLabelText("Provedor")).toBeNull()
  fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Clara" } })
  await screen.findByText(/Usa o Codex/)
  fireEvent.click(within(dialog).getByRole("button", { name: "Criar bot" }))
  clicks++
  expect(await screen.findByRole("textbox", { name: "Mensagem para Clara" })).toBeVisible()
  expect(clicks).toBe(2)
  const call = api.calls.find((call) => call.route === "POST /bots")
  expect(call?.input).toMatchObject({
    name: "Clara",
    provider: "codex",
    model: null,
    reasoningEffort: null,
    access: "workspace-write",
    approvals: "on-request",
    machine: "local",
    browserEnabled: true,
    projectId: null,
    folders: [],
    anyFolderAccess: false,
    roleLine: null,
    instructions: "",
    vmProviderLogin: false,
    hostComputerUse: false,
    color: expect.stringMatching(/^#/),
    avatarShape: expect.any(String),
  })
})

it.each([true, false])("renders project and folder controls only inside Advanced (first=%s)", async (first) => {
  const api = createMockApi()
  const { project } = await api.request("POST /projects", { path: "/workspace/example", name: "Projeto de exemplo" })
  const request = (async (route, input, path) => {
    if (first && route === "GET /bots") return { bots: [] }
    if (route === "GET /projects") return { projects: [project] }

    return api.request(route, input, path)
  }) as ApiRequest
  render(<App kernel={{ services: { api: { request, subscribe: api.subscribe, isMock: true } } }} />)

  fireEvent.click(await screen.findByRole("button", { name: first ? "Criar meu primeiro bot" : "Criar bot" }))
  const dialog = screen.getByRole("dialog")
  const advanced = within(dialog).getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ })
  await within(dialog).findByText(/Usa o Codex/)

  expect(advanced).toHaveAttribute("aria-expanded", "false")
  expect(within(dialog).getByLabelText("Nome")).toHaveFocus()
  expect(within(dialog).getByRole("radiogroup", { name: "O que ele faz?" })).toBeInTheDocument()
  expect(within(dialog).getByRole("group", { name: "Mascote" })).toBeInTheDocument()
  expect(within(dialog).queryByLabelText("Projeto")).not.toBeInTheDocument()
  expect(within(dialog).queryByText(project.name)).not.toBeInTheDocument()
  expect(dialog.querySelector(".bot-folder-settings")).toBeNull()
  expect(within(dialog).queryByRole("button", { name: /Usar uma pasta|Adicionar pasta/ })).not.toBeInTheDocument()

  fireEvent.click(advanced)

  expect(advanced).toHaveAttribute("aria-expanded", "true")
  const section = dialog.querySelector<HTMLElement>("#bot-create-advanced")
  if (!section) throw new Error("Missing advanced settings")
  const settings = within(section)
  expect(settings.getByLabelText("Projeto")).toHaveValue("")
  expect(settings.getByRole("option", { name: project.name })).toBeInTheDocument()
  expect(settings.getByText("Nenhuma pasta adicional.")).toBeInTheDocument()
  expect(settings.getByRole("switch", { name: /Acesso a qualquer pasta/ })).not.toBeChecked()

  fireEvent.change(settings.getByLabelText("Projeto"), { target: { value: project.id } })
  fireEvent.click(settings.getByRole("button", { name: "Adicionar pasta…" }))
  await selectFolder("/workspace/reference", "read-only")
  fireEvent.click(advanced)

  expect(within(dialog).queryByLabelText("Projeto")).not.toBeInTheDocument()
  expect(dialog.querySelector(".bot-folder-settings")).toBeNull()
  expect(within(dialog).queryByText("/workspace/reference")).not.toBeInTheDocument()

  fireEvent.click(advanced)

  expect(within(dialog).getByLabelText("Projeto")).toHaveValue(project.id)
  expect(within(dialog).getByLabelText("Acesso à pasta /workspace/reference")).toHaveValue("read-only")
  expect(within(dialog).getByRole("switch", { name: /Acesso a qualquer pasta/ })).not.toBeChecked()
})

it("keeps the automatic conversation choice in Advanced and submits it", async () => {
  const create = vi.fn(async () => undefined)
  render(<BotCreateModal api={accounts({ codex: "ready" })} onClose={vi.fn()} onCreate={create} />)
  await screen.findByText(/Usa o Codex/)
  const dialog = screen.getByRole("dialog")
  const advanced = within(dialog).getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ })

  expect(within(dialog).queryByLabelText("Onde o bot responde")).toBeNull()

  fireEvent.click(advanced)
  fireEvent.change(within(dialog).getByLabelText("Onde o bot responde"), { target: { value: "task" } })
  fireEvent.change(within(dialog).getByLabelText("Nome"), { target: { value: "Clara" } })
  fireEvent.click(within(dialog).getByRole("button", { name: "Criar bot", exact: true }))

  await waitFor(() =>
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ automaticConversationMode: "task" }),
      expect.any(String),
    ),
  )
})

it.each([
  [{ codex: "ready", claude: "ready", opencode: "ready" }, "codex", "Codex"],
  [{ codex: "cancelled", claude: "host-available", opencode: "ready" }, "claude", "Claude Code"],
  [{ opencode: "host-available" }, "opencode", "OpenCode"],
] as const)("uses the first signed-in account from %o", async (states, expected, name) => {
  const api = accounts(states)
  const create = vi.fn(async () => undefined)
  render(<BotCreateModal api={api} onClose={vi.fn()} onCreate={create} />)
  await screen.findByText(`Usa o ${name}, conectado neste servidor.`)
  expect(screen.queryByRole("region", { name: "Escolha uma conta" })).toBeNull()
  fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Clara" } })
  fireEvent.click(screen.getByRole("button", { name: "Criar bot" }))
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ provider: expected }),
      expect.stringMatching(/^draft-/),
    ),
  )
  if (states[expected as keyof typeof states] === "host-available")
    expect(api.calls).toContainEqual(
      expect.objectContaining({
        route: "POST /bots/:id/provider-login/flow",
        input: { provider: expected, action: "use-host" },
      }),
    )
})

it("shows sign-in inline immediately and gives a visible error on create until signed in", async () => {
  const api = accounts({})
  const create = vi.fn(async () => undefined)
  render(<BotCreateModal api={api} onClose={vi.fn()} onCreate={create} />)
  const choices = await screen.findByRole("region", { name: "Escolha uma conta" })
  for (const name of ["Codex", "Claude Code", "OpenCode"])
    expect(within(choices).getByRole("button", { name, exact: true })).toBeVisible()
  fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Clara" } })
  fireEvent.click(screen.getByRole("button", { name: "Criar bot" }))
  expect(screen.getByRole("alert")).toHaveTextContent("Entre em uma conta acima")
  expect(choices).toHaveFocus()
  expect(create).not.toHaveBeenCalled()
  expect(screen.getByLabelText("Nome")).toHaveValue("Clara")
})

it("opens inline sign-in when an advanced account choice has no login", async () => {
  const api = accounts({ codex: "ready" })
  const create = vi.fn(async () => undefined)
  render(<BotCreateModal api={api} onClose={vi.fn()} onCreate={create} />)
  await screen.findByText(/Usa o Codex/)
  fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  fireEvent.change(screen.getByLabelText("Provedor"), { target: { value: "claude" } })
  const choices = await screen.findByRole("region", { name: "Escolha uma conta" })
  expect(within(choices).getByRole("button", { name: "Claude Code" })).toHaveAttribute("aria-pressed", "true")
  fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Clara" } })
  fireEvent.click(screen.getByRole("button", { name: "Criar bot" }))
  expect(create).not.toHaveBeenCalled()
  expect(screen.getByRole("alert")).toHaveTextContent("Entre em uma conta acima")
})

it("keeps a ready account available when switching away and back, and resets model choices", async () => {
  const states: Partial<Record<ProviderLoginFlow["provider"], ProviderLoginFlow["state"]>> = {
    codex: "ready",
    claude: "ready",
  }
  const api = accounts(states)
  const request = api.request
  api.request = (async (route, input, path) => {
    if (route === "POST /bots/:id/provider-login/flow") {
      const { provider, action } = input as { provider: ProviderLoginFlow["provider"]; action: string }
      if (action === "cancel") states[provider] = "cancelled"
    }
    return request(route, input, path)
  }) as ApiRequest
  render(<BotCreateModal api={api} onClose={vi.fn()} onCreate={vi.fn()} />)
  await screen.findByText(/Usa o Codex/)
  fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  fireEvent.change(screen.getByLabelText("Modelo"), { target: { value: "custom-model" } })
  fireEvent.change(screen.getByLabelText("Raciocínio"), { target: { value: "high" } })
  fireEvent.change(screen.getByLabelText("Provedor"), { target: { value: "claude" } })
  await screen.findByText(/Usa o Claude Code/)
  expect(screen.getByLabelText("Modelo")).toHaveValue("")
  expect(screen.getByLabelText("Raciocínio")).toHaveValue("")
  fireEvent.change(screen.getByLabelText("Provedor"), { target: { value: "codex" } })
  await screen.findByText(/Usa o Codex/)
  expect(screen.queryByRole("region", { name: "Escolha uma conta" })).toBeNull()
})

it("sets only role and instructions from a job and can clear the choice", async () => {
  const create = vi.fn(async () => undefined)
  render(<BotCreateModal onClose={vi.fn()} onCreate={create} />)
  fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Clara" } })
  const job = getJobTemplates()[0]
  if (!job) throw new Error("Missing job")
  fireEvent.click(screen.getByRole("radio", { name: job.name }))
  fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  expect(screen.getByLabelText("Função")).toHaveValue(job.roleLine)
  expect(screen.getByLabelText("Instruções do bot")).toHaveValue(job.instructions)
  fireEvent.click(screen.getByRole("radio", { name: "Ainda não sei" }))
  expect(screen.getByLabelText("Função")).toHaveValue("")
  expect(screen.getByLabelText("Instruções do bot")).toHaveValue("")
  fireEvent.click(screen.getByRole("radio", { name: job.name }))
  fireEvent.click(screen.getByRole("button", { name: "Criar bot" }))
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        roleLine: job.roleLine,
        instructions: job.instructions,
        access: "workspace-write",
        browserEnabled: true,
        machine: "local",
        projectId: null,
      }),
    ),
  )
})

it("opens QA Café with the selected notes job and fills the source-free example without sending", async () => {
  const api = accounts({ codex: "ready" })
  api.getState().bots.splice(0)
  api.getState().threads.splice(0)
  render(<App kernel={{ services: { api } }} />)
  fireEvent.click(await screen.findByRole("button", { name: "Criar meu primeiro bot" }))
  fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "QA Café" } })
  fireEvent.click(screen.getByRole("radio", { name: "Caderno em ordem" }))
  await screen.findByText(/Usa o Codex/)
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Criar bot", exact: true }))
  const composer = await screen.findByRole("textbox", { name: "Mensagem para QA Café" })
  const job = getJobTemplates().find((job) => job.id === "notes-in-order")
  if (!job) throw new Error("Missing notes job")
  expect(api.calls.find((call) => call.route === "POST /bots")?.input).toMatchObject({
    name: "QA Café",
    roleLine: job.roleLine,
    instructions: job.instructions,
  })
  const start = screen.getByRole("region", { name: "Comece uma conversa com QA Café" })
  const prompt = within(start).getByRole("button", { name: "Usar exemplo", exact: true })
  expect(within(start).queryByRole("button", { name: /plano de testes|contexto deste projeto/ })).toBeNull()
  fireEvent.click(prompt)
  expect(composer).toHaveValue(t("onboarding.examplePrompt"))
  expect(api.calls.some((call) => call.route === "POST /threads/:id/messages")).toBe(false)
})

it("reports account discovery failures and keeps sign-in choices available", async () => {
  const api = createMockApi()
  const request = api.request
  api.request = (async (route, input, path) => {
    if (route === "GET /bots/:id/provider-login/flow") throw new Error("unavailable")
    return request(route, input, path)
  }) as ApiRequest
  render(<BotCreateModal api={api} onClose={vi.fn()} onCreate={vi.fn()} />)
  expect(await screen.findByRole("region", { name: "Escolha uma conta" })).toBeVisible()
  expect(screen.getAllByRole("alert").some((alert) => alert.textContent?.includes("verificar as contas"))).toBe(true)
})

it("switches to another signed-in account with the first sign-in chooser", async () => {
  const api = accounts({ codex: "ready", claude: "ready" })
  const create = vi.fn(async () => undefined)
  render(<BotCreateModal api={api} onClose={vi.fn()} onCreate={create} />)
  await screen.findByText(/Usa o Codex/)
  expect(screen.queryByRole("region", { name: "Escolha uma conta" })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Usar outra conta" }))
  const chooser = await screen.findByRole("region", { name: "Escolha uma conta" })
  expect(within(chooser).getByText("Escolha a conta que este bot vai usar.")).toBeVisible()
  await waitFor(() => expect(within(chooser).getByRole("button", { name: "Codex" })).toHaveFocus())
  expect(screen.queryByRole("button", { name: "Usar outra conta" })).toBeNull()
  fireEvent.click(within(chooser).getByRole("button", { name: "Claude Code" }))
  await screen.findByText(/Usa o Claude Code/)
  expect(within(chooser).getByRole("button", { name: "Claude Code" })).toHaveAttribute("aria-pressed", "true")
  expect(screen.queryByRole("button", { name: "Colar token manualmente" })).toBeNull()
  expect(screen.queryByLabelText("Provedor")).toBeNull()
  fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Clara" } })
  fireEvent.click(screen.getByRole("button", { name: "Criar bot" }))
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "claude" }),
      expect.stringMatching(/^draft-/),
    ),
  )
})

it("shows the sign-in flow when the other account is not signed in yet", async () => {
  const api = accounts({ codex: "ready" })
  render(<BotCreateModal api={api} onClose={vi.fn()} onCreate={vi.fn(async () => undefined)} />)
  await screen.findByText(/Usa o Codex/)
  fireEvent.click(screen.getByRole("button", { name: "Usar outra conta" }))
  const chooser = await screen.findByRole("region", { name: "Escolha uma conta" })
  fireEvent.click(within(chooser).getByRole("button", { name: "OpenCode" }))
  expect(await within(chooser).findByText("Entre em uma conta para criar seu bot.")).toBeVisible()
  expect(within(chooser).getByRole("region", { name: "Login do provedor nesta máquina" })).toBeVisible()
  expect(screen.queryByText(/Usa o OpenCode/)).toBeNull()
})
