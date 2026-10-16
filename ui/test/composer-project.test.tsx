import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { Bot, Run } from "@touri/contracts"
import { afterEach, describe, expect, it, vi } from "vitest"
import App from "../src/App"
import type { TauriInvoke } from "../src/api/client"
import { createMockApi } from "../src/api/mock"

afterEach(() => vi.restoreAllMocks())

const setup = async ({
  linked = true,
  machine = "local",
  invoke,
}: {
  linked?: boolean
  machine?: Bot["machine"]
  invoke?: TauriInvoke
} = {}) => {
  const api = createMockApi()
  const bot = api.getState().bots[0]
  if (!bot) throw new Error("Missing bot fixture")
  bot.machine = machine
  if (!linked) bot.projectId = null
  const current = (await api.request("GET /projects", {})).projects[0]
  if (!current) throw new Error("Missing project fixture")
  const { project: other } = await api.request("POST /projects", { path: "/tmp/other", name: "Outro projeto" })
  const { project: archived } = await api.request("POST /projects", { path: "/tmp/old", name: "Projeto arquivado" })
  archived.archivedAt = Date.now()
  render(<App kernel={{ services: { api, ...(invoke ? { invoke } : {}) } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  fireEvent.click(screen.getByRole("button", { name: "Painel do bot" }))
  return { api, bot, current, other }
}

const chip = () => screen.getByRole("button", { name: "Projeto do bot" })
const picker = () => screen.getByRole("menu", { name: "Projeto do bot" })
const vmNote = "Commit Git copiado para /workspace no próximo turno."

const activeRun = (bot: Bot): Run => ({
  id: "project-test-run",
  threadId: "thread-mark",
  botId: bot.id,
  provider: bot.provider,
  trigger: "user",
  requestMessageId: "m1",
  replyMessageId: "m2",
  externalTurnId: null,
  status: "running",
  errorClass: null,
  errorMessage: null,
  usage: null,
  routineRunId: null,
  queuedAt: Date.now(),
  startedAt: Date.now(),
  finishedAt: null,
})

describe("advanced project picker", () => {
  it("shows the current project and lists only active projects with the current one checked", async () => {
    const { current, other } = await setup()
    expect(chip()).toHaveTextContent(current.name)
    fireEvent.click(chip())
    expect(within(picker()).getByRole("menuitemradio", { name: current.name })).toHaveAttribute("aria-checked", "true")
    expect(within(picker()).getByRole("menuitemradio", { name: other.name })).toHaveAttribute("aria-checked", "false")
    expect(screen.queryByRole("menuitemradio", { name: "Projeto arquivado" })).not.toBeInTheDocument()
    expect(
      within(picker()).getByRole("menuitemradio", { name: "Nenhum projeto (começa na pasta do bot)" }),
    ).toHaveAttribute("aria-checked", "false")
    expect(within(picker()).getByRole("menuitem", { name: "Adicionar projeto…" })).toBeVisible()
  })

  it("shows Sem projeto and checks the bot folder when unlinked", async () => {
    await setup({ linked: false })
    expect(chip()).toHaveTextContent("Sem projeto")
    fireEvent.click(chip())
    expect(
      within(picker()).getByRole("menuitemradio", { name: "Nenhum projeto (começa na pasta do bot)" }),
    ).toHaveAttribute("aria-checked", "true")
  })

  it("PATCHes the chosen project immediately and updates the chip", async () => {
    const { api, bot, other } = await setup()
    fireEvent.click(chip())
    fireEvent.click(within(picker()).getByRole("menuitemradio", { name: other.name }))
    await waitFor(() => expect(chip()).toHaveTextContent(other.name))
    expect(api.calls.filter((call) => call.route === "PATCH /bots/:id")).toEqual([
      { route: "PATCH /bots/:id", input: { projectId: other.id }, pathValues: { id: bot.id } },
    ])
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument())
    expect(chip()).toHaveFocus()
    fireEvent.click(chip())
    expect(within(picker()).getByRole("menuitemradio", { name: other.name })).toHaveAttribute("aria-checked", "true")
  })

  it("PATCHes null to unlink and updates the chip", async () => {
    const { api, bot } = await setup()
    fireEvent.click(chip())
    fireEvent.click(within(picker()).getByRole("menuitemradio", { name: "Nenhum projeto (começa na pasta do bot)" }))
    await waitFor(() => expect(chip()).toHaveTextContent("Sem projeto"))
    expect(api.calls.find((call) => call.route === "PATCH /bots/:id")).toEqual({
      route: "PATCH /bots/:id",
      input: { projectId: null },
      pathValues: { id: bot.id },
    })
  })

  it("locks and closes the picker when a turn starts, then unlocks when it finishes", async () => {
    const { api, bot } = await setup()
    fireEvent.click(chip())
    const run = activeRun(bot)
    act(() => api.emit({ type: "run.updated", run }))
    expect(chip()).toBeDisabled()
    expect(chip()).toHaveAttribute("title", "Aguarde o turno terminar para alterar o projeto.")
    expect(chip()).toHaveAccessibleDescription("Aguarde o turno terminar para alterar o projeto.")
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    fireEvent.click(chip())
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    expect(api.calls.filter((call) => call.route === "PATCH /bots/:id")).toHaveLength(0)
    act(() => api.emit({ type: "run.updated", run: { ...run, status: "succeeded", finishedAt: Date.now() } }))
    expect(chip()).toBeEnabled()
    fireEvent.click(chip())
    expect(picker()).toBeVisible()
  })

  it("supports Tab, Enter, arrow navigation, selection, Escape and focus restoration", async () => {
    const user = userEvent.setup()
    const { current, other } = await setup()
    chip().focus()
    expect(chip()).toHaveFocus()
    await user.keyboard("{Enter}")
    expect(within(picker()).getByRole("menuitemradio", { name: current.name })).toHaveFocus()
    await user.keyboard("{ArrowDown}")
    expect(within(picker()).getByRole("menuitemradio", { name: other.name })).toHaveFocus()
    await user.keyboard("{Enter}")
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument())
    expect(chip()).toHaveFocus()
    expect(chip()).toHaveTextContent(other.name)
    await user.keyboard(" ")
    expect(picker()).toBeVisible()
    await user.keyboard("{End}")
    expect(within(picker()).getByRole("menuitem", { name: "Adicionar projeto…" })).toHaveFocus()
    await user.keyboard("{Home}")
    expect(within(picker()).getByRole("menuitemradio", { name: current.name })).toHaveFocus()
    await user.keyboard("{ArrowUp}")
    expect(within(picker()).getByRole("menuitem", { name: "Adicionar projeto…" })).toHaveFocus()
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    expect(chip()).toHaveFocus()
  })

  it("dismisses on an outside pointer or focus leaving the picker", async () => {
    const user = userEvent.setup()
    await setup()
    await user.click(chip())
    await user.click(screen.getByRole("textbox", { name: "Mensagem para mark" }))
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    await user.click(chip())
    await user.keyboard("{End}")
    await user.tab()
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Preview do projeto" })).toHaveFocus()
  })

  it.each(["local", "vm"] as const)("shows the snapshot note only for VM bots (%s)", async (machine) => {
    await setup({ machine })
    fireEvent.click(chip())
    if (machine === "vm") expect(screen.getByText(vmNote)).toBeVisible()
    else expect(screen.queryByText(vmNote)).not.toBeInTheDocument()
  })

  it("hides the chip for cloud bots", async () => {
    await setup({ machine: "cloud" })
    expect(screen.queryByRole("button", { name: "Projeto do bot" })).not.toBeInTheDocument()
    expect(screen.queryByText(vmNote)).not.toBeInTheDocument()
  })

  it("reuses project creation and the native folder picker, linking the new project to this bot", async () => {
    const invoke = vi.fn(async () => ({ path: "/tmp/new-repo" })) as ReturnType<typeof vi.fn> & TauriInvoke
    const { api, bot } = await setup({ invoke })
    fireEvent.click(chip())
    fireEvent.click(within(picker()).getByRole("menuitem", { name: "Adicionar projeto…" }))
    const dialog = await screen.findByRole("dialog", { name: "Conectar projeto" })
    expect(within(dialog).getByRole("checkbox", { name: /mark/ })).toBeChecked()
    expect(within(dialog).getByRole("checkbox", { name: /mark/ })).toBeDisabled()
    fireEvent.click(within(dialog).getByRole("button", { name: "Escolher pasta" }))
    await waitFor(() => expect(within(dialog).getByLabelText("Pasta do projeto")).toHaveValue("/tmp/new-repo"))
    expect(invoke).toHaveBeenCalledWith("pick_folder", { title: "Conectar uma pasta de projeto" })
    fireEvent.change(within(dialog).getByLabelText("Nome do projeto"), { target: { value: "Novo repositório" } })
    fireEvent.click(within(dialog).getByRole("button", { name: "Conectar projeto" }))
    await waitFor(() => expect(chip()).toHaveTextContent("Novo repositório"))
    const created = (await api.request("GET /projects", {})).projects.find(
      (project) => project.path === "/tmp/new-repo",
    )
    expect(created).toBeDefined()
    expect(api.calls.filter((call) => call.route === "POST /projects").map((call) => call.input)).toContainEqual({
      path: "/tmp/new-repo",
      name: "Novo repositório",
    })
    expect(api.calls.find((call) => call.route === "PATCH /bots/:id")).toEqual({
      route: "PATCH /bots/:id",
      input: { projectId: created?.id },
      pathValues: { id: bot.id },
    })
    fireEvent.click(within(dialog).getByRole("button", { name: "Fechar diálogo" }))
    await waitFor(() => expect(dialog).not.toBeInTheDocument(), { timeout: 5000 })
    await waitFor(() => expect(chip()).toHaveFocus())
  })

  it("keeps the current project on save failure and allows retry", async () => {
    const { api, current, other } = await setup()
    const request = api.request
    let fail = true
    api.request = (async (route, ...args) => {
      if (route === "PATCH /bots/:id" && fail) throw new Error("Sem conexão")
      return request(route, ...args)
    }) as typeof api.request
    fireEvent.click(chip())
    fireEvent.click(within(picker()).getByRole("menuitemradio", { name: other.name }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível alterar o projeto. Sem conexão")
    expect(chip()).toHaveTextContent(current.name)
    expect(chip()).toBeEnabled()
    fail = false
    fireEvent.click(within(picker()).getByRole("menuitemradio", { name: other.name }))
    await waitFor(() => expect(chip()).toHaveTextContent(other.name))
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("adds a discovered repository and links it from the composer in one click", async () => {
    const invoke = vi.fn() as ReturnType<typeof vi.fn> & TauriInvoke
    const { api, bot } = await setup({ invoke })
    const request = api.request
    api.request = (async (route, ...args) =>
      route === "GET /projects/discover"
        ? { repositories: [{ path: "/Users/demo/javascript/Hodler", name: "Hodler", lastModified: 1_000 }] }
        : request(route, ...args)) as typeof request
    fireEvent.click(chip())
    fireEvent.click(within(picker()).getByRole("menuitem", { name: "Adicionar projeto…" }))
    const dialog = await screen.findByRole("dialog", { name: "Conectar projeto" })
    fireEvent.click(await within(dialog).findByRole("button", { name: /Hodler/ }))
    await waitFor(() => expect(chip()).toHaveTextContent("Hodler"))
    expect(invoke).not.toHaveBeenCalled()
    expect(
      api.calls.find(
        (call) =>
          call.route === "POST /projects" &&
          "path" in call.input &&
          call.input.path === "/Users/demo/javascript/Hodler",
      )?.input,
    ).toEqual({ path: "/Users/demo/javascript/Hodler", name: "Hodler" })
    expect(api.calls.filter((call) => call.route === "PATCH /bots/:id")).toContainEqual({
      route: "PATCH /bots/:id",
      input: { projectId: bot.projectId },
      pathValues: { id: bot.id },
    })
  })

  it("blocks duplicate changes while saving", async () => {
    const { api, other } = await setup()
    const request = api.request
    let finish: (() => void) | undefined
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    api.request = (async (route, ...args) => {
      if (route === "PATCH /bots/:id") await pending
      return request(route, ...args)
    }) as typeof api.request
    fireEvent.click(chip())
    const option = within(picker()).getByRole("menuitemradio", { name: other.name })
    fireEvent.click(option)
    fireEvent.click(option)
    fireEvent.click(within(picker()).getByRole("menuitemradio", { name: "Nenhum projeto (começa na pasta do bot)" }))
    expect(chip()).toBeDisabled()
    expect(picker()).toHaveAttribute("aria-busy", "true")
    await act(async () => finish?.())
    await waitFor(() => expect(chip()).toBeEnabled())
    expect(chip()).toHaveTextContent(other.name)
    expect(api.calls.filter((call) => call.route === "PATCH /bots/:id")).toHaveLength(1)
  })
})
