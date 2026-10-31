import type {
  AgentImportProgress,
  AgentImportResult,
  AgentImportSource,
  AvatarMood,
  Bot,
  BotGroup,
} from "@touri/contracts"
import { getApiModelReference } from "@touri/contracts"
import type { UiApi } from "../../api/client"
import { type TranslationKey, t } from "../../i18n"
import { saveWorkspaceState } from "../../workspaceState"

export type GuideStep =
  | "workspace"
  | "context"
  | "sources"
  | "manual"
  | "review"
  | "importing"
  | "computer"
  | "agents"
  | "team"
  | "task"
  | "ready"
export type WorkspaceDraft = { name: string; color: string; context: string; website: string; topics: string[] }
export type ComputerDraft = {
  browserEnabled: boolean
  access: Bot["access"]
  approvals: Bot["approvals"]
  machine: Bot["machine"]
  machineIdleMinutes: number
  vmProviderLogin: boolean
  hostComputerUse: boolean
}
export const guideBot = {
  id: "onboarding-touri",
  name: "touri",
  color: "#dc2626",
  avatarSeed: "touri",
  avatarShape: "classic-none" as const,
}
export const guideStages: TranslationKey[] = [
  "ob.workspace",
  "ob.context",
  "ob.sources",
  "ob.computer",
  "ob.agents",
  "ob.team",
  "ob.task",
]
export const topicOptions = [
  { id: "support", label: "ob.support", channel: "suporte" },
  { id: "code", label: "ob.code", channel: "dev" },
  { id: "sales", label: "ob.sales", channel: "vendas" },
  { id: "finance", label: "ob.finance", channel: "financeiro" },
  { id: "marketing", label: "ob.marketing", channel: "marketing" },
  { id: "operations", label: "ob.operations", channel: "operacoes" },
] as const satisfies ReadonlyArray<{ id: string; label: TranslationKey; channel: string }>
export const getStage = (step: GuideStep): number => {
  if (step === "workspace") return 0
  if (step === "context") return 1
  if (["sources", "manual", "review", "importing"].includes(step)) return 2
  if (step === "computer") return 3
  if (step === "agents") return 4
  if (step === "team") return 5
  return 6
}
export const getGuideMood = (step: GuideStep, failed: boolean, importing: boolean): AvatarMood => {
  if (failed) return "failed"
  if (importing) return "working"
  if (step === "ready") return "responded"
  return "idle"
}
export const getSourceLabel = (source: Pick<AgentImportSource, "kind">): string => {
  if (source.kind === "claude-code") return "Claude Code"
  return t(source.kind === "folder" ? "ob.folderSource" : "ob.manualSource")
}
export const getChannels = (topics: string[]): string[] => [
  "geral",
  ...topicOptions.filter((topic) => topics.includes(topic.id)).map((topic) => topic.channel),
]
export const getToggle = (values: string[], value: string): string[] =>
  values.includes(value) ? values.filter((item) => item !== value) : [...values, value]
export const getImportProgress = (event: unknown): AgentImportProgress | null => {
  if (!event || typeof event !== "object") return null
  const record = "progress" in event ? event.progress : event
  if (!record || typeof record !== "object") return null
  if (!("importId" in record && "agentKey" in record && "step" in record && "done" in record && "total" in record))
    return null
  const valid =
    typeof record.importId === "string" &&
    typeof record.agentKey === "string" &&
    typeof record.step === "string" &&
    ["instructions", "skills", "memories", "routines", "done", "failed"].includes(record.step) &&
    typeof record.done === "number" &&
    Number.isFinite(record.done) &&
    typeof record.total === "number" &&
    Number.isFinite(record.total)
  if (!valid) return null
  return {
    importId: String(record.importId),
    agentKey: String(record.agentKey),
    step: record.step as AgentImportProgress["step"],
    done: Math.max(0, Number(record.done)),
    total: Math.max(0, Number(record.total)),
  }
}

/** Re-read before creating so retries reuse successful writes from an interrupted setup. */
export const createGuideChannels = async (api: UiApi, draft: WorkspaceDraft, botIds: string[]): Promise<BotGroup[]> => {
  const { groups } = await api.request("GET /groups", {})
  return Promise.all(
    getChannels(draft.topics).map(async (name) => {
      const existing = groups.find((group) => group.name === name)
      if (!existing)
        return (await api.request("POST /groups", { name, color: getWorkspaceColor(draft.color), memberIds: botIds }))
          .group
      const memberIds = Array.from(new Set([...existing.memberIds, ...botIds]))
      if (memberIds.length === existing.memberIds.length) return existing
      return (
        await api.request(
          "PATCH /groups/:id",
          {
            name: existing.name,
            color: existing.color,
            avatarShape: existing.avatarShape,
            coordinatorBotId: existing.coordinatorBotId,
            memberIds,
          },
          { id: existing.id },
        )
      ).group
    }),
  )
}

export const getWebsite = (value: string): string => {
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("INVALID_WEBSITE")
  return url.href
}

export const getWorkspaceColor = (token: string): string => {
  const property = token.slice(4, -1)
  const color = getComputedStyle(document.documentElement).getPropertyValue(property).trim()
  return /^#[0-9a-f]{6}$/i.test(color) ? color : "#dc2626"
}

/** Connecting an existing server must preserve its workspace and member access. */
export const getIsEmptyOwnerWorkspace = async (api: UiApi, signal?: AbortSignal): Promise<boolean> => {
  const transport = signal ? { signal } : {}
  try {
    const [workspace, session] = await Promise.all([
      api.request("GET /bots", {}, {}, transport),
      api.request("GET /session", {}, {}, transport),
    ])
    return workspace.bots.length === 0 && session.person.role === "admin"
  } catch {
    return false
  }
}

/** The guide already builds the team; opening its channel must not flash the old team prompt. */
export const saveGuideDestination = (threadId: string): void => {
  saveWorkspaceState({
    botId: null,
    threadId,
    route: { section: "bots", screen: "chat" },
    teamSuggestionDismissed: true,
  })
  try {
    localStorage.setItem("touri.sidebar.mode", "work")
  } catch {
    // The channel selection still uses the existing workspace storage policy.
  }
}

/** Read-only readiness checks never start a login or a paid model request. */
export const getIsGuideBotReady = async (api: UiApi, bot: Bot): Promise<boolean> => {
  try {
    if (bot.provider === "opencode" && bot.model?.startsWith("touri-api-")) {
      const catalog = await api.request("GET /api-models", {})
      return (
        (bot.machine === "vm" || catalog.executorAvailable === true) &&
        catalog.models.some((model) => getApiModelReference(model) === bot.model)
      )
    }
    // Isolated machines carry their own programs; host installation does not describe them.
    if (bot.machine === "vm") {
      const login = await api.request("GET /bots/:id/provider-login", {}, { id: bot.id })
      return login.provider === bot.provider && login.ready
    }
    const login = await api.request("GET /bots/:id/provider-login/flow", { provider: bot.provider }, { id: bot.id })
    return login.provider === bot.provider && login.state === "ready" && login.executable === "available"
  } catch {
    return false
  }
}
export const getImportedIdentity = (botId: string, results: AgentImportResult[]) => {
  const imported = results.flatMap((result) => result.bots).find((bot) => bot.botId === botId)
  return imported ? { avatarSeed: imported.agentKey, color: null } : {}
}

type ImportedNamesInput = {
  results: (AgentImportResult & { agentNames: string[] })[]
}

/** Names the agents one import brought in, so each undo says exactly what it removes. */
export const getImportedNames = (imports: ImportedNamesInput, importId: string): string => {
  const result = imports.results.find((item) => item.importId === importId)
  if (!result) return ""
  if (!result.agentNames.length) return t("ob.sourceCount", { count: result.bots.length })

  return result.agentNames.join(", ")
}
