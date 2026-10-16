import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { Bot } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import App from "../src/App"
import type { TauriInvoke } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { BotCreateModal, BotSettingsModal } from "../src/components/Modals"
import type { WorkspaceActions } from "../src/useWorkspace"

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
        initialSection="computer"
      />,
    )
  })
  return { api, bot, invoke, updateBot }
}
const anyToggle = () => screen.getByRole("switch", { name: /Acesso a qualquer pasta deste Mac/ })
const save = () => fireEvent.click(screen.getByRole("button", { name: "Salvar configurações" }))

it.each(["codex", "claude", "opencode"] as const)(
  "explains that %s full access preserves the separate folder limits during creation",
  (provider) => {
    render(<BotCreateModal onClose={vi.fn()} onCreate={vi.fn()} />)
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Pesquisa" } })
    fireEvent.click(screen.getByRole("button", { name: "Continuar" }))
    fireEvent.click(screen.getByRole("button", { name: "Continuar" }))
    fireEvent.change(screen.getByLabelText("Provedor"), { target: { value: provider } })
    fireEvent.change(screen.getByLabelText("Acesso"), { target: { value: "full" } })
    expect(screen.getByText(/O acesso total dispensa aprovações/)).toHaveTextContent(
      "A escrita segue as permissões de pastas configuradas para o bot.",
    )
    expect(screen.getByText(/O acesso total dispensa aprovações/)).toHaveTextContent(
      "A opção “Acesso a qualquer pasta deste Mac” é independente",
    )
    expect(screen.queryByText(/escreva em qualquer pasta/)).not.toBeInTheDocument()
    if (provider === "codex")
      expect(screen.getByText(/sem o sandbox do provedor/)).toHaveTextContent("As restrições de pastas do touri")
    fireEvent.click(screen.getByRole("button", { name: "Continuar" }))
    expect(anyToggle()).not.toBeChecked()
    expect(screen.getByText(/Pode ler arquivos do Mac; escrita na pasta do bot/)).toBeVisible()
    expect(screen.getByText(/o sandbox do macOS bloqueia/)).toBeVisible()
    fireEvent.click(anyToggle())
    fireEvent.click(screen.getByRole("button", { name: "Permitir acesso" }))
    expect(screen.getByText("Pode acessar todo o Mac")).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Voltar" }))
    expect(screen.getByText(/O acesso total dispensa aprovações/)).toHaveTextContent(
      "A escrita segue as permissões de pastas configuradas para o bot.",
    )
  },
)

it("uses the same full-access explanation in bot settings", async () => {
  await setup({ provider: "codex", access: "full", approvals: "never" })
  fireEvent.click(screen.getByRole("tab", { name: "Permissões" }))
  expect(screen.getByText(/O acesso total dispensa aprovações/)).toHaveTextContent(
    "A opção “Acesso a qualquer pasta deste Mac” é independente",
  )
  expect(screen.getByText(/sem o sandbox do provedor/)).toHaveTextContent("As restrições de pastas do touri")
})

it("adds a folder through the native picker, defaults read-only and saves a per-folder write choice", async () => {
  const f = await setup()
  expect(anyToggle()).not.toBeChecked()
  fireEvent.click(screen.getByRole("button", { name: "Adicionar pasta…" }))
  const select = await screen.findByRole("combobox", { name: "Acesso à pasta /Users/demo/Documents/reference" })
  expect(f.invoke).toHaveBeenCalledWith("pick_folder", { title: "Adicionar pasta acessível ao bot" })
  expect(select).toHaveValue("read-only")
  fireEvent.change(select, { target: { value: "read-write" } })
  expect(f.updateBot).not.toHaveBeenCalled()
  save()
  await waitFor(() =>
    expect(f.updateBot).toHaveBeenCalledWith(
      f.bot.id,
      expect.objectContaining({
        folders: [{ path: "/Users/demo/Documents/reference", access: "read-write" }],
        anyFolderAccess: false,
      }),
    ),
  )
})

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

it("explains VM paths, masking and next-turn recreation while preserving files", async () => {
  await setup({ machine: "vm" })
  expect(screen.getByText(/as pastas serão aplicadas.*próximo turno/)).toHaveTextContent(
    "Os arquivos da máquina serão preservados.",
  )
  expect(screen.getByText(/sua pasta pessoal aparece em/)).toHaveTextContent("/host/home")
})

it("creates and links a project from the settings selector and keeps that link when saving other settings", async () => {
  const f = await setup()
  fireEvent.change(screen.getByRole("combobox", { name: "Projeto" }), { target: { value: "__add_project__" } })
  const dialog = await screen.findByRole("dialog", { name: "Conectar projeto" })
  expect(within(dialog).getByRole("checkbox", { name: /mark/ })).toBeChecked()
  expect(within(dialog).getByRole("checkbox", { name: /mark/ })).toBeDisabled()
  fireEvent.click(within(dialog).getByRole("button", { name: "Escolher pasta" }))
  await waitFor(() =>
    expect(within(dialog).getByLabelText("Pasta do projeto")).toHaveValue("/Users/demo/Documents/reference"),
  )
  fireEvent.change(within(dialog).getByLabelText("Nome do projeto"), { target: { value: "Referência" } })
  fireEvent.click(within(dialog).getByRole("button", { name: "Conectar projeto" }))
  await waitFor(() => expect(f.updateBot).toHaveBeenCalledTimes(1))
  const linkedId = f.updateBot.mock.calls[0]?.[1].projectId
  expect(linkedId).toBeTruthy()
  expect(f.bot.projectId).toBe(linkedId)
  fireEvent.click(within(dialog).getByRole("button", { name: "Fechar diálogo" }))
  save()
  await waitFor(() =>
    expect(f.updateBot).toHaveBeenLastCalledWith(f.bot.id, expect.objectContaining({ projectId: linkedId })),
  )
})

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
