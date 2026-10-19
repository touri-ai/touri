import type { SettingsIconName } from "../../components/SettingsLayout"
import { t } from "../../i18n"

/**
 * Single source for settings labels. The settings dialogs render these sections and rows,
 * and the command palette indexes the same records, so a label can never drift between them.
 */
export type AppSettingsSectionId =
  | "appearance"
  | "privacy"
  | "updates"
  | "notifications"
  | "diagnostics"
  | "advanced"
  | "api-models"
export type BotSettingsSectionId = "model" | "access" | "computer" | "project" | "tools" | "permissions" | "routines"
export type TouriPage = "cron" | "integracoes" | "mcp" | "work" | "performance"

export type SectionDefinition<Id extends string> = {
  id: Id
  label: string
  description: string
  icon: SettingsIconName
  keywords: Array<string>
}

export const APP_SETTINGS_SECTIONS: ReadonlyArray<SectionDefinition<AppSettingsSectionId>> = [
  {
    id: "api-models",
    label: t("API models"),
    description: t("Choose a provider and use your own API key."),
    icon: "general",
    keywords: ["api", "modelos", "chave", "deepseek", "glm", "openrouter"],
  },
  {
    id: "appearance",
    label: t("Aparência"),
    description: t("Deixe o touri confortável para o seu dia a dia."),
    icon: "appearance",
    keywords: ["visual", "cores", "tema", "barra lateral", "atalhos"],
  },
  {
    id: "privacy",
    label: t("Privacidade"),
    description: t("Seus dados e suas escolhas de acesso."),
    icon: "privacy",
    keywords: ["dados", "permissões", "navegador", "nuvem", "cloud"],
  },
  {
    id: "updates",
    label: t("Atualizações"),
    description: t("Escolha quando procurar novas versões."),
    icon: "general",
    keywords: ["aplicativo", "atualizações", "versão"],
  },
  {
    id: "notifications",
    label: t("Notificações"),
    description: t("Escolha como o touri chama sua atenção."),
    icon: "notifications",
    keywords: ["alertas", "avisos"],
  },
  {
    id: "diagnostics",
    label: t("Diagnóstico"),
    description: t("Cuide deste computador e peça ajuda quando precisar."),
    icon: "report",
    keywords: ["doctor", "armazenamento", "relatório", "bug", "erro", "suporte", "memória", "vm"],
  },
]

export const SERVER_SETTINGS_SECTION: SectionDefinition<AppSettingsSectionId> = {
  id: "advanced",
  label: t("Avançado"),
  description: t("Escolha se os bots trabalham neste computador ou em um servidor touri."),
  icon: "computer",
  keywords: ["servidor", "pareamento", "conexão", "modo local"],
}

export const BOT_SETTINGS_SECTIONS: ReadonlyArray<SectionDefinition<BotSettingsSectionId>> = [
  {
    id: "model",
    label: t("Modelo"),
    description: t("Escolha como este bot pensa e trabalha."),
    icon: "general",
    keywords: ["provedor", "raciocínio", "instruções", "título", "excluir"],
  },
  {
    id: "access",
    label: t("Acesso"),
    description: t("Escolha o que este bot pode acessar."),
    icon: "privacy",
    keywords: ["pastas", "aprovações", "login", "segredos"],
  },
  {
    id: "computer",
    label: t("Computador"),
    description: t("Escolha onde o bot trabalha."),
    icon: "computer",
    keywords: ["máquina", "vm", "navegador", "memória"],
  },
  {
    id: "project",
    label: t("Projeto"),
    description: t("Conecte o trabalho do bot a uma pasta."),
    icon: "shortcuts",
    keywords: ["projeto", "pasta", "cwd"],
  },
  {
    id: "tools",
    label: t("Ferramentas"),
    description: t("Conecte ferramentas e aplicativos a este bot."),
    icon: "mcp",
    keywords: ["mcp", "servidores", "integrações"],
  },
  {
    id: "permissions",
    label: t("Permissões"),
    description: t("Revise as autorizações que você concedeu."),
    icon: "permissions",
    keywords: ["permanentes", "controle do computador", "grants"],
  },
  {
    id: "routines",
    label: t("Rotinas"),
    description: t("Tarefas que este bot faz em horários escolhidos."),
    icon: "routines",
    keywords: ["cron", "agendamento"],
  },
]

export type SettingDefinition = {
  id: string
  label: string
  description: string
  keywords: Array<string>
  /** Element id of the control the palette focuses; the row itself is focused when absent. */
  controlId?: string
} & (
  | { scope: "app"; section: AppSettingsSectionId }
  | { scope: "bot"; section: BotSettingsSectionId }
  | { scope: "doctor" }
)

const setting = <Definition extends SettingDefinition>(definition: Definition): Definition => definition

export const SETTINGS = {
  theme: setting({
    id: "theme",
    scope: "app",
    section: "appearance",
    label: t("Tema"),
    description: t("Escolha um tema ou acompanhe a aparência do sistema."),
    keywords: ["escuro", "claro", "sistema", "dark", "light"],
    controlId: "settings-theme",
  }),
  inlinePreview: setting({
    id: "inlinePreview",
    scope: "app",
    section: "appearance",
    label: t("Mostrar prévia ao vivo no chat"),
    description: t("Acompanhe o navegador e o computador do bot em uma imagem pequena, somente para observar."),
    keywords: ["preview", "miniatura"],
    controlId: "settings-inline-preview",
  }),
  sidebarFloatUpdates: setting({
    id: "sidebarFloatUpdates",
    scope: "app",
    section: "appearance",
    label: t("Mover bots com novidades para o topo"),
    description: t("Bots que precisam de você, estão trabalhando ou têm novidades aparecem primeiro na barra lateral."),
    keywords: ["ordem", "ordenar", "barra lateral", "atividade", "não lidas"],
    controlId: "settings-sidebar-float",
  }),
  shortcutPalette: setting({
    id: "shortcutPalette",
    scope: "app",
    section: "appearance",
    label: t("Buscar e executar comandos"),
    description: t("Encontre bots, conversas, configurações e ações sem sair da tela atual."),
    keywords: ["paleta", "cmd k", "ctrl k", "busca"],
  }),
  shortcutSend: setting({
    id: "shortcutSend",
    scope: "app",
    section: "appearance",
    label: t("Enviar mensagem"),
    description: t("Use Shift + Enter para inserir uma nova linha."),
    keywords: ["enter", "enviar"],
  }),
  telemetry: setting({
    id: "telemetry",
    scope: "app",
    section: "privacy",
    label: t("CLI telemetry"),
    description: t("O touri não envia telemetria. Esta opção controla o provedor local."),
    keywords: ["telemetria", "cli", "provedor"],
    controlId: "settings-telemetry",
  }),
  retention: setting({
    id: "retention",
    scope: "app",
    section: "privacy",
    label: t("Retenção dos detalhes"),
    description: t(
      "Guarde resultados de ferramentas, capturas e raciocínio por este prazo. Depois, os detalhes são resumidos; o texto das conversas permanece. Use 0 para guardar sempre.",
    ),
    keywords: ["dias", "histórico", "armazenamento"],
    controlId: "settings-retention-days",
  }),
  nativeNotifications: setting({
    id: "nativeNotifications",
    scope: "app",
    section: "notifications",
    label: t("System notifications"),
    description: t("Approvals, questions and failures notify you when touri is not in front."),
    keywords: ["notificações", "alertas", "sistema"],
    controlId: "settings-native-notifications",
  }),
  checkForUpdates: setting({
    id: "checkForUpdates",
    scope: "app",
    section: "updates",
    label: t("Check for updates"),
    description: t("Only GitHub Releases; no telemetry."),
    keywords: ["atualização", "versão"],
    controlId: "settings-check-updates",
  }),
  vmMemory: setting({
    id: "vmMemory",
    scope: "app",
    section: "diagnostics",
    label: t("Memória por computador do bot (MiB)"),
    description: t("Limite de RAM ao criar ou atualizar a imagem da VM. Padrão: 1.536 MiB."),
    keywords: ["ram", "vm", "memória", "máquina virtual"],
    controlId: "settings-vm-memory",
  }),
  resumeInterruptedTurns: setting({
    id: "resumeInterruptedTurns",
    scope: "app",
    section: "diagnostics",
    label: t("Retomar turnos interrompidos"),
    description: t(
      "Se o touri reiniciar, o provedor falhar ou o computador do bot parar no meio de uma resposta, o bot continua de onde parou (até 2 vezes por turno).",
    ),
    keywords: ["retomar", "continuar", "reinício", "falha", "interrompido"],
    controlId: "settings-resume-turns",
  }),
  tray: setting({
    id: "tray",
    scope: "app",
    section: "diagnostics",
    label: t("Keep running in tray"),
    description: t("Routines and processes stay supervised when the window closes."),
    keywords: ["bandeja", "segundo plano"],
    controlId: "settings-tray",
  }),
  providerLogin: setting({
    id: "providerLogin",
    scope: "bot",
    section: "access",
    label: t("Login do provedor"),
    description: t("Salve o login do Codex ou do Claude para o computador deste bot."),
    keywords: ["login", "codex", "claude", "token", "oauth", "conta"],
    controlId: "provider-login-source",
  }),
  browserEnabled: setting({
    id: "browserEnabled",
    scope: "bot",
    section: "computer",
    label: t("Browser enabled"),
    description: t("Allow this teammate to use its own browser tabs."),
    keywords: ["navegador", "ativar"],
    controlId: "settings-browser",
  }),
  computerUse: setting({
    id: "computerUse",
    scope: "bot",
    section: "computer",
    label: t("Computer use"),
    description: t("Controle do computador"),
    keywords: ["controle", "computador"],
    controlId: "settings-computer-use",
  }),
  launchAtLogin: setting({
    id: "launchAtLogin",
    scope: "app",
    section: "diagnostics",
    label: t("Launch touri at login"),
    description: t("Keep routines and supervised processes available while the window is closed."),
    keywords: ["inicialização", "login", "abrir"],
    controlId: "doctor-launch-login",
  }),
} as const

export type SettingId = keyof typeof SETTINGS

export type PaletteDestination =
  | { kind: "app-settings"; section: AppSettingsSectionId; settingId?: string }
  | { kind: "bot-settings"; section: BotSettingsSectionId; settingId?: string }
  | { kind: "doctor"; settingId?: string }
  | { kind: "page"; page: TouriPage }

export type SettingsIndexEntry = {
  id: string
  label: string
  detail: string
  keywords: Array<string>
  destination: PaletteDestination
}

const PAGES: ReadonlyArray<{ page: TouriPage; label: string; detail: string; keywords: Array<string> }> = [
  {
    page: "cron",
    label: t("Routines"),
    detail: t("Rotinas agendadas dos bots"),
    keywords: ["cron", "rotinas", "agendamento"],
  },
  {
    page: "integracoes",
    label: t("Integrações"),
    detail: t("Conectar aplicativos aos bots"),
    keywords: ["aplicativos", "conectar", "gmail"],
  },
  {
    page: "mcp",
    label: t("MCP"),
    detail: t("Servidores MCP do bot selecionado"),
    keywords: ["servidores", "ferramentas"],
  },
  {
    page: "work",
    label: t("Work"),
    detail: t("O que os bots estão fazendo agora"),
    keywords: ["trabalho", "tarefas", "fila", "avançado"],
  },
  {
    page: "performance",
    label: t("Performance"),
    detail: t("Como o touri está se saindo"),
    keywords: ["desempenho", "velocidade", "lento", "avançado"],
  },
]

const destinationFor = (definition: SettingDefinition): PaletteDestination => {
  if (definition.scope === "app") return { kind: "app-settings", section: definition.section, settingId: definition.id }
  if (definition.scope === "bot") return { kind: "bot-settings", section: definition.section, settingId: definition.id }
  return { kind: "doctor", settingId: definition.id }
}

/** Palette destination of one registry setting, used by failure cards to deep-link to the fix. */
export const destinationForSetting = (settingId: SettingId): PaletteDestination => destinationFor(SETTINGS[settingId])

const breadcrumb = (definition: SettingDefinition): string => {
  if (definition.scope === "doctor") return t("Doctor")
  if (definition.scope === "bot")
    return `${t("Configurações do bot")} › ${BOT_SETTINGS_SECTIONS.find((section) => section.id === definition.section)?.label ?? ""}`
  return `${t("Preferências")} › ${APP_SETTINGS_SECTIONS.find((section) => section.id === definition.section)?.label ?? ""}`
}

/** Every searchable settings destination, derived from the registry above. */
export const settingsIndex = ({ hasBot }: { hasBot: boolean }): Array<SettingsIndexEntry> => [
  ...[
    ...APP_SETTINGS_SECTIONS,
    ...(typeof window !== "undefined" && "__TAURI_INTERNALS__" in window ? [SERVER_SETTINGS_SECTION] : []),
  ].map((section) => ({
    id: `app-section:${section.id}`,
    label: section.label,
    detail: `${t("Preferências")} · ${section.description}`,
    keywords: [...section.keywords, "preferências", "configurações"],
    destination: { kind: "app-settings", section: section.id } as const,
  })),
  ...(hasBot
    ? BOT_SETTINGS_SECTIONS.map((section) => ({
        id: `bot-section:${section.id}`,
        label: t("{section} do bot", { section: section.label }),
        detail: t("Configurações do bot selecionado"),
        keywords: [...section.keywords, "bot", "configurações"],
        destination: { kind: "bot-settings", section: section.id } as const,
      }))
    : []),
  ...Object.values(SETTINGS)
    .filter((definition: SettingDefinition) => definition.scope !== "bot" || hasBot)
    .map((definition: SettingDefinition) => ({
      id: `setting:${definition.id}`,
      label: definition.label,
      detail: breadcrumb(definition),
      keywords: [...definition.keywords, definition.description],
      destination: destinationFor(definition),
    })),
  {
    id: "doctor",
    label: `${t("Doctor")} (Doctor)`,
    detail: t("Verifique o ambiente local do touri"),
    keywords: ["doctor", "diagnóstico", "verificar", "saúde"],
    destination: { kind: "doctor" },
  },
  ...PAGES.map((page) => ({
    id: `page:${page.page}`,
    label: page.label,
    detail: page.detail,
    keywords: page.keywords,
    destination: { kind: "page", page: page.page } as const,
  })),
]
