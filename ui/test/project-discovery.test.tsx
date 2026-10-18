import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { Bot, DiscoveredProject } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import type { TauriInvoke } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { BotAccessSummary } from "../src/components/BotAccessSummary"
import { DiscoveredProjects } from "../src/components/DiscoveredProjects"
import { BotCreateModal, BotSettingsModal } from "../src/components/Modals"
import { t } from "../src/i18n"
import type { WorkspaceActions } from "../src/useWorkspace"
import { selectFolder } from "./folder-picker-helpers"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const repositories: DiscoveredProject[] = [
  { path: "/Users/demo/javascript/Hodler", name: "Hodler", lastModified: 2_000 },
  { path: "/Users/demo/code/older", name: "older", lastModified: 1_000 },
]
const discoveryApi = () => {
  const api = createMockApi()
  const request = api.request
  api.request = (async (route, ...args) =>
    route === "GET /projects/discover" ? { repositories } : request(route, ...args)) as typeof request
  return api
}
const creation = async () => {
  const api = discoveryApi()
  const create = vi.fn(async () => undefined)
  const createProject = vi.fn(
    async (input: Parameters<WorkspaceActions["createProject"]>[0]) =>
      (await api.request("POST /projects", input)).project,
  )
  const invoke = vi.fn(async () => ({ path: "/workspace/reference" })) as ReturnType<typeof vi.fn> & TauriInvoke
  render(
    <BotCreateModal
      api={api}
      invokeCommand={invoke}
      onClose={vi.fn()}
      onCreate={create}
      onCreateProject={createProject}
      capability={{ available: true, provider: "apple-container", reason: null }}
    />,
  )
  fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Pesquisa" } })
  fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  await screen.findByText(/Usa o Codex/)
  return { api, create, createProject, invoke }
}

it("creation persists folder permissions, broad access and a discovered project on create", async () => {
  const f = await creation()
  expect(screen.getByRole("option", { name: "Nenhum projeto (começa na pasta do bot)" })).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Adicionar pasta…" }))
  await selectFolder("/workspace/reference", "read-only")
  const folder = await screen.findByRole("combobox", { name: "Acesso à pasta /workspace/reference" })
  expect(folder).toHaveValue("read-only")
  fireEvent.change(folder, { target: { value: "read-write" } })
  fireEvent.click(screen.getByRole("switch", { name: /Acesso a qualquer pasta deste servidor/ }))
  fireEvent.click(
    within(screen.getByRole("dialog", { name: "Permitir acesso a qualquer pasta?" })).getByRole("button", {
      name: "Permitir acesso",
    }),
  )
  fireEvent.change(screen.getByLabelText("Projeto", { selector: "select" }), { target: { value: "__add_project__" } })
  const options = await screen.findAllByRole("button", { name: /Hodler|older/ })
  expect(options.map((button) => button.textContent)).toEqual([
    "Hodler/Users/demo/javascript/Hodler",
    "older/Users/demo/code/older",
  ])
  fireEvent.click(options[0] as HTMLElement)
  await waitFor(() => expect(screen.getByLabelText("Projeto", { selector: "select" })).not.toHaveValue(""))
  expect(f.invoke).not.toHaveBeenCalled()
  expect(f.createProject).toHaveBeenCalledWith({ path: "/Users/demo/javascript/Hodler", name: "Hodler" })
  expect(f.create).not.toHaveBeenCalled()
  const project = (await f.api.request("GET /projects", {})).projects.find(
    (item) => item.path === repositories[0]?.path,
  )
  expect(project).toBeDefined()
  expect(screen.getByRole("option", { name: "Hodler" })).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))

  expect(await screen.findByRole("switch", { name: /Acesso a qualquer pasta deste servidor/ })).toBeChecked()
  expect(screen.getByLabelText("Acesso à pasta /workspace/reference")).toHaveValue("read-write")
  fireEvent.click(screen.getByRole("button", { name: "Criar bot" }))
  await waitFor(() =>
    expect(f.create).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: project?.id,
        folders: [{ path: "/workspace/reference", access: "read-write" }],
        anyFolderAccess: true,
      }),
      expect.stringMatching(/^draft-/),
    ),
  )
})

it("creation offers the folder picker fallback and removes draft folders before creation", async () => {
  const f = await creation()
  fireEvent.change(screen.getByLabelText("Projeto", { selector: "select" }), { target: { value: "__add_project__" } })
  fireEvent.click(await screen.findByRole("button", { name: "Escolher outra pasta…" }))
  await selectFolder("/workspace/project", "read-write")
  await waitFor(() => expect(screen.getByLabelText("Projeto", { selector: "select" })).not.toHaveValue(""))
  expect(f.invoke).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "Adicionar pasta…" }))
  await selectFolder("/workspace/reference", "read-only")
  fireEvent.click(await screen.findByRole("button", { name: "Remover pasta /workspace/reference" }))
  fireEvent.click(screen.getByRole("button", { name: "Criar bot" }))
  await waitFor(() =>
    expect(f.create).toHaveBeenCalledWith(
      expect.objectContaining({ folders: [], anyFolderAccess: false }),
      expect.any(String),
    ),
  )
})

it("creation access summary follows VM mounts and read-only access", async () => {
  const f = await creation()
  fireEvent.change(screen.getByLabelText("Máquina"), { target: { value: "vm" } })
  expect(screen.getByText("Pede permissão antes de mudar arquivos; só no computador isolado.")).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "Adicionar pasta…" }))
  await selectFolder("/workspace/reference", "read-only")
  await screen.findByLabelText("Acesso à pasta /workspace/reference")
  expect(
    screen.getByText("Pede permissão antes de mudar arquivos; só no computador isolado e nas pastas compartilhadas."),
  ).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  fireEvent.change(screen.getByLabelText("Acesso", { selector: "select" }), { target: { value: "read-only" } })
  expect(screen.getByText("Somente leitura; só no computador isolado e nas pastas compartilhadas.")).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "Criar bot" }))
  await waitFor(() =>
    expect(f.create).toHaveBeenCalledWith(
      expect.objectContaining({
        machine: "vm",
        access: "read-only",
        folders: [{ path: "/workspace/reference", access: "read-only" }],
      }),
      expect.any(String),
    ),
  )
})

it.each([
  [
    "local",
    "workspace-write",
    "Pede permissão antes de mudar arquivos; alterações ficam na pasta do bot, no projeto e nas pastas liberadas.",
  ],
  ["local", "read-only", "Somente leitura; pode ler arquivos no servidor, sem alterá-los."],
  ["vm", "full", "Acesso total; só no computador isolado."],
] as const)("creation keeps the %s/%s summary visible with Advanced closed", async (machine, access, summary) => {
  await creation()
  fireEvent.change(screen.getByLabelText("Máquina"), { target: { value: machine } })
  fireEvent.change(screen.getByLabelText("Acesso", { selector: "select" }), { target: { value: access } })
  fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  expect(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ })).toHaveAttribute(
    "aria-expanded",
    "false",
  )
  expect(screen.getByText(summary)).toBeVisible()
})

it("creation summary reflects Codex approvals after switching from full access with approval", async () => {
  const f = await creation()
  fireEvent.change(screen.getByLabelText("Provedor"), { target: { value: "claude" } })
  fireEvent.change(screen.getByLabelText("Acesso", { selector: "select" }), { target: { value: "full-approved" } })
  expect(screen.getByText(/^Acesso total com aprovação;/)).toBeVisible()
  fireEvent.change(screen.getByLabelText("Provedor"), { target: { value: "codex" } })
  expect(screen.getByLabelText("Acesso", { selector: "select" })).toHaveValue("full")
  expect(screen.queryByText(/^Acesso total com aprovação;/)).not.toBeInTheDocument()
  expect(screen.getByText(/^Acesso total;/)).toBeVisible()
  await screen.findByText(/Usa o Codex/)
  fireEvent.click(screen.getByRole("button", { name: "Criar bot" }))
  await waitFor(() =>
    expect(f.create).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "codex", access: "full", approvals: "never" }),
      expect.any(String),
    ),
  )
})

it("settings adds and links a discovered repository in one click without the folder picker", async () => {
  const api = discoveryApi()
  const bot = api.getState().bots[0]
  if (!bot) throw new Error("Missing bot")
  const updateBot = vi.fn(async (id, input) => {
    await api.request("PATCH /bots/:id", input, { id })
  })
  const invoke = vi.fn() as ReturnType<typeof vi.fn> & TauriInvoke
  const actions = {
    updateBot,
    createProject: async (input) => (await api.request("POST /projects", input)).project,
  } as WorkspaceActions
  render(
    <BotSettingsModal
      bot={bot}
      projects={[]}
      routines={[]}
      api={api}
      invokeCommand={invoke}
      actions={actions}
      onClose={vi.fn()}
      initialSection="project"
    />,
  )
  fireEvent.change(screen.getByLabelText("Projeto", { selector: "select" }), { target: { value: "__add_project__" } })
  const dialog = screen.getByRole("dialog", { name: "Conectar projeto" })
  fireEvent.click(await within(dialog).findByRole("button", { name: /Hodler/ }))
  await waitFor(() => expect(updateBot).toHaveBeenCalledWith(bot.id, { projectId: expect.any(String) }))
  expect(invoke).not.toHaveBeenCalled()
})

it("failed discovery keeps the manual folder fallback available", async () => {
  const api = discoveryApi()
  api.request = vi.fn().mockRejectedValue(new Error("Offline"))
  const choose = vi.fn(async () => undefined)
  render(<DiscoveredProjects api={api} onSelect={vi.fn()} onChooseFolder={choose} />)
  expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível buscar repositórios")
  fireEvent.click(screen.getByRole("button", { name: "Escolher outra pasta…" }))
  await waitFor(() => expect(choose).toHaveBeenCalledOnce())
})

it("a failed project link can be retried with a different discovered repository", async () => {
  const api = discoveryApi()
  const bot = api.getState().bots[0]
  if (!bot) throw new Error("Missing bot")
  const updateBot = vi
    .fn()
    .mockRejectedValueOnce(new Error("Máquina ocupada"))
    .mockImplementation(async (id, input) => {
      await api.request("PATCH /bots/:id", input, { id })
    })
  const actions = {
    updateBot,
    createProject: async (input) => (await api.request("POST /projects", input)).project,
  } as WorkspaceActions
  render(
    <BotSettingsModal
      bot={bot}
      projects={[]}
      routines={[]}
      api={api}
      invokeCommand={vi.fn()}
      actions={actions}
      onClose={vi.fn()}
      initialSection="project"
    />,
  )
  fireEvent.change(screen.getByLabelText("Projeto", { selector: "select" }), { target: { value: "__add_project__" } })
  const dialog = screen.getByRole("dialog", { name: "Conectar projeto" })
  fireEvent.click(await within(dialog).findByRole("button", { name: /Hodler/ }))
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("Máquina ocupada")
  fireEvent.click(within(dialog).getByRole("button", { name: /older/ }))
  await waitFor(() => expect(updateBot).toHaveBeenCalledTimes(2))
  const project = (await api.request("GET /projects", {})).projects.find((item) => item.name === "older")
  expect(project).toBeDefined()
  expect(updateBot).toHaveBeenLastCalledWith(bot.id, { projectId: project?.id })
})

it("a failed add can be retried and duplicate clicks cannot add the repository twice", async () => {
  let finish: (() => void) | undefined
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  const select = vi
    .fn()
    .mockRejectedValueOnce(new Error("Não foi possível conectar"))
    .mockImplementationOnce(() => pending)
  render(<DiscoveredProjects api={discoveryApi()} onSelect={select} />)
  const button = await screen.findByRole("button", { name: /Hodler/ })
  fireEvent.click(button)
  expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível conectar")
  fireEvent.click(button)
  fireEvent.click(button)
  expect(button).toBeDisabled()
  expect(select).toHaveBeenCalledTimes(2)
  await act(async () => finish?.())
  expect(button).toBeEnabled()
})

it.each([
  [
    { machine: "local", access: "full", approvals: "never", anyFolderAccess: true },
    "Acesso total; pode ler e alterar arquivos em qualquer pasta que a conta do sistema permita.",
  ],
  [
    { machine: "local", access: "full", approvals: "on-request" },
    "Acesso total com aprovação; pode ler e alterar arquivos em qualquer pasta que a conta do sistema permita.",
  ],
  [
    { machine: "local", access: "workspace-write", approvals: "never", anyFolderAccess: true },
    "Pode mudar arquivos nas pastas permitidas; pode acessar arquivos em todo o Mac; as exclusões de pastas sensíveis continuam valendo.",
  ],
  [
    { machine: "local", access: "workspace-write", approvals: "never" },
    "Pode mudar arquivos nas pastas permitidas; alterações ficam na pasta do bot, no projeto e nas pastas liberadas.",
  ],
  [
    { machine: "local", access: "read-only", approvals: "never" },
    "Somente leitura; pode ler arquivos no Mac, sem alterá-los.",
  ],
  [{ machine: "cloud", access: "full", approvals: "never" }, "Acesso total; só na máquina na nuvem."],
] as const)("access summary reflects %o", (input, expected) => {
  render(
    <BotAccessSummary host="mac" {...(input as Pick<Bot, "machine" | "access" | "approvals" | "anyFolderAccess">)} />,
  )
  expect(screen.getByText(expected)).toBeVisible()
})

it("localizes the no-project label in both languages", () => {
  expect(t("Nenhum projeto (começa na pasta do bot)")).toBe("Nenhum projeto (começa na pasta do bot)")
  expect(t("Nenhum projeto (começa na pasta do bot)", {}, "en")).toBe("No project (starts in the bot folder)")
})
