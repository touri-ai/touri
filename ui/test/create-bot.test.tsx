import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ProviderLoginFlow } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import App from "../src/App"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { BotCreateModal } from "../src/components/Modals"
import { getJobTemplates } from "../src/features/jobs/catalog"

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
  expect(clicks).toBeLessThanOrEqual(3)
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
    roleLine: null,
    instructions: "",
    vmProviderLogin: false,
    hostComputerUse: false,
    color: expect.stringMatching(/^#/),
    avatarShape: expect.any(String),
  })
})

it.each([
  [{ codex: "ready", claude: "ready", opencode: "ready" }, "codex", "Codex"],
  [{ codex: "cancelled", claude: "host-available", opencode: "ready" }, "claude", "Claude Code"],
  [{ opencode: "host-available" }, "opencode", "OpenCode"],
] as const)("uses the first signed-in account from %o", async (states, expected, name) => {
  const api = accounts(states)
  const create = vi.fn(async () => undefined)
  render(<BotCreateModal api={api} onClose={vi.fn()} onCreate={create} />)
  await screen.findByText(`Usa o ${name}, que já está conectado neste Mac.`)
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
  fireEvent.click(screen.getByRole("button", { name: "Avançado" }))
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
  fireEvent.click(screen.getByRole("button", { name: "Avançado" }))
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
  fireEvent.click(screen.getByRole("button", { name: "Avançado" }))
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
