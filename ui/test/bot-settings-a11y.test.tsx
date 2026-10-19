import { readFileSync } from "node:fs"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { Bot } from "@touri/contracts"
import axe from "axe-core"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { BotSettingsModal } from "../src/components/Modals"
import { MotionPresence } from "../src/components/Motion"
import { BOT_SETTINGS_SECTIONS, type BotSettingsSectionId } from "../src/features/commandPalette/settingsRegistry"
import { t } from "../src/i18n"
import type { WorkspaceActions } from "../src/useWorkspace"

const styles = document.createElement("style")
beforeAll(() => {
  styles.textContent = ["src/design/motion.css", "src/components/settings.css"]
    .map((path) => readFileSync(path, "utf8"))
    .join("\n")
  document.head.append(styles)
})
afterAll(() => styles.remove())
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const botSettings = async (patch: Partial<Bot> = {}, initialSection?: BotSettingsSectionId) => {
  const api = createMockApi()
  const base = api.getState().bots[0]
  if (!base) throw new Error("Missing bot fixture")
  const bot = {
    ...base,
    homeDir: "/workspace/bot",
    folders: [{ path: "/workspace/project", access: "read-write" as const }],
    ...patch,
  }
  const settings = (await api.request("GET /settings", {})).settings
  const projects = (await api.request("GET /projects", {})).projects.map((project) => ({
    ...project,
    path: "/workspace/project",
  }))
  const routine = (await api.request("GET /routines", {})).routines.find((routine) => routine.botId === bot.id)
  if (!routine) throw new Error("Missing routine fixture")
  const botRoutine = { ...routine, name: "Revisar tarefas", enabled: true }
  const routines = [botRoutine]
  const request = api.request
  api.request = (async (route, input, path) => {
    if (route === "GET /bots/:id/grants")
      return { grants: [{ id: "grant-review", botId: bot.id, scope: { source: "mcp", tool: "review" }, grantedAt: 1 }] }
    if (route === "GET /bots/:id/mcp")
      return {
        servers: [
          {
            name: "review",
            transport: "stdio",
            command: "review-tool",
            args: [],
            tools: [
              { name: "review", description: "Revisar tarefas", classification: "reads", policy: "needs_approval" },
            ],
          },
        ],
      }
    return request(route, input, path)
  }) as ApiRequest
  const actions = {
    updateBot: vi.fn(async () => undefined),
    runRoutine: vi.fn(async () => undefined),
    toggleRoutine: vi.fn(async () => undefined),
  }
  const onClose = vi.fn()
  const onOpenRoutines = vi.fn()
  render(
    <MotionPresence show kind="modal">
      <BotSettingsModal
        bot={bot}
        api={api}
        settings={settings}
        projects={projects}
        routines={routines}
        actions={actions as unknown as WorkspaceActions}
        onClose={onClose}
        onOpenRoutines={onOpenRoutines}
        onOpenIntegrations={vi.fn()}
        initialSection={initialSection}
      />
    </MotionPresence>,
  )
  // Only the open pane is mounted, so MCP tools load once their tab is shown.
  if (initialSection === "tools") await screen.findByText("Conexão disponível: review")
  return { bot, routine: botRoutine, actions, onClose, onOpenRoutines }
}

const expectExposed = (control: HTMLElement, checkedAncestors = new Set<HTMLElement>()) => {
  expect(control).toBeVisible()
  expect(control).toHaveAccessibleName()
  expect(control.closest('[hidden], [inert], [aria-hidden="true"]')).toBeNull()
  // jsdom cannot read WebKit's AX tree; retain boxes along the dialog's ancestry too.
  for (let ancestor: HTMLElement | null = control; ancestor; ancestor = ancestor.parentElement) {
    if (checkedAncestors.has(ancestor)) break
    checkedAncestors.add(ancestor)
    expect(getComputedStyle(ancestor).display).not.toBe("contents")
    expect(getComputedStyle(ancestor).visibility).not.toBe("hidden")
  }
}

// WebKit drops every later sibling from the macOS AX tree when a display:none subtree holds a <select>.
const expectNoHiddenSelect = (scope: HTMLElement) => expect(scope.querySelector("[hidden] select")).toBeNull()

const expectNamedControls = (scope: HTMLElement) => {
  expectNoHiddenSelect(scope)
  const queries = within(scope)
  const reachable = [
    "button",
    "tab",
    "textbox",
    "combobox",
    "spinbutton",
    "switch",
    "checkbox",
    "radio",
    "link",
  ].flatMap((role) => queries.queryAllByRole(role, { name: /\S/ }))
  const controls = Array.from(scope.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href]")).filter(
    (control) => !control.closest("[hidden], details:not([open])"),
  )
  expect(controls.length).toBeGreaterThan(0)
  const checkedAncestors = new Set<HTMLElement>()
  for (const control of controls) {
    expectExposed(control, checkedAncestors)
    if (control instanceof HTMLInputElement && control.type === "password") {
      expect(queries.getAllByLabelText(/\S/)).toContain(control)
    } else {
      expect(reachable).toContain(control)
    }
  }
}

const expectNoViolations = async (dialog: HTMLElement) => {
  let violations: axe.Result[] = []
  await act(async () => {
    const result = await axe.run(dialog, {
      // jsdom has no layout or canvas text metrics; browser e2e covers contrast.
      rules: { "color-contrast": { enabled: false } },
    })
    violations = result.violations
  })
  expect(violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) }))).toEqual([])
}

// Full audits include every state, horn and accessory choice in the customizer.
it("keeps every identity control named and exposed, with no axe violations", async () => {
  await botSettings({ provider: "claude" })
  const dialog = screen.getByRole("dialog")
  expect(screen.getByRole("textbox", { name: "Nome" })).toHaveFocus()
  expect(screen.getByRole("textbox", { name: "O que ele faz" })).toBeVisible()
  expect(screen.getByRole("radio", { name: "Chifres Curtos" })).toBeInTheDocument()
  expect(screen.getByRole("radio", { name: "Cor Automática" })).toBeInTheDocument()
  expectNamedControls(dialog)
  await expectNoViolations(dialog)
}, 30_000)

it.each(BOT_SETTINGS_SECTIONS)(
  "keeps $label controls named and exposed, with no axe violations",
  async (section) => {
    if (section.id === "permissions") vi.stubGlobal("__TAURI_INTERNALS__", {})
    await botSettings({ provider: "claude", computerUse: true, mainThreadId: "thread-review" }, section.id)
    const dialog = screen.getByRole("dialog")
    const tab = screen.getByRole("tab", { name: section.label })
    expect(tab).toHaveAttribute("aria-selected", "true")
    const panel = screen.getByRole("tabpanel", { name: section.label })
    expect(panel).toHaveAttribute("id", tab.getAttribute("aria-controls"))
    expect(panel).toHaveAttribute("aria-labelledby", tab.id)
    expect(screen.getAllByRole("tabpanel")).toEqual([panel])
    if (section.id === "access") {
      expect(within(panel).getByRole("combobox", { name: "Acesso à pasta /workspace/project" })).toBeVisible()
      expect(within(panel).getByRole("combobox", { name: "Conta do provedor" })).toBeVisible()
      expect(within(panel).getByRole("switch", { name: /Conectores do claude.ai/ })).toBeVisible()
      fireEvent.click(within(panel).getByRole("button", { name: "Colar token manualmente" }))
      expect(within(panel).getByLabelText("Token OAuth do Claude")).toBeVisible()
    }
    if (section.id === "computer") {
      expect(within(panel).getByRole("combobox", { name: "Navegador do bot" })).toBeVisible()
      expect(within(panel).getByRole("switch", { name: /Navegador habilitado/ })).toHaveAttribute("aria-checked")
    }
    if (section.id === "tools") {
      fireEvent.click(within(panel).getByRole("button", { name: "Configuração técnica (MCP)" }))
      expect(within(panel).getByRole("textbox", { name: "Nome do servidor MCP" })).toBeVisible()
      expect(within(panel).getByRole("combobox", { name: "Política · review" })).toBeVisible()
    }
    if (section.id === "permissions") {
      expect(await within(panel).findByRole("button", { name: "Revogar" })).toBeVisible()
      expect(within(panel).getByRole("combobox", { name: t("For") })).toBeVisible()
      expect(within(panel).getByRole("button", { name: "Permitir controle do computador" })).toBeVisible()
    }
    expectNamedControls(dialog)
    if (section.id === "computer") {
      fireEvent.click(within(panel).getByText("Detalhes técnicos"))
      expectNamedControls(dialog)
    }
    await expectNoViolations(dialog)
  },
  30_000,
)

it("keeps VM environment, host access and browser controls named and exposed", async () => {
  await botSettings({ machine: "vm", browser: "machine" }, "computer")
  const panel = screen.getByRole("tabpanel", { name: "Computador" })
  expect(within(panel).getByRole("spinbutton", { name: "Parar após minutos sem atividade" })).toBeVisible()
  expect(within(panel).getByRole("switch", { name: /Usar meu login/ })).toBeVisible()
  expect(within(panel).getByRole("switch", { name: /Permitir controle da tela deste computador/ })).toBeVisible()
  expect(within(panel).getByRole("combobox", { name: "Navegador do bot" })).toHaveValue("machine")
  expectNamedControls(panel)
  fireEvent.click(within(panel).getByText("Detalhes técnicos"))
  expectNamedControls(panel)
  await expectNoViolations(screen.getByRole("dialog"))
}, 30_000)

it("keeps Cancel and Save in the dialog's accessible tree after expanding and collapsing Advanced", async () => {
  const user = userEvent.setup()
  const { bot, actions, onClose } = await botSettings()
  const dialog = screen.getByRole("dialog")
  const advanced = within(dialog).getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ })
  expect(advanced).toHaveAccessibleName("Avançado Ajustes deste bot")
  for (const expanded of [true, false, true, false]) {
    await user.click(advanced)
    expect(advanced).toHaveAttribute("aria-expanded", String(expanded))
    expectNoHiddenSelect(dialog)
    expectExposed(within(dialog).getByRole("button", { name: "Cancelar", exact: true }))
    expectExposed(within(dialog).getByRole("button", { name: "Salvar configurações" }))
  }
  await user.tab()
  expect(within(dialog).getByRole("button", { name: "Cancelar", exact: true })).toHaveFocus()
  await user.tab()
  expect(within(dialog).getByRole("button", { name: "Salvar configurações" })).toHaveFocus()
  await user.keyboard("{Enter}")
  await waitFor(() =>
    expect(actions.updateBot).toHaveBeenCalledWith(bot.id, expect.objectContaining({ name: bot.name })),
  )
  expect(onClose).toHaveBeenCalledOnce()
}, 30_000)

it("opens the bot routines list directly from the tab by pointer or keyboard", async () => {
  const user = userEvent.setup()
  const { onOpenRoutines } = await botSettings()
  await user.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  const tab = screen.getByRole("tab", { name: "Rotinas" })
  await user.click(tab)
  expect(onOpenRoutines).toHaveBeenCalledOnce()
  act(() => screen.getByRole("tab", { name: "Modelo" }).focus())
  await user.keyboard("{End}")
  expect(onOpenRoutines).toHaveBeenCalledTimes(2)
  expect(tab).toHaveFocus()
}, 30_000)
