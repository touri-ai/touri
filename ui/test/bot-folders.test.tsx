import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { Bot } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import App from "../src/App"
import type { TauriInvoke } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { BotCreateModal, BotSettingsModal } from "../src/components/Modals"
import { fullAccessDescription } from "../src/i18n"
import type { WorkspaceActions } from "../src/useWorkspace"
import { selectFolder } from "./folder-picker-helpers"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
const setup = async (patch: Partial<Bot> = {}) => {
  const api = createMockApi()
  const bot = api.getState().bots[0]
  if (!bot) throw new Error("Missing bot")
  Object.assign(bot, { projectId: null, folders: [], anyFolderAccess: false }, patch)
  const invoke = vi.fn(async () => ({ path: "/Users/demo/Documents/reference" })) as ReturnType<typeof vi.fn> &
    TauriInvoke
  const updateBot = vi.fn(async (id, input) => {
    await api.request("PATCH /bots/:id", input, { id })
  })
  const actions = {
    updateBot,
    createProject: async (input: Parameters<WorkspaceActions["createProject"]>[0]) =>
      (await api.request("POST /projects", input)).project,
  } as unknown as WorkspaceActions
  await act(async () => {
    render(
      <BotSettingsModal
        bot={bot}
        bots={api.getState().bots}
        projects={[]}
        routines={[]}
        api={api}
        invokeCommand={invoke}
        actions={actions}
        onClose={vi.fn()}
        initialSection="access"
      />,
    )
  })
  return { api, bot, invoke, updateBot }
}
const anyToggle = () => screen.getByRole("switch", { name: /Acesso a qualquer pasta/ })
const save = () => fireEvent.click(screen.getByRole("button", { name: "Salvar configurações" }))

it.each(["codex", "claude", "opencode"] as const)(
  "explains that %s full local access is not limited by saved folder settings during creation",
  (provider) => {
    render(<BotCreateModal onClose={vi.fn()} onCreate={vi.fn()} />)
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Pesquisa" } })
    fireEvent.click(screen.getByRole("button", { name: "Avançado" }))
    fireEvent.change(screen.getByLabelText("Provedor"), { target: { value: provider } })
    fireEvent.change(screen.getByLabelText("Acesso"), { target: { value: "full" } })
    expect(screen.getByText(/O acesso total permite ler/)).toHaveTextContent(
      "As pastas e exclusões salvas não limitam este acesso.",
    )
    expect(screen.getByText(/O acesso total permite ler/)).toHaveTextContent("Não pede aprovações do provedor.")
    expect(screen.getByText(/Acesso total; pode ler e alterar arquivos em qualquer pasta/)).toBeVisible()
    expect(screen.getByText(/As pastas e a opção abaixo ficam salvas/)).toBeVisible()
    expect(screen.queryByText(/perfis de navegadores e dados do touri ficam bloqueados/)).not.toBeInTheDocument()
    expect(anyToggle()).not.toBeChecked()
    fireEvent.click(anyToggle())
    expect(screen.getByText(/Esta opção fica salva para modos de acesso restrito/)).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Permitir acesso" }))
    expect(anyToggle()).toBeChecked()
    expect(screen.getByText(/O acesso total permite ler/)).toHaveTextContent("As pastas e exclusões salvas não limitam")
  },
)

it.each(["never", "on-request"] as const)(
  "explains full local access with %s approvals in bot settings",
  async (approvals) => {
    await setup({
      provider: "codex",
      access: "full",
      approvals,
      folders: [{ path: "/reference", access: "read-only" }],
    })
    expect(screen.getByText(/O acesso total permite ler/)).toHaveTextContent(
      "qualquer pasta que a conta do sistema permita",
    )
    expect(screen.getByText(/O acesso total permite ler/)).toHaveTextContent(
      approvals === "never" ? "Não pede aprovações do provedor." : "As aprovações do provedor continuam valendo.",
    )
    expect(screen.getByRole("combobox", { name: "Acesso à pasta /reference" })).toBeEnabled()
    expect(screen.getByRole("combobox", { name: "Acesso à pasta /reference" })).toHaveValue("read-only")
    expect(screen.getByText("Pastas salvas para modos de acesso restrito")).toBeVisible()
    expect(screen.queryByText(/sandbox do macOS bloqueia/)).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole("combobox", { name: "Acesso", exact: true }), {
      target: { value: "workspace-write" },
    })
    expect(screen.getByText(/sandbox do macOS bloqueia/)).toBeVisible()
    expect(screen.queryByText(/O acesso total permite ler/)).not.toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: "Acesso à pasta /reference" })).toHaveValue("read-only")
  },
)

it("explains full local filesystem access and provider approvals in English", () => {
  expect(fullAccessDescription({ machine: "local", approvals: "on-request" }, "en")).toContain(
    "Saved folders and exclusions do not limit this access. Provider approvals still apply.",
  )
})

it.each(["read-only", "read-write"] as const)(
  "adds a folder through the shared picker with %s access and saves it",
  async (access) => {
    const f = await setup()
    expect(anyToggle()).not.toBeChecked()
    fireEvent.click(screen.getByRole("button", { name: "Adicionar pasta…" }))
    const picker = screen.getByRole("dialog", { name: "Pastas no servidor" })
    expect(within(picker).getByRole("radio", { name: "Somente leitura", exact: true })).toBeChecked()
    await selectFolder("/workspace/reference", access === "read-write" ? access : undefined)
    const select = await screen.findByRole("combobox", { name: "Acesso à pasta /workspace/reference" })
    expect(f.invoke).not.toHaveBeenCalled()
    expect(select).toHaveValue(access)
    expect(f.updateBot).not.toHaveBeenCalled()
    save()
    await waitFor(() =>
      expect(f.updateBot).toHaveBeenCalledWith(
        f.bot.id,
        expect.objectContaining({
          folders: [{ path: "/workspace/reference", access }],
          anyFolderAccess: false,
        }),
      ),
    )
  },
)

it("removes a folder and saves an empty list", async () => {
  const f = await setup({ folders: [{ path: "/reference", access: "read-write" }] })
  fireEvent.click(screen.getByRole("button", { name: "Remover pasta /reference" }))
  expect(screen.queryByRole("combobox", { name: "Acesso à pasta /reference" })).not.toBeInTheDocument()
  save()
  await waitFor(() => expect(f.updateBot).toHaveBeenCalledWith(f.bot.id, expect.objectContaining({ folders: [] })))
})

it("requires confirmation, supports cancel/Escape, and disables broad access without another confirmation", async () => {
  const f = await setup()
  fireEvent.click(anyToggle())
  let dialog = screen.getByRole("dialog", { name: "Permitir acesso a qualquer pasta?" })
  expect(within(dialog).getByText(/ler arquivos pessoais/)).toBeVisible()
  expect(anyToggle()).not.toBeChecked()
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }))
  expect(anyToggle()).not.toBeChecked()
  fireEvent.click(anyToggle())
  fireEvent.keyDown(document, { key: "Escape" })
  expect(screen.queryByRole("dialog", { name: "Permitir acesso a qualquer pasta?" })).not.toBeInTheDocument()
  fireEvent.click(anyToggle())
  dialog = screen.getByRole("dialog", { name: "Permitir acesso a qualquer pasta?" })
  fireEvent.click(within(dialog).getByRole("button", { name: "Permitir acesso" }))
  expect(anyToggle()).toBeChecked()
  save()
  await waitFor(() =>
    expect(f.updateBot).toHaveBeenCalledWith(f.bot.id, expect.objectContaining({ anyFolderAccess: true })),
  )
  fireEvent.click(anyToggle())
  expect(anyToggle()).not.toBeChecked()
  expect(screen.queryByRole("dialog", { name: "Permitir acesso a qualquer pasta?" })).not.toBeInTheDocument()
})

it("explains VM paths, masking and recreation from the next message while preserving files", async () => {
  await setup({ machine: "vm", access: "full", approvals: "never" })
  expect(screen.getByText(/as pastas valerão a partir da próxima mensagem/)).toHaveTextContent(
    "Os arquivos da máquina serão preservados.",
  )
  expect(screen.getByText(/sua pasta pessoal aparece em/)).toHaveTextContent("/host/home")
  expect(screen.getByText(/O acesso total vale só no computador isolado/)).toHaveTextContent(
    "As permissões de cada pasta continuam valendo.",
  )
  expect(screen.getByText(/perfis de navegadores e dados do touri ficam bloqueados/)).toBeVisible()
  expect(screen.queryByText(/As pastas e a opção abaixo ficam salvas/)).not.toBeInTheDocument()
})

it.each(["read-only", "read-write"] as const)(
  "creates and links a project with %s access and preserves it when saving settings",
  async (access) => {
    const f = await setup()
    fireEvent.click(screen.getByRole("tab", { name: "Projeto" }))
    fireEvent.change(screen.getByRole("combobox", { name: "Projeto" }), { target: { value: "__add_project__" } })
    const dialog = await screen.findByRole("dialog", { name: "Conectar projeto" })
    expect(within(dialog).getByRole("checkbox", { name: /mark/ })).toBeChecked()
    expect(within(dialog).getByRole("checkbox", { name: /mark/ })).toBeDisabled()
    fireEvent.click(within(dialog).getByRole("button", { name: "Escolher pasta" }))
    await selectFolder("/workspace/reference", access)
    await waitFor(() => expect(within(dialog).getByLabelText("Pasta do projeto")).toHaveValue("/workspace/reference"))
    fireEvent.change(within(dialog).getByLabelText("Nome do projeto"), { target: { value: "Referência" } })
    fireEvent.click(within(dialog).getByRole("button", { name: "Conectar projeto" }))
    await waitFor(() => expect(f.updateBot).toHaveBeenCalledTimes(1))
    const linkedId = f.updateBot.mock.calls[0]?.[1].projectId
    expect(linkedId).toBeTruthy()
    expect(f.bot.projectId).toBe(linkedId)
    fireEvent.click(within(dialog).getByRole("button", { name: "Fechar diálogo" }))
    save()
    await waitFor(() =>
      expect(f.updateBot).toHaveBeenLastCalledWith(
        f.bot.id,
        expect.objectContaining({
          projectId: linkedId,
          folders: access === "read-only" ? [{ path: "/workspace/reference", access: "read-only" }] : [],
        }),
      ),
    )
  },
)

it("shows the broad-access badge in the bot header and removes it when access is disabled", async () => {
  const api = createMockApi()
  const bot = api.getState().bots[0]
  if (!bot) throw new Error("Missing bot")
  bot.anyFolderAccess = true
  render(<App kernel={{ services: { api } }} />)
  expect(await screen.findByText("Qualquer pasta do Mac")).toBeVisible()
  await act(async () => {
    await api.request("PATCH /bots/:id", { anyFolderAccess: false }, { id: bot.id })
  })
  expect(screen.queryByText("Qualquer pasta do Mac")).not.toBeInTheDocument()
})

it("saving folder access preserves the bot's existing approvals", async () => {
  const f = await setup({ provider: "codex", access: "full", approvals: "on-request" })
  fireEvent.click(anyToggle())
  fireEvent.click(
    within(screen.getByRole("dialog", { name: "Permitir acesso a qualquer pasta?" })).getByRole("button", {
      name: "Permitir acesso",
    }),
  )
  save()
  await waitFor(() =>
    expect(f.updateBot).toHaveBeenCalledWith(
      f.bot.id,
      expect.objectContaining({ access: "full", approvals: "on-request", anyFolderAccess: true }),
    ),
  )
})
