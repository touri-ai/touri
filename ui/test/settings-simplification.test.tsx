import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { Bot } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import { createMockApi } from "../src/api/mock"
import { BotAccessSummary } from "../src/components/BotAccessSummary"
import { BotPanel } from "../src/components/BotPanel"
import { BotSettingsModal, SettingsModal } from "../src/components/Modals"
import { SecretsPanel } from "../src/components/RightPanels"
import { APP_SETTINGS_SECTIONS, BOT_SETTINGS_SECTIONS, SETTINGS } from "../src/features/commandPalette/settingsRegistry"
import { ComputerGrantCard } from "../src/features/computer"
import { accessLabel, dictionaries, t } from "../src/i18n"
import type { WorkspaceActions } from "../src/useWorkspace"

afterEach(cleanup)

const botSettings = async (patch: Partial<Bot> = {}) => {
  const api = createMockApi()
  const base = api.getState().bots[0]
  if (!base) throw new Error("Missing bot fixture")
  const bot = { ...base, ...patch }
  const settings = (await api.request("GET /settings", {})).settings
  const projects = (await api.request("GET /projects", {})).projects
  const routines = (await api.request("GET /routines", {})).routines
  const updateBot = vi.fn(async () => undefined)
  render(
    <BotSettingsModal
      bot={bot}
      api={api}
      settings={settings}
      projects={projects}
      routines={routines}
      actions={{ updateBot } as unknown as WorkspaceActions}
      onClose={vi.fn()}
      onOpenIntegrations={vi.fn()}
    />,
  )
  return { bot, updateBot }
}

it("opens bot settings with identity, mascot and one access sentence, then reveals exactly seven sections", async () => {
  const { bot, updateBot } = await botSettings()
  expect(screen.getByRole("textbox", { name: "Nome" })).toHaveFocus()
  expect(screen.getByRole("textbox", { name: "O que ele faz" })).toHaveValue(bot.roleLine ?? "")
  expect(screen.getByRole("group", { name: "Mascote", exact: true })).toBeVisible()
  expect(document.querySelector(".bot-settings-overview > .field-help")).toHaveTextContent(`${accessLabel(bot)};`)
  expect(screen.queryByRole("tablist")).toBeNull()
  for (const name of ["Provedor", "Modelo", "Raciocínio", "Acesso", "Máquina", "Projeto", "Instruções"]) {
    expect(screen.queryByRole("combobox", { name })).toBeNull()
    expect(screen.queryByRole("textbox", { name })).toBeNull()
  }
  fireEvent.change(screen.getByRole("textbox", { name: "Nome" }), { target: { value: "Clara" } })
  fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
    "Modelo",
    "Acesso",
    "Computador",
    "Projeto",
    "Ferramentas",
    "Permissões",
    "Rotinas",
  ])
  fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  expect(screen.getByRole("textbox", { name: "Nome" })).toHaveValue("Clara")
  fireEvent.click(screen.getByRole("button", { name: "Salvar configurações" }))
  await waitFor(() =>
    expect(updateBot).toHaveBeenCalledWith(
      bot.id,
      expect.objectContaining({ name: "Clara", approvals: bot.approvals }),
    ),
  )
})

it("keeps common bot settings nearby and technical settings behind a disclosure", async () => {
  await botSettings({ machine: "vm", computerUse: true, mainThreadId: "thread-mark" })
  const checks: Record<string, () => void | Promise<void>> = {
    Modelo: () => {
      expect(screen.getByLabelText("Provedor")).toBeVisible()
      expect(screen.getByRole("button", { name: /^Escolher modelo:/ })).toHaveAccessibleDescription(
        "Deixe em branco para usar o padrão do provedor.",
      )
      expect(screen.getByLabelText("Raciocínio")).toBeVisible()
      expect(screen.getByLabelText("Título (opcional)")).toBeVisible()
      expect(screen.getByLabelText("Instruções do bot")).toBeVisible()
      expect(screen.getByLabelText("Instruções do bot")).toHaveAccessibleDescription(
        "Orientações detalhadas para o bot. Salvas no arquivo SOUL.md na pasta do bot. Vale a partir da próxima mensagem.",
      )
      expect(t("Takes effect from the next message.", {}, "en")).toBe("Takes effect from the next message.")
      expect(screen.getByRole("button", { name: "Excluir bot" })).toBeVisible()
    },
    Acesso: async () => {
      expect(screen.getByRole("combobox", { name: "Acesso" })).toBeVisible()
      expect(await screen.findByLabelText("Acesso a qualquer pasta deste servidor", { exact: false })).toBeVisible()
      expect(screen.getByRole("button", { name: "Adicionar pasta…" })).toBeVisible()
      expect(screen.getByRole("region", { name: "Login do provedor nesta máquina" })).toBeVisible()
      expect(screen.getByRole("heading", { name: "Segredos" })).toBeVisible()
    },
    Computador: () => {
      expect(screen.getByLabelText("Máquina", { exact: true })).toBeVisible()
      expect(screen.getByLabelText("Parar após minutos sem atividade")).toBeVisible()
      expect(screen.getByLabelText(SETTINGS.vmMemory.label)).not.toBeVisible()
      fireEvent.click(screen.getByText("Detalhes técnicos"))
      expect(screen.getByLabelText(SETTINGS.vmMemory.label)).toBeVisible()
      for (const name of [
        /Usar meu login/,
        /Permitir controle da tela deste computador/,
        /Controle do computador/,
        /Navegador habilitado/,
      ]) {
        expect(screen.getByRole("switch", { name })).toBeVisible()
      }
      expect(screen.getByRole("button", { name: "Redefinir" })).toBeVisible()
    },
    Projeto: () => {
      expect(screen.getByRole("combobox", { name: "Projeto" })).toBeVisible()
      expect(screen.getByText("Pasta de trabalho")).toBeVisible()
    },
    Ferramentas: async () => {
      // The raw MCP form now sits behind the technical option; friendly catalog cards come first.
      fireEvent.click(await screen.findByRole("button", { name: "Configuração técnica (MCP)" }))
      for (const name of ["Nome do servidor MCP", "Transporte MCP", "Comando MCP", "Argumentos MCP (lista JSON)"]) {
        expect(screen.getByLabelText(name)).toBeVisible()
      }
      expect(screen.getByRole("button", { name: "Abrir Integrações" })).toBeVisible()
    },
    Permissões: async () => {
      expect(await screen.findByRole("heading", { name: "Permissões permanentes" })).toBeVisible()
      expect(screen.queryByRole("button", { name: "Permitir controle do computador" })).toBeNull()
      expect(
        screen.getByText("Assumir controle não autoriza ações automáticas do bot. Revise essas ações no chat."),
      ).toBeVisible()
    },
    Rotinas: () => {
      expect(screen.getByRole("tabpanel", { name: "Rotinas" })).toBeVisible()
      expect(screen.getAllByRole("button", { name: "Rodar agora" }).length).toBeGreaterThan(0)
      expect(screen.getAllByRole("switch").length).toBeGreaterThan(0)
    },
  }
  for (const [name, check] of Object.entries(checks)) {
    fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
    fireEvent.click(screen.getByRole("tab", { name }))
    await check()
    fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  }
})

it("keeps local provider accounts and connectors in Access within two clicks", async () => {
  await botSettings({ provider: "claude", machine: "local" })
  fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  fireEvent.click(screen.getByRole("tab", { name: "Acesso" }))
  expect(screen.getByRole("combobox", { name: "Conta do provedor" })).toBeVisible()
  expect(screen.getByRole("switch", { name: /Conectores do claude.ai/ })).toBeVisible()
})

it("keeps app sections short and technical settings within their disclosure", async () => {
  const user = userEvent.setup()
  const api = createMockApi()
  render(
    <SettingsModal
      api={api}
      settings={null}
      doctor={{ checks: [] }}
      onRefreshDoctor={vi.fn()}
      onImport={vi.fn()}
      onClose={vi.fn()}
      onSave={vi.fn()}
    />,
  )
  expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
    "Modelos por API",
    "Aparência",
    "Privacidade",
    "Atualizações",
    "Notificações",
    "Diagnóstico",
  ])
  for (const section of APP_SETTINGS_SECTIONS) {
    await user.click(screen.getByRole("tab", { name: section.label }))
    const panel = screen.getByRole("tabpanel", { name: section.label })
    if (section.id === "api-models") {
      expect(await within(panel).findByLabelText("Provedor da API")).toBeVisible()
      continue
    }
    expect(
      [...within(panel).queryAllByRole("switch"), ...within(panel).queryAllByRole("combobox")].filter(
        (control) => !control.closest("details:not([open])"),
      ).length,
    ).toBeLessThanOrEqual(2)
    for (const control of [...within(panel).queryAllByRole("spinbutton"), ...within(panel).queryAllByRole("textbox")])
      expect(control).not.toBeVisible()
  }
  const disclosures: Record<string, string> = {
    appearance: "Chat, barra lateral e atalhos",
    privacy: "Dados, permissões e conexões",
    diagnostics: "Verificar e cuidar deste computador",
  }
  for (const section of APP_SETTINGS_SECTIONS) {
    await user.click(screen.getByRole("tab", { name: section.label }))
    const disclosure = disclosures[section.id]
    if (disclosure) await user.click(screen.getByText(disclosure))
    for (const setting of Object.values(SETTINGS)) {
      if (setting.scope !== "app" || setting.section !== section.id) continue
      if (setting.id === "vmMemory") await user.click(screen.getByText("Detalhes técnicos"))
      expect(document.querySelector(`[data-setting-id="${setting.id}"]`)).toBeVisible()
    }
    if (section.id === "privacy")
      expect(
        screen.getByText(
          "Este servidor não tem uma área de trabalho para controlar. Você pode conversar e trabalhar com arquivos.",
        ),
      ).toBeVisible()
    expect(screen.queryByRole("heading", { name: "Permitir que um bot controle este computador" })).toBeNull()
    if (section.id === "diagnostics") {
      expect(screen.getByRole("button", { name: "Verificar novamente" })).toBeVisible()
      expect(screen.getByRole("region", { name: "Armazenamento" })).toBeVisible()
      expect(screen.getByRole("button", { name: "Importar bots do app anterior" })).toBeVisible()
    }
  }
  await user.click(screen.getByText("Reportar problema"))
  expect(screen.getByLabelText("Título")).toBeVisible()
})

it.each([
  ["read-only", "never"],
  ["workspace-write", "on-request"],
  ["workspace-write", "never"],
  ["full", "on-request"],
  ["full", "never"],
] as const)("uses one label for %s / %s in settings, bot panel and summaries", async (access, approvals) => {
  const api = createMockApi()
  const base = api.getState().bots[0]
  if (!base) throw new Error("Missing bot fixture")
  const bot = { ...base, provider: "claude" as const, access, approvals }
  const label = accessLabel(bot)
  const view = render(<BotAccessSummary {...bot} />)
  expect(view.container).toHaveTextContent(`${label};`)
  view.unmount()
  const panel = render(
    <BotPanel
      api={api}
      bot={bot}
      routines={[]}
      paused={false}
      expanded={false}
      onExpand={vi.fn()}
      onWindow={vi.fn()}
      onClose={vi.fn()}
      onSettings={vi.fn()}
      onRoutines={vi.fn()}
      onPermissions={vi.fn()}
      onRole={vi.fn()}
    />,
  )
  expect(panel.container.querySelector(".field-help")).toHaveTextContent(`${label};`)
  panel.unmount()
  await botSettings({ provider: "claude", access, approvals })
  expect(document.querySelector(".bot-settings-overview > .field-help")).toHaveTextContent(`${label};`)
  fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  fireEvent.click(screen.getByRole("tab", { name: "Acesso" }))
  const selected = screen.getByRole("combobox", { name: "Acesso" }) as HTMLSelectElement
  expect(selected.selectedOptions[0]?.textContent).toBe(label)
})

it("translates the new sections and access labels in Portuguese and English", () => {
  expect(BOT_SETTINGS_SECTIONS.map((section) => section.id)).toEqual([
    "model",
    "access",
    "computer",
    "project",
    "tools",
    "permissions",
    "routines",
  ])
  for (const key of [
    "Aparência",
    "Privacidade",
    "Atualizações",
    "Notificações",
    "Diagnóstico",
    "Modelo",
    "Acesso",
    "Computador",
    "Projeto",
    "Ferramentas",
    "Permissões",
    "Rotinas",
    "O que ele faz",
    "Mascote",
  ] as const) {
    expect(dictionaries.en[key]).not.toBe(dictionaries["pt-BR"][key])
  }
  expect(t("Avançado", {}, "en")).toBe("Advanced")
  expect(accessLabel({ access: "workspace-write", approvals: "on-request" }, "en")).toBe(
    "Asks permission before changing files",
  )
  expect(accessLabel({ access: "full", approvals: "on-request" }, "en")).toBe("Full access with approval")
})

it("keeps labels attached to each secret and computer grant control when settings and chat coexist", () => {
  const api = createMockApi()
  const secretProps = { api, project: null, invokeSecret: vi.fn(async () => true), onNotice: vi.fn() }
  const grantProps = { api, botId: "bot-mark", threadId: "thread-mark" }
  const view = render(
    <>
      <SecretsPanel {...secretProps} />
      <SecretsPanel {...secretProps} />
      <ComputerGrantCard {...grantProps} />
      <ComputerGrantCard {...grantProps} />
    </>,
  )
  for (const panel of view.container.querySelectorAll<HTMLElement>(".secrets-panel")) {
    expect(within(panel).getByRole("textbox", { name: "Nome" })).toBeVisible()
    expect(within(panel).getByLabelText("Valor")).toBeVisible()
  }
  for (const panel of view.container.querySelectorAll<HTMLElement>("aside")) {
    expect(within(panel).getByRole("combobox", { name: t("For") })).toBeVisible()
  }
})
