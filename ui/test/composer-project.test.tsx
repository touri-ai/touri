import { readFile } from "node:fs/promises"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { Bot, Run } from "@touri/contracts"
import { afterEach, describe, expect, it, vi } from "vitest"
import App from "../src/App"
import type { TauriInvoke } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { t } from "../src/i18n"
import { selectFolder } from "./folder-picker-helpers"

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
  const request = api.request
  // REST responses are snapshots, not aliases of the mock server's live state.
  api.request = (async (route, ...args) => {
    const response = await request(route, ...args)
    return route === "GET /projects" ? structuredClone(response) : response
  }) as typeof api.request
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
  return { api, bot, current, other }
}

const chip = () => screen.getByRole("button", { name: /^Projeto do bot:/ })
const model = () => screen.getByRole("button", { name: /^Escolher modelo:/ })
const picker = () => screen.getByRole("menu", { name: "Projeto do bot" })
const vmNote = "O commit Git do projeto será copiado para /workspace no próximo turno."

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

describe("composer project picker", () => {
  it("keeps selected names wrapping in the phone grid with separate send controls", async () => {
    await setup()
    const composerStyles = await readFile("src/components/Composer.css", "utf8")
    const { container } = render(<style>{composerStyles}</style>)
    const sheet = container.querySelector("style")?.sheet
    const phone = Array.from(sheet?.cssRules ?? [])
      .filter((rule): rule is CSSMediaRule => rule.type === CSSRule.MEDIA_RULE)
      .find((rule) => rule.media.mediaText === "(max-width: 620px)")
    const getStyle = (...selectors: string[]) =>
      Array.from(phone?.cssRules ?? []).find(
        (rule): rule is CSSStyleRule =>
          "selectorText" in rule &&
          rule.selectorText
            .split(",")
            .map((selector) => selector.trim())
            .join(", ") === selectors.join(", "),
      )?.style
    const composer = screen.getByRole("form", { name: "Compor mensagem" })
    const tools = composer.querySelector(".composer-tools-left")
    const modelButton = model()
    const projectButton = chip()
    const sendButton = within(composer).getByRole("button", { name: "Enviar", exact: true })

    const grid = getStyle(".composer-island .composer-tools-left")
    const selection = getStyle(".composer-island .composer-model", ".composer-island .composer-project")
    const control = getStyle(".composer-island .composer-model")
    const label = getStyle(".composer-island .composer-model-name")

    expect(tools).toContainElement(modelButton)
    expect(modelButton.parentElement).toBe(tools)
    expect(projectButton.closest(".composer-project")?.parentElement).toBe(tools)
    expect(projectButton).toHaveClass("composer-model", "composer-project-chip")
    expect(modelButton.querySelector(".composer-model-name")).not.toBeNull()
    expect(projectButton.querySelector(".composer-model-name")).not.toBeNull()
    expect(sendButton.closest(".composer-actions")?.parentElement).toBe(tools?.parentElement)
    expect(tools).not.toContainElement(sendButton)
    expect(grid?.display).toBe("grid")
    expect(grid?.getPropertyValue("grid-template-columns")).toBe("34px minmax(0, 1fr)")
    expect(selection?.getPropertyValue("grid-column")).toBe("2")
    expect(selection?.width).toBe("100%")
    expect(selection?.getPropertyValue("max-width")).toBe("none")
    expect(control?.height).toBe("auto")
    expect(control?.getPropertyValue("min-height")).toBe("34px")
    expect(label?.overflow).toBe("visible")
    expect(label?.getPropertyValue("overflow-wrap")).toBe("anywhere")
    expect(label?.getPropertyValue("text-overflow")).toBe("clip")
    expect(label?.getPropertyValue("white-space")).toBe("normal")
  })

  it("shows the project beside the provider/model in the composer with the bot panel closed", async () => {
    const user = userEvent.setup()
    const { bot, current } = await setup()
    const composer = screen.getByRole("form", { name: "Compor mensagem" })
    const modelButton = within(composer).getByRole("button", { name: /^Escolher modelo:/ })
    const projectButton = chip()
    const visibleSelection = modelButton.querySelector(".composer-model-name")?.textContent ?? ""
    expect(visibleSelection).not.toBe("")
    expect(modelButton).toHaveAttribute("aria-label", `Escolher modelo: ${visibleSelection}`)
    expect(projectButton).toHaveTextContent(current.name)
    expect(projectButton).toHaveAttribute("aria-label", `Projeto do bot: ${current.name}`)
    expect(modelButton.nextElementSibling).toContainElement(projectButton)
    expect(screen.getByRole("button", { name: "Painel do bot" })).toHaveAttribute("aria-expanded", "false")
    await user.click(modelButton)
    const dialog = await screen.findByRole("dialog", { name: "Escolher modelo" })
    expect(within(dialog).getByRole("textbox", { name: "Modelo" })).toHaveValue(bot.model ?? "")
    fireEvent.click(within(dialog).getByRole("button", { name: "Fechar diálogo" }))
    await waitFor(() => expect(dialog).not.toBeInTheDocument())
    await waitFor(() => expect(modelButton).toHaveFocus())
    fireEvent.click(screen.getByRole("button", { name: "Painel do bot" }))
    expect(screen.getAllByRole("button", { name: /^Projeto do bot:/ })).toHaveLength(1)
  })

  it("provides Portuguese and English project labels and next-turn guidance", () => {
    const copy = [
      ["Projeto do bot", "Bot project"],
      ["Sem projeto", "No project"],
      ["Somente pasta do bot", "Bot folder only"],
      ["Adicionar projeto…", "Add project…"],
      [vmNote, "The project's Git commit will be copied to /workspace next turn."],
    ] as const
    for (const [portuguese, english] of copy) {
      expect(t(portuguese, {}, "pt-BR")).toBe(portuguese)
      expect(t(portuguese, {}, "en")).toBe(english)
    }
    expect(t("Project selection label", { name: "Projeto de demonstração" }, "pt-BR")).toBe(
      "Projeto do bot: Projeto de demonstração",
    )
    expect(t("Project selection label", { name: "Demo project" }, "en")).toBe("Bot project: Demo project")
    expect(
      t("Choose model with selection", { selection: "Modelo de demonstração · Padrão do provedor" }, "pt-BR"),
    ).toBe("Escolher modelo: Modelo de demonstração · Padrão do provedor")
    expect(t("Choose model with selection", { selection: "Demo model · Provider default" }, "en")).toBe(
      "Choose model: Demo model · Provider default",
    )
  })

  it("keeps its menu outside the composer while preserving selection and focus return", async () => {
    const user = userEvent.setup()
    const { other } = await setup()
    await user.click(chip())
    expect(picker().closest(".composer-island")).toBeNull()
    expect(picker().closest(".composer-project-picker")?.parentElement).toBe(document.body)
    const focused = document.activeElement
    await user.pointer({
      keys: "[MouseLeft>]",
      target: within(picker()).getByRole("menuitemradio", { name: other.name }),
    })
    expect(document.activeElement).toBe(focused)
    await user.pointer({ keys: "[/MouseLeft]" })
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Projeto do bot" })).toBeNull())
    expect(chip()).toHaveFocus()
    expect(chip()).toHaveTextContent(other.name)
  })

  it.each(["bot-only", "project-first", "bot-first"])(
    "F011: reflects an approved project link across navigation (%s)",
    async (order) => {
      const { api, bot } = await setup({ linked: false })
      const { project } = await api.request("POST /projects", { path: "/tmp/Hodler", name: "Hodler" })
      expect(chip()).toHaveTextContent("Sem projeto")
      const reloads = api.calls.filter((call) => call.route === "GET /projects").length
      if (order === "project-first") act(() => api.emit({ type: "project.created", project }))
      await act(async () => api.emit({ type: "bot.updated", bot: { ...bot, projectId: project.id } }))
      // Observe the fallback independently, before a later project event can mask it.
      if (order !== "project-first") {
        await waitFor(() => expect(chip()).toHaveTextContent("Hodler"))
        expect(api.calls.filter((call) => call.route === "GET /projects").length).toBeGreaterThan(reloads)
      } else {
        expect(api.calls.filter((call) => call.route === "GET /projects")).toHaveLength(reloads)
      }
      if (order === "bot-first") act(() => api.emit({ type: "project.created", project }))
      await waitFor(() => expect(chip()).toHaveTextContent("Hodler"))
      fireEvent.click(screen.getByRole("button", { name: /^onb Operations/ }))
      await screen.findByRole("textbox", { name: "Mensagem para onb" })
      fireEvent.click(screen.getByRole("button", { name: /^mark Campaign/ }))
      await screen.findByRole("textbox", { name: "Mensagem para mark" })
      expect(chip()).toHaveTextContent("Hodler")
      fireEvent.click(chip())
      expect(within(picker()).getByRole("menuitemradio", { name: "Hodler" })).toHaveAttribute("aria-checked", "true")
      expect(within(picker()).getByRole("menuitemradio", { name: /Somente pasta do bot/ })).toHaveAttribute(
        "aria-checked",
        "false",
      )
    },
  )

  it("shows the current project and lists only active projects with the current one checked", async () => {
    const { current, other } = await setup()
    expect(chip()).toHaveTextContent(current.name)
    fireEvent.click(chip())
    expect(within(picker()).getByRole("menuitemradio", { name: current.name })).toHaveAttribute("aria-checked", "true")
    expect(within(picker()).getByRole("menuitemradio", { name: other.name })).toHaveAttribute("aria-checked", "false")
    expect(screen.queryByRole("menuitemradio", { name: "Projeto arquivado" })).not.toBeInTheDocument()
    expect(within(picker()).getByRole("menuitemradio", { name: "Somente pasta do bot" })).toHaveAttribute(
      "aria-checked",
      "false",
    )
    expect(within(picker()).getByRole("menuitem", { name: "Adicionar projeto…" })).toBeVisible()
  })

  it("shows Sem projeto and checks the bot folder when unlinked", async () => {
    await setup({ linked: false })
    expect(chip()).toHaveTextContent("Sem projeto")
    fireEvent.click(chip())
    expect(within(picker()).getByRole("menuitemradio", { name: "Somente pasta do bot" })).toHaveAttribute(
      "aria-checked",
      "true",
    )
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
    fireEvent.click(within(picker()).getByRole("menuitemradio", { name: "Somente pasta do bot" }))
    await waitFor(() => expect(chip()).toHaveTextContent("Sem projeto"))
    expect(api.calls.find((call) => call.route === "PATCH /bots/:id")).toEqual({
      route: "PATCH /bots/:id",
      input: { projectId: null },
      pathValues: { id: bot.id },
    })
  })

  it.each(["queued", "starting", "running"] as const)(
    "locks and closes the picker for a %s turn, then unlocks when it finishes",
    async (status) => {
      const { api, bot } = await setup()
      fireEvent.click(chip())
      const run = { ...activeRun(bot), status }
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
    },
  )

  it("locks for this bot's turns in another thread and stays available for other bots' turns", async () => {
    const { api, bot } = await setup()
    const run = { ...activeRun(bot), threadId: "another-thread" }
    act(() => api.emit({ type: "run.updated", run: { ...run, botId: "bot-onb" } }))
    expect(chip()).toBeEnabled()
    fireEvent.click(chip())
    act(() => api.emit({ type: "run.updated", run }))
    expect(chip()).toBeDisabled()
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    act(() => api.emit({ type: "run.updated", run: { ...run, status: "succeeded", finishedAt: Date.now() } }))
    expect(chip()).toBeEnabled()
  })

  it("supports Tab, Enter, arrow navigation, selection, Escape and focus restoration", async () => {
    const user = userEvent.setup()
    const { current, other } = await setup()
    model().focus()
    await user.tab()
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
    await user.keyboard("{Home}")
    await user.tab({ shift: true })
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    expect(model()).toHaveFocus()
  })

  it.each(["local", "vm"] as const)("shows the snapshot note only for VM bots (%s)", async (machine) => {
    await setup({ machine })
    fireEvent.click(chip())
    if (machine === "vm") expect(screen.getByText(vmNote)).toBeVisible()
    else expect(screen.queryByText(vmNote)).not.toBeInTheDocument()
  })

  it("hides the chip for cloud bots", async () => {
    await setup({ machine: "cloud" })
    expect(screen.queryByRole("button", { name: /^Projeto do bot:/ })).not.toBeInTheDocument()
    expect(screen.queryByText(vmNote)).not.toBeInTheDocument()
  })

  it("reuses project creation and the folder browser, linking the new project to this bot", async () => {
    const invoke = vi.fn(async () => ({ path: "/tmp/new-repo" })) as ReturnType<typeof vi.fn> & TauriInvoke
    const { api, bot } = await setup({ invoke })
    fireEvent.click(chip())
    fireEvent.click(within(picker()).getByRole("menuitem", { name: "Adicionar projeto…" }))
    const dialog = await screen.findByRole("dialog", { name: "Conectar projeto" })
    expect(within(dialog).getByRole("checkbox", { name: /mark/ })).toBeChecked()
    expect(within(dialog).getByRole("checkbox", { name: /mark/ })).toBeDisabled()
    fireEvent.click(within(dialog).getByRole("button", { name: "Escolher pasta" }))
    await selectFolder("/tmp/new-repo", "read-write")
    await waitFor(() => expect(within(dialog).getByLabelText("Pasta do projeto")).toHaveValue("/tmp/new-repo"))
    expect(invoke).not.toHaveBeenCalled()
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
        ? { repositories: [{ path: "/tmp/discovered/Hodler", name: "Hodler", lastModified: 1_000 }] }
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
          call.route === "POST /projects" && "path" in call.input && call.input.path === "/tmp/discovered/Hodler",
      )?.input,
    ).toEqual({ path: "/tmp/discovered/Hodler", name: "Hodler" })
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
    fireEvent.click(within(picker()).getByRole("menuitemradio", { name: "Somente pasta do bot" }))
    expect(chip()).toBeDisabled()
    expect(picker()).toHaveAttribute("aria-busy", "true")
    await act(async () => finish?.())
    await waitFor(() => expect(chip()).toBeEnabled())
    expect(chip()).toHaveTextContent(other.name)
    expect(api.calls.filter((call) => call.route === "PATCH /bots/:id")).toHaveLength(1)
  })
})
