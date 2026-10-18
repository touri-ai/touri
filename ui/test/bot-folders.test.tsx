import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ApiRoutes, Bot } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import App from "../src/App"
import { createWebInvoke, type TauriInvoke } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { BotFolderSettings } from "../src/components/BotFolderSettings"
import { BotCreateModal, BotSettingsModal } from "../src/components/Modals"
import { fullAccessDescription, t } from "../src/i18n"
import type { WorkspaceActions } from "../src/useWorkspace"
import { selectFolder } from "./folder-picker-helpers"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
const setup = async (patch: Partial<Bot> = {}, host?: "mac") => {
  const originalApi = createMockApi()
  const request: typeof originalApi.request = async (route, input, path) => {
    if (route === "GET /health" && host)
      return { ok: true, version: "test", schemaVersion: 1, host, hostKind: host } as ApiRoutes[typeof route]["res"]

    return originalApi.request(route, input, path)
  }
  const api = { ...originalApi, request }
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

it("keeps full local access guidance when saved folder confinement is unavailable", async () => {
  const api = createMockApi()
  const request = api.request
  api.request = (async (route, input, params) => {
    if (route === "GET /folders")
      return { canGrant: false, home: "/workspace", path: "/workspace", parent: null, folders: [], truncated: false }
    return request(route, input, params)
  }) as typeof api.request
  const onFolders = vi.fn()
  await act(async () => {
    render(
      <BotFolderSettings
        api={api}
        fullAccess
        folders={[{ path: "/workspace/reference", access: "read-only" }]}
        anyFolderAccess
        machine="local"
        disabled={false}
        onFolders={onFolders}
        onAnyFolderAccess={vi.fn()}
      />,
    )
  })
  expect(screen.getByText("Pastas salvas para modos de acesso restrito")).toBeVisible()
  expect(screen.getByText(/Elas não limitam o acesso total atual/)).toBeVisible()
  expect(screen.queryByText(/Você pode conversar sem ferramentas/)).not.toBeInTheDocument()
  expect(screen.queryByRole("button", { name: "Remover permissões antigas" })).not.toBeInTheDocument()
  expect(onFolders).not.toHaveBeenCalled()
})

it("offers removing incompatible saved grants without changing them before the user clicks", async () => {
  const api = createMockApi()
  const request = api.request
  api.request = (async (route, input, params) => {
    if (route === "GET /folders")
      return { canGrant: false, home: "/workspace", path: "/workspace", parent: null, folders: [], truncated: false }
    return request(route, input, params)
  }) as typeof api.request
  const onFolders = vi.fn()
  const onAny = vi.fn()
  render(
    <BotFolderSettings
      api={api}
      folders={[{ path: "/workspace/reference", access: "read-only" }]}
      anyFolderAccess
      machine="local"
      disabled={false}
      onFolders={onFolders}
      onAnyFolderAccess={onAny}
    />,
  )
  const remove = await screen.findByRole("button", { name: "Remover permissões antigas" })
  expect(screen.getByText(/Você pode conversar sem ferramentas/)).toBeVisible()
  expect(onFolders).not.toHaveBeenCalled()
  fireEvent.click(remove)
  expect(onFolders).toHaveBeenCalledWith([])
  expect(onAny).toHaveBeenCalledWith(false)
  expect(t("Remover permissões antigas", {}, "en")).toBe("Remove old permissions")
})

it("clears a stale unavailable warning after choosing a folder with restored confinement", async () => {
  const api = createMockApi()
  let canGrant = false
  const request = api.request
  api.request = (async (route, input, params) =>
    route === "GET /folders"
      ? { canGrant, home: "/workspace", path: "/workspace", parent: null, folders: [], truncated: false }
      : request(route, input, params)) as typeof api.request
  const onFolders = vi.fn()
  render(
    <BotFolderSettings
      api={api}
      folders={[{ path: "/workspace/reference", access: "read-only" }]}
      anyFolderAccess={false}
      machine="local"
      disabled={false}
      onFolders={onFolders}
      onAnyFolderAccess={vi.fn()}
    />,
  )
  await screen.findByRole("button", { name: "Remover permissões antigas" })
  canGrant = true
  fireEvent.click(screen.getByRole("button", { name: "Adicionar pasta…" }))
  const picker = await screen.findByRole("dialog", { name: "Pastas no servidor" })
  const use = within(picker).getByRole("button", { name: "Usar esta pasta" })
  await waitFor(() => expect(use).toBeEnabled())
  fireEvent.click(use)
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Remover permissões antigas" })).not.toBeInTheDocument(),
  )
  expect(onFolders).toHaveBeenCalledWith([
    { path: "/workspace/reference", access: "read-only" },
    { path: "/workspace", access: "read-only" },
  ])
  expect(t("Esta pasta fica no servidor.", {}, "en")).toBe("This folder is on the server.")
})

it.each(["codex", "claude", "opencode"] as const)(
  "explains that %s full local access is not limited by saved folder settings during creation",
  (provider) => {
    render(<BotCreateModal onClose={vi.fn()} onCreate={vi.fn()} />)
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Pesquisa" } })
    fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
    fireEvent.change(screen.getByLabelText("Provedor"), { target: { value: provider } })
    fireEvent.change(screen.getByLabelText("Acesso"), { target: { value: "full" } })
    expect(screen.getByText(/O acesso total permite ler/)).toHaveTextContent(
      "As pastas e exclusões salvas não limitam este acesso.",
    )
    expect(screen.getByText(/O acesso total permite ler/)).toHaveTextContent("Não pede aprovações do provedor.")
    expect(screen.getByText(/Acesso total; pode ler e alterar arquivos em qualquer pasta/)).toBeVisible()
    expect(screen.getByText(/Estas opções ficam salvas para modos de acesso restrito/)).toBeVisible()
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
    await setup(
      {
        provider: "codex",
        access: "full",
        approvals,
        folders: [{ path: "/reference", access: "read-only" }],
      },
      "mac",
    )
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
  expect(within(dialog).getByText(/ler arquivos de todo o servidor/)).toBeVisible()
  expect(dialog).toHaveTextContent("conforme o nível de acesso, alterá-los ou apagá-los")
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
  expect(screen.queryByText(/Estas opções ficam salvas para modos de acesso restrito/)).not.toBeInTheDocument()
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

it.each(["read-only", "read-write"] as const)(
  "keeps the selected %s host folder grant when creating a VM bot with a project",
  async (access) => {
    const api = createMockApi()
    const create = vi.fn(async () => {})
    render(
      <BotCreateModal
        api={api}
        invokeCommand={createWebInvoke()}
        capability={{ available: true, provider: "apple-container", reason: null }}
        onCreate={create}
        onClose={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Pesquisa" } })
    fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
    fireEvent.change(screen.getByLabelText("Máquina"), { target: { value: "vm" } })
    fireEvent.change(screen.getByLabelText("Projeto", { selector: "select" }), {
      target: { value: "__add_project__" },
    })
    fireEvent.click(await screen.findByRole("button", { name: "Escolher outra pasta…" }))
    await selectFolder("/workspace/project", access)
    await waitFor(() => expect(screen.getByLabelText("Projeto", { selector: "select" })).not.toHaveValue(""))
    await screen.findByText(/Usa o Codex/)
    fireEvent.click(screen.getByRole("button", { name: "Criar bot" }))
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          machine: "vm",
          projectId: expect.any(String),
          folders: [{ path: "/workspace/project", access }],
          anyFolderAccess: false,
          approvals: "on-request",
        }),
        expect.any(String),
      ),
    )
  },
)

it.each(["read-only", "read-write"] as const)(
  "keeps the selected %s VM project folder grant alongside existing folders when linking and saving",
  async (access) => {
    const existing = { path: "/workspace/reference", access: "read-only" as const }
    const f = await setup({ machine: "vm", folders: [existing] })
    fireEvent.click(screen.getByRole("tab", { name: "Projeto" }))
    fireEvent.change(screen.getByRole("combobox", { name: "Projeto" }), { target: { value: "__add_project__" } })
    const dialog = await screen.findByRole("dialog", { name: "Conectar projeto" })
    fireEvent.click(within(dialog).getByRole("button", { name: "Escolher pasta" }))
    await selectFolder("/workspace/project", access)
    fireEvent.click(within(dialog).getByRole("button", { name: "Conectar projeto" }))
    await waitFor(() =>
      expect(f.updateBot).toHaveBeenCalledWith(f.bot.id, {
        projectId: expect.any(String),
        folders: [existing, { path: "/workspace/project", access }],
      }),
    )
    fireEvent.click(within(dialog).getByRole("button", { name: "Salvar bots" }))
    await waitFor(() => expect(f.updateBot).toHaveBeenCalledTimes(2))
    expect(f.updateBot).toHaveBeenLastCalledWith(f.bot.id, {
      projectId: f.bot.projectId,
      folders: [existing, { path: "/workspace/project", access }],
    })
    fireEvent.click(within(dialog).getByRole("button", { name: "Fechar diálogo" }))
    fireEvent.click(screen.getByRole("tab", { name: "Acesso" }))
    expect(screen.getByLabelText("Acesso à pasta /workspace/project")).toHaveValue(access)
    save()
    await waitFor(() =>
      expect(f.updateBot).toHaveBeenLastCalledWith(
        f.bot.id,
        expect.objectContaining({
          projectId: f.bot.projectId,
          folders: [existing, { path: "/workspace/project", access }],
          anyFolderAccess: false,
          approvals: f.bot.approvals,
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
  expect(await screen.findByText("Qualquer pasta deste servidor")).toBeVisible()
  await act(async () => {
    await api.request("PATCH /bots/:id", { anyFolderAccess: false }, { id: bot.id })
  })
  expect(screen.queryByText("Qualquer pasta deste servidor")).not.toBeInTheDocument()
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
