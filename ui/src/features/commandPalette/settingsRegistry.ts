import type { SettingsIconName } from "../../components/SettingsLayout"
import { t } from "../../i18n"

/**
 * Single source for settings labels. The settings dialogs render these sections and rows,
 * and the command palette indexes the same records, so a label can never drift between them.
 */
export type AppSettingsSectionId =
  | "appearance"
  | "shortcuts"
  | "privacy"
  | "notifications"
  | "general"
  | "cloud"
  | "report"
export type BotSettingsSectionId = "general" | "computer" | "permissions" | "mcp" | "routines"
export type TouriPage = "cron" | "integracoes" | "mcp"

export type SectionDefinition<Id extends string> = {
  id: Id
  label: string
  description: string
  icon: SettingsIconName
  keywords: Array<string>
}

export const APP_SETTINGS_SECTIONS: ReadonlyArray<SectionDefinition<AppSettingsSectionId>> = [
  {
    id: "appearance",
    label: "Aparência",
    description: "Deixe o touri confortável para o seu dia a dia.",
    icon: "appearance",
    keywords: ["visual", "cores", "tema", "barra lateral"],
  },
  {
    id: "shortcuts",
    label: "Atalhos",
    description: "Ações rápidas para navegar e interromper o controle do computador.",
    icon: "shortcuts",
    keywords: ["teclado", "atalho", "tecla"],
  },
  {
    id: "privacy",
    label: "Privacidade",
    description: "Controle as preferências locais e as permissões do sistema.",
    icon: "privacy",
    keywords: ["dados", "permissões", "navegador"],
  },
  {
    id: "notifications",
    label: "Notificações",
    description: "Escolha como o touri chama sua atenção quando está em segundo plano.",
    icon: "notifications",
    keywords: ["alertas", "avisos"],
  },
  {
    id: "general",
    label: "Geral",
    description: "Atualizações e funcionamento do aplicativo.",
    icon: "general",
    keywords: ["aplicativo", "atualizações", "vm"],
  },
  {
    id: "cloud",
    label: "Nuvem",
    description: "Hospedagem opcional para seus bots.",
    icon: "cloud",
    keywords: ["cloud", "hospedagem"],
  },
  {
    id: "report",
    label: "Reportar problema",
    description: "Prepare um relatório, revise o conteúdo e escolha como compartilhar.",
    icon: "report",
    keywords: ["bug", "erro", "suporte", "relatório"],
  },
]

export const BOT_SETTINGS_SECTIONS: ReadonlyArray<SectionDefinition<BotSettingsSectionId>> = [
  {
    id: "general",
    label: "Geral",
    description: "Identidade, provedor e instruções para as próximas conversas.",
    icon: "general",
    keywords: ["nome", "instruções", "modelo", "provedor"],
  },
  {
    id: "computer",
    label: "Computador",
    description: "Escolha o ambiente de trabalho e cuide da máquina deste bot.",
    icon: "computer",
    keywords: ["máquina", "vm", "navegador"],
  },
  {
    id: "permissions",
    label: "Permissões",
    description: "Revise o acesso e as autorizações deste bot.",
    icon: "permissions",
    keywords: ["acesso", "aprovações"],
  },
  {
    id: "mcp",
    label: "MCP",
    description: "Conecte ferramentas e integrações somente a este bot.",
    icon: "mcp",
    keywords: ["servidores", "ferramentas"],
  },
  {
    id: "routines",
    label: "Rotinas",
    description: "Tarefas agendadas e execuções pontuais deste bot.",
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
    label: "Tema",
    description: "Escolha um tema ou acompanhe a aparência do sistema.",
    keywords: ["escuro", "claro", "sistema", "dark", "light"],
    controlId: "settings-theme",
  }),
  inlinePreview: setting({
    id: "inlinePreview",
    scope: "app",
    section: "appearance",
    label: "Mostrar prévia ao vivo no chat",
    description: "Acompanhe o navegador e o computador do bot em uma imagem pequena, somente para observar.",
    keywords: ["preview", "miniatura"],
    controlId: "settings-inline-preview",
  }),
  sidebarFloatUpdates: setting({
    id: "sidebarFloatUpdates",
    scope: "app",
    section: "appearance",
    label: "Mover bots com novidades para o topo",
    description: "Bots que precisam de você, estão trabalhando ou têm novidades aparecem primeiro na barra lateral.",
    keywords: ["ordem", "ordenar", "barra lateral", "atividade", "não lidas"],
    controlId: "settings-sidebar-float",
  }),
  shortcutPalette: setting({
    id: "shortcutPalette",
    scope: "app",
    section: "shortcuts",
    label: "Buscar e executar comandos",
    description: "Encontre bots, conversas, configurações e ações sem sair da tela atual.",
    keywords: ["paleta", "cmd k", "ctrl k", "busca"],
  }),
  shortcutSend: setting({
    id: "shortcutSend",
    scope: "app",
    section: "shortcuts",
    label: "Enviar mensagem",
    description: "Use Shift + Enter para inserir uma nova linha.",
    keywords: ["enter", "enviar"],
  }),
  telemetry: setting({
    id: "telemetry",
    scope: "app",
    section: "privacy",
    label: t("CLI telemetry"),
    description: "O touri não envia telemetria. Esta opção controla o provedor local.",
    keywords: ["telemetria", "cli", "provedor"],
    controlId: "settings-telemetry",
  }),
  retention: setting({
    id: "retention",
    scope: "app",
    section: "privacy",
    label: "Retenção dos detalhes",
    description:
      "Guarde resultados de ferramentas, capturas e raciocínio por este prazo. Depois, os detalhes são resumidos; o texto das conversas permanece. Use 0 para guardar sempre.",
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
    section: "general",
    label: t("Check for updates"),
    description: t("Only GitHub Releases; no telemetry."),
    keywords: ["atualização", "versão"],
    controlId: "settings-check-updates",
  }),
  vmMemory: setting({
    id: "vmMemory",
    scope: "app",
    section: "general",
    label: "Memória por computador do bot (MiB)",
    description: "Limite de RAM ao criar ou atualizar a imagem da VM. Padrão: 1.536 MiB.",
    keywords: ["ram", "vm", "memória", "máquina virtual"],
    controlId: "settings-vm-memory",
  }),
  resumeInterruptedTurns: setting({
    id: "resumeInterruptedTurns",
    scope: "app",
    section: "general",
    label: "Retomar turnos interrompidos",
    description:
      "Se o touri reiniciar, o provedor falhar ou o computador do bot parar no meio de uma resposta, o bot continua de onde parou (até 2 vezes por turno).",
    keywords: ["retomar", "continuar", "reinício", "falha", "interrompido"],
    controlId: "settings-resume-turns",
  }),
  tray: setting({
    id: "tray",
    scope: "app",
    section: "general",
    label: t("Keep running in tray"),
    description: t("Routines and processes stay supervised when the window closes."),
    keywords: ["bandeja", "segundo plano"],
    controlId: "settings-tray",
  }),
  providerLogin: setting({
    id: "providerLogin",
    scope: "bot",
    section: "computer",
    label: "Login do provedor",
    description: "Salve o login do Codex ou do Claude para o computador deste bot.",
    keywords: ["login", "codex", "claude", "token", "oauth", "conta"],
    controlId: "provider-login-source",
  }),
  launchAtLogin: setting({
    id: "launchAtLogin",
    scope: "doctor",
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
  { page: "cron", label: "Cron", detail: "Rotinas agendadas dos bots", keywords: ["rotinas", "agendamento"] },
  {
    page: "integracoes",
    label: "Integrações",
    detail: "Conectar aplicativos aos bots",
    keywords: ["aplicativos", "conectar", "gmail"],
  },
  { page: "mcp", label: "MCP", detail: "Servidores MCP do bot selecionado", keywords: ["servidores", "ferramentas"] },
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
    return `Configurações do bot › ${BOT_SETTINGS_SECTIONS.find((section) => section.id === definition.section)?.label ?? ""}`
  return `Preferências › ${APP_SETTINGS_SECTIONS.find((section) => section.id === definition.section)?.label ?? ""}`
}

/** Every searchable settings destination, derived from the registry above. */
export const settingsIndex = ({
  cloudEnabled,
  hasBot,
}: {
  cloudEnabled: boolean
  hasBot: boolean
}): Array<SettingsIndexEntry> => [
  ...APP_SETTINGS_SECTIONS.filter((section) => section.id !== "cloud" || cloudEnabled).map((section) => ({
    id: `app-section:${section.id}`,
    label: section.label,
    detail: section.id === "report" ? "Preferências" : `Preferências · ${section.description}`,
    keywords: [...section.keywords, "preferências", "configurações"],
    destination: { kind: "app-settings", section: section.id } as const,
  })),
  ...(hasBot
    ? BOT_SETTINGS_SECTIONS.map((section) => ({
        id: `bot-section:${section.id}`,
        label: `${section.label} do bot`,
        detail: "Configurações do bot selecionado",
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
    detail: "Verifique o ambiente local do touri",
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
