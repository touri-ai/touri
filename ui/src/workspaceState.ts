import { scopedStorageKey } from "./storageScope"

/** Lifecycle of a thread being created: draft (not requested yet), pending (request in flight), failed. */
export type ThreadCreationStatus = "draft" | "pending" | "failed"

export type RoutineHistoryTarget = { routineId?: string }

export type AppRoute =
  | { section: "bots"; screen: "chat" | "preview" }
  | {
      section: "advanced"
      page: "cron" | "integracoes" | "mcp" | "work" | "performance"
      botId?: string
      history?: RoutineHistoryTarget
    }
type SavedWorkspace = {
  teamSuggestionDismissed?: boolean
  teamFollowupDismissed?: boolean
  botId?: string | null
  threadId?: string | null
  threadsByBot?: Record<string, string>
  panelsByBot?: Record<string, boolean>
  /** Epoch ms when each bot's conversation was last on screen; drives the sidebar "novidades" state. */
  lastViewedByBot?: Record<string, number>
  route?: AppRoute
}
const KEY = "touri.workspace.v1"

/** Preserve saved destinations when global pages move behind Advanced. */
export const migrateRoute = (raw: unknown): AppRoute | undefined => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const route = raw as Record<string, unknown>
  const history = route.page === "cron" ? getRoutineHistoryTarget(route.history) : undefined
  if (route.section === "bots" && (route.screen === "chat" || route.screen === "preview"))
    return { section: "bots", screen: route.screen }
  if (
    (route.section === "touri" || route.section === "advanced") &&
    (route.page === "cron" ||
      route.page === "integracoes" ||
      route.page === "mcp" ||
      route.page === "work" ||
      route.page === "performance")
  )
    return {
      section: "advanced",
      page: route.page,
      ...(typeof route.botId === "string" ? { botId: route.botId } : {}),
      ...(history ? { history } : {}),
    }
  return undefined
}

const getRoutineHistoryTarget = (raw: unknown): RoutineHistoryTarget | undefined => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const history = raw as Record<string, unknown>

  return typeof history.routineId === "string" ? { routineId: history.routineId } : {}
}

export const readWorkspaceState = (): SavedWorkspace => {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(scopedStorageKey(KEY)) ?? "{}")
    if (!raw || typeof raw !== "object") return {}
    const value = raw as Record<string, unknown>
    const route = migrateRoute(value.route)
    return {
      ...(typeof value.teamSuggestionDismissed === "boolean"
        ? { teamSuggestionDismissed: value.teamSuggestionDismissed }
        : {}),
      ...(typeof value.teamFollowupDismissed === "boolean"
        ? { teamFollowupDismissed: value.teamFollowupDismissed }
        : {}),
      ...(value.panelsByBot && typeof value.panelsByBot === "object" && !Array.isArray(value.panelsByBot)
        ? {
            panelsByBot: Object.fromEntries(
              Object.entries(value.panelsByBot).filter(([, open]) => typeof open === "boolean"),
            ),
          }
        : {}),
      ...(value.lastViewedByBot && typeof value.lastViewedByBot === "object" && !Array.isArray(value.lastViewedByBot)
        ? {
            lastViewedByBot: Object.fromEntries(
              Object.entries(value.lastViewedByBot).filter(([, at]) => typeof at === "number" && Number.isFinite(at)),
            ),
          }
        : {}),
      ...(typeof value.botId === "string" ? { botId: value.botId } : {}),
      ...(typeof value.threadId === "string" ? { threadId: value.threadId } : {}),
      ...(value.threadsByBot && typeof value.threadsByBot === "object" && !Array.isArray(value.threadsByBot)
        ? {
            threadsByBot: Object.fromEntries(
              Object.entries(value.threadsByBot).filter(([, id]) => typeof id === "string"),
            ),
          }
        : {}),
      ...(route ? { route } : {}),
    }
  } catch {
    return {}
  }
}

export const saveWorkspaceState = (patch: SavedWorkspace): void => {
  try {
    localStorage.setItem(scopedStorageKey(KEY), JSON.stringify({ ...readWorkspaceState(), ...patch }))
  } catch {
    /* Storage may be unavailable in an embedded browser. */
  }
}
