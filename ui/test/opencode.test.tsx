import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { BotCreateModal, BotSettingsModal } from "../src/components/Modals"
import { ProviderModelField } from "../src/components/ProviderModelField"
import { DoctorChecks } from "../src/features/doctor/DoctorChecks"
import type { WorkspaceActions } from "../src/useWorkspace"

afterEach(cleanup)
it("creates an OpenCode bot with a provider/model ID and approval mode in Portuguese", async () => {
  const mock = createMockApi()
  const create = vi.fn(async () => undefined)
  render(<BotCreateModal api={mock} onClose={vi.fn()} onCreate={create} />)
  fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Pesquisa" } })
  fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  await screen.findByText(/Usa o Codex/)
  fireEvent.change(screen.getByLabelText("Provedor"), { target: { value: "opencode" } })
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("openrouter/deepseek/deepseek-v3.2"))
  expect(screen.getByRole("option", { name: "OpenCode" })).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText("Modelo", { selector: "input" }), {
    target: { value: "openrouter/deepseek/deepseek-v3.2" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Criar bot" }))
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "opencode",
        model: "openrouter/deepseek/deepseek-v3.2",
        access: "workspace-write",
        approvals: "on-request",
      }),
      expect.stringMatching(/^draft-/),
    ),
  )
})

it("bot settings preserve OpenCode and immediately save a different model", async () => {
  const mock = createMockApi()
  const request: ApiRequest = async (route, input, path) => {
    if (route === "GET /providers/opencode/models")
      return {
        models: ["openrouter/deepseek/deepseek-v3.2", "openrouter/deepseek/deepseek-r1"],
        defaultModel: "openrouter/deepseek/deepseek-v3.2",
        available: true,
      } as never
    return mock.request(route, input, path)
  }
  const api = { ...mock, request }
  const bots = await mock.request("GET /bots", {})
  const bot = { ...bots.bots[0], provider: "opencode" as const, model: "openrouter/deepseek/deepseek-v3.2" }
  if (!bot.id) throw new Error("Missing mock bot")
  const updateBot = vi.fn(async () => undefined)
  const updateBotModel = vi.fn(async () => undefined)
  render(
    <BotSettingsModal
      api={api}
      bot={bot as (typeof bots.bots)[number]}
      projects={[]}
      routines={[]}
      actions={{ updateBot, updateBotModel } as unknown as WorkspaceActions}
      onClose={vi.fn()}
    />,
  )
  fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  expect(screen.getByLabelText("Provedor")).toHaveValue("opencode")
  fireEvent.click(screen.getByRole("tab", { name: "Modelo", exact: true }))
  fireEvent.click(screen.getByRole("button", { name: "Escolher modelo: OpenCode · openrouter/deepseek/deepseek-v3.2" }))
  const listbox = await screen.findByRole("listbox", { name: "Modelos de OpenCode" })
  fireEvent.click(await within(listbox).findByRole("option", { name: "openrouter/deepseek/deepseek-r1" }))
  await waitFor(() => expect(updateBotModel).toHaveBeenCalledWith(bot.id, "openrouter/deepseek/deepseek-r1"))
  expect(updateBot).not.toHaveBeenCalled()
})

it("model picker lists models and explains unavailable OpenCode without preventing manual input", async () => {
  const mock = createMockApi()
  const change = vi.fn()
  const view = render(<ProviderModelField id="model" api={mock} provider="opencode" value="" onChange={change} />)
  await waitFor(() =>
    expect(view.container.querySelector("datalist option")).toHaveAttribute(
      "value",
      "openrouter/deepseek/deepseek-v3.2",
    ),
  )
  expect(screen.getByRole("combobox")).toHaveAttribute("placeholder", "openrouter/deepseek/deepseek-v3.2")
  cleanup()
  const api = {
    ...mock,
    request: vi.fn(async () => ({ models: [], defaultModel: null, available: false })),
  } as unknown as typeof mock
  render(<ProviderModelField id="manual" api={api} provider="opencode" value="" onChange={change} />)
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Instale o OpenCode"))
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "deepseek/deepseek-chat" } })
  expect(change).toHaveBeenCalledWith("deepseek/deepseek-chat")
})

it("Doctor groups OpenCode with AI providers and exposes the install hint", () => {
  render(
    <DoctorChecks
      error={null}
      onRefresh={async () => {}}
      doctor={{
        checks: [
          {
            id: "opencode",
            label: "OpenCode · versão",
            status: "warn",
            ok: false,
            detail: "CLI ausente",
            fix: "curl -fsSL https://opencode.ai/install | bash",
          },
        ],
        checkedAt: 1,
        running: false,
      }}
    />,
  )
  expect(screen.getByText("Provedores de IA")).toBeInTheDocument()
  expect(screen.getByText("OpenCode · versão")).toBeInTheDocument()
  expect(screen.getByText("curl -fsSL https://opencode.ai/install | bash")).toBeInTheDocument()
})
