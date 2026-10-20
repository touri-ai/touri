import type {
  Bot,
  BotGroup,
  HostKind,
  Id,
  Message,
  NotificationRecord,
  Routine,
  RoutineRun,
  Run,
  Thread,
} from "@touri/contracts"
import {
  Fragment,
  type KeyboardEvent,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { type ApprovalTarget, pendingApprovalTargets } from "../approvalNavigation"
import { reconcileApprovalMessages } from "../approvalState"
import { BOT_ACTIVITY_LABELS, type BotActivityKind } from "../botActivity"
import { latestPreview } from "../botPreview"
import { paletteShortcutLabel } from "../features/commandPalette/shortcut"
import { getRoutineRunSidebarDateLabel, t } from "../i18n"
import {
  isFailureNotice,
  isInformationalNotice,
  pendingNotifications,
  reconcileFailureNotifications,
  relativeThreadDate,
} from "../sidebarAttention"
import { getSidebarDataByBot, getSidebarThreads } from "../sidebarThreads"
import { getSidebarThreadTitle } from "../sidebarThreadTitle"
import { useRoutineRunCountsToday } from "../useRoutineRunCountsToday"
import { useMascotSnapshot } from "./AvatarRuntime"
import { BotActionsMenu } from "./BotActionsMenu"
import { BotAvatar } from "./BotAvatar"
import { DeleteBotDialog } from "./DeleteBotDialog"
import { GlobalAdvancedMenu } from "./GlobalAdvancedMenu"
import { GroupSidebar } from "./Groups"
import { useInsertedIds } from "./Motion"
import { mascotIsBusy } from "./mascotState"
import { NotificationAttentionBar } from "./NotificationAttentionBar"
import { type NotificationActions, NotificationBell } from "./NotificationCenter"
import { SidebarCount, SidebarDot, SidebarRow } from "./SidebarRow"
import { ThreadGroupHistory } from "./ThreadGroupHistory"
import { type HoldReason, useSidebarOrder } from "./useSidebarOrder"
import "./bot-sidebar.css"

type SidebarProps = {
  serverMode?: boolean
  serverUrl?: string | null
  host?: HostKind
  onNavigate?: () => void
  onSidebarModeChange?: (mode: SidebarMode) => void
  groups?: BotGroup[]
  onNewGroup?: () => void
  onEditGroup?: (group: BotGroup) => void
  onDeleteGroup?: (groupId: string) => Promise<void>
  onNewGroupThread?: (group: BotGroup) => void
  showFakeTrafficLights: boolean
  bots: Array<Bot>
  threads: Array<Thread>
  messages: Array<Message>
  workRuns?: Array<Run>
  runs?: Array<Run>
  routineRuns?: Array<RoutineRun>
  routines?: Array<Routine>
  /** Float bots with updates to the top (settings: "Mover bots com novidades para o topo"). Default on. */
  floatUpdates?: boolean
  selectedBotId: Id | null
  selectedThreadId: Id | null
  section: "advanced" | "bots"
  advancedPage: "cron" | "integracoes" | "mcp" | "work" | "performance" | null
  onChat: () => void
  onAdvancedPage: (page: "integracoes" | "mcp" | "work" | "performance") => void
  onRoutines: (botId: Id) => void
  onRoutineHistory?: (botId: Id, routineId?: Id) => void
  onProject: () => void
  onImport: () => void
  onSelect: (id: Id) => void
  onSelectThread: (id: Id) => void
  onReviewApproval: (target: ApprovalTarget) => void
  onNewThread: () => void
  onNewBot: () => void
  onBotSettings: () => void
  onDeleteBot?: (botId: string, name: string, deleteVolumes: boolean) => Promise<void>
  onSettings: () => void
  onDoctor: () => void
  onRecovery?: () => void
  recoveryCount?: number
  onSearch: () => void
  notifications: Array<NotificationRecord>
  notificationFocus?: { id: number; request: number } | null
  onNeedsYou?: (item: NotificationRecord) => void
  onNotificationsOpen: (open: boolean) => void
  notificationActions: NotificationActions
}

type SidebarMode = "bots" | "work"
const SIDEBAR_MODE_KEY = "touri.sidebar.mode"
const EMPTY_RUNS: Run[] = []
const EMPTY_GROUPS: BotGroup[] = []
const EMPTY_ROUTINE_RUNS: RoutineRun[] = []
const EMPTY_ROUTINES: Routine[] = []
const EMPTY_THREADS: Thread[] = []
const EMPTY_NOTIFICATIONS: NotificationRecord[] = []
const MAX_SIDEBAR_CONVERSATIONS = 5

const getSavedSidebarMode = (): SidebarMode | null => {
  if (typeof window === "undefined") return null

  try {
    const savedMode = window.localStorage.getItem(SIDEBAR_MODE_KEY)
    return savedMode === "bots" || savedMode === "work" ? savedMode : null
  } catch {
    return null
  }
}

const getNextSidebarMode = (mode: SidebarMode, key: string): SidebarMode | undefined => {
  if (key === "Home") return "bots"
  if (key === "End") return "work"
  if (key === "ArrowRight" || key === "ArrowDown") return mode === "bots" ? "work" : "bots"
  if (key === "ArrowLeft" || key === "ArrowUp") return mode === "work" ? "bots" : "work"

  return undefined
}

const SidebarIcon = ({ children }: { children: ReactNode }) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
)

export const Sidebar = (props: SidebarProps) => {
  const [savedSidebarMode] = useState(getSavedSidebarMode)
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>(
    () => savedSidebarMode ?? ((props.groups?.length ?? 0) > 0 ? "work" : "bots"),
  )
  const [hasUserSelectedMode, setHasUserSelectedMode] = useState(false)
  const propsRef = useRef(props)
  const routineRuns = props.routineRuns ?? EMPTY_ROUTINE_RUNS
  const routines = props.routines ?? EMPTY_ROUTINES
  const runs = props.runs ?? EMPTY_RUNS
  const sidebarDataByBot = useMemo(() => getSidebarDataByBot(props.threads, routineRuns), [props.threads, routineRuns])
  const workRuns = props.workRuns ?? EMPTY_RUNS
  const runningWorkCount = workRuns.filter((run) => run.status !== "queued").length
  const queuedWorkCount = workRuns.filter((run) => run.status === "queued").length
  const hasWork = runningWorkCount + queuedWorkCount > 0
  const routineIds = useMemo(
    () => (props.routines ? new Set(props.routines.map((routine) => routine.id)) : undefined),
    [props.routines],
  )
  const routinesById = useMemo(() => new Map(routines.map((routine) => [routine.id, routine])), [routines])
  const routineRunCountsToday = useRoutineRunCountsToday(routineRuns, routinesById)
  const selectedRoutineThreadId = props.threads.find(
    (thread) => thread.id === props.selectedThreadId && thread.kind === "routine",
  )?.id
  const selectedRoutineId = routineRuns.find((run) => run.threadId === selectedRoutineThreadId)?.routineId
  const selectedRoutineRef = useRef(selectedRoutineId)
  // Switching bots inside Preview keeps that view; global pages return to the bot conversation.
  const selectedThreadIsGroup = props.threads.some((thread) => thread.id === props.selectedThreadId && thread.groupId)
  const selectionState = useRef({ section: props.section })
  // Keep memoized row callbacks stable while updating their target after each committed render.
  useLayoutEffect(() => {
    propsRef.current = props
    selectedRoutineRef.current = selectedRoutineId
    selectionState.current = { section: props.section }
  })
  const navigate = useCallback((action: () => void): void => {
    propsRef.current.onNavigate?.()
    action()
  }, [])
  const select = useCallback((id: Id): void => {
    const currentProps = propsRef.current
    currentProps.onNavigate?.()
    const currentSelection = selectionState.current
    currentProps.onSelect(id)
    if (currentSelection.section !== "bots") currentProps.onChat()
  }, [])
  const selectThread = useCallback((id: Id): void => {
    const currentProps = propsRef.current
    currentProps.onNavigate?.()
    currentProps.onSelectThread(id)
    if (selectionState.current.section !== "bots") currentProps.onChat()
  }, [])
  const createThread = useCallback((): void => {
    const currentProps = propsRef.current
    currentProps.onNavigate?.()
    if (selectionState.current.section !== "bots") currentProps.onChat()
    currentProps.onNewThread()
  }, [])
  const openBotSettings = useCallback(
    (botId: Id): void => {
      select(botId)
      propsRef.current.onBotSettings()
    },
    [select],
  )
  const openBotRoutines = useCallback(
    (botId: Id): void => {
      navigate(() => propsRef.current.onRoutines(botId))
    },
    [navigate],
  )
  const openBotRoutineHistory = useCallback(
    (botId: Id, routineId?: Id): void => {
      navigate(() => {
        const currentProps = propsRef.current
        const openHistory = currentProps.onRoutineHistory ?? currentProps.onRoutines
        openHistory(botId, routineId ?? selectedRoutineRef.current)
      })
    },
    [navigate],
  )
  const reviewApproval = useCallback(
    (target: ApprovalTarget): void => {
      navigate(() => propsRef.current.onReviewApproval(target))
    },
    [navigate],
  )
  const openNotification = useCallback(
    (item: NotificationRecord): void => {
      navigate(() => propsRef.current.notificationActions.open(item))
    },
    [navigate],
  )
  const createChannel = useCallback((): void => {
    navigate(() => propsRef.current.onNewGroup?.())
  }, [navigate])
  const editChannel = useCallback(
    (group: BotGroup): void => {
      navigate(() => propsRef.current.onEditGroup?.(group))
    },
    [navigate],
  )
  const createChannelThread = useCallback(
    (group: BotGroup): void => {
      navigate(() => propsRef.current.onNewGroupThread?.(group))
    },
    [navigate],
  )
  const deleteBot = useCallback((botId: string, name: string, deleteVolumes: boolean): Promise<void> => {
    return propsRef.current.onDeleteBot?.(botId, name, deleteVolumes) ?? Promise.resolve()
  }, [])
  const deleteChannel = useCallback((groupId: string): Promise<void> => {
    return propsRef.current.onDeleteGroup?.(groupId) ?? Promise.resolve()
  }, [])
  const insertedThreads = useInsertedIds(props.threads.map((thread) => thread.id))
  const messages = useMemo(
    () => reconcileApprovalMessages(props.messages, props.notifications),
    [props.messages, props.notifications],
  )
  const notifications = useMemo(
    () => reconcileFailureNotifications(props.notifications, runs),
    [props.notifications, runs],
  )
  const attention = useMemo(() => pendingNotifications(notifications, messages), [notifications, messages])
  const needsYou = useMemo(() => attention.filter((item) => !isInformationalNotice(item)), [attention])
  const hasNeedsYou = needsYou.some((item) => item.resolvedAt === null)
  const ordered = useSidebarOrder({ ...props, messages, notifications, attention })
  const botsWaitingCount = [...ordered.activity.values()].filter((activity) => activity.kind === "needs-you").length
  const attentionThreadIds = useMemo(
    () => new Set(attention.flatMap((item) => (item.threadId ? [item.threadId] : []))),
    [attention],
  )
  const channelUnreadById = useMemo(
    () =>
      props.threads.reduce((unread, thread) => {
        if (!thread.groupId || thread.groupThreadId) return unread

        unread.set(thread.groupId, (unread.get(thread.groupId) ?? 0) + thread.unread)
        return unread
      }, new Map<string, number>()),
    [props.threads],
  )
  const channelAttentionGroupIds = useMemo(
    () =>
      new Set(
        props.threads.flatMap((thread) =>
          thread.groupId && attentionThreadIds.has(thread.id) ? [thread.groupId] : [],
        ),
      ),
    [props.threads, attentionThreadIds],
  )
  const workNeedsYouCount =
    botsWaitingCount + (props.groups ?? []).filter((group) => channelAttentionGroupIds.has(group.id)).length
  const workUnreadCount = (props.groups ?? []).reduce(
    (count, group) => count + (channelUnreadById.get(group.id) ?? 0),
    0,
  )
  const workWaitingCount = workNeedsYouCount + workUnreadCount
  const attentionByBot = useMemo(
    () =>
      attention.reduce((byBot, item) => {
        if (!item.botId) return byBot

        // Mutating this local index keeps the one-pass grouping linear as notifications grow.
        const botAttention = byBot.get(item.botId) ?? []
        botAttention.push(item)
        byBot.set(item.botId, botAttention)
        return byBot
      }, new Map<string, NotificationRecord[]>()),
    [attention],
  )
  const botNavigationKey = `${props.section}:${props.advancedPage}:${props.selectedBotId}:${props.selectedThreadId}`
  useEffect(() => {
    if (savedSidebarMode !== null || hasUserSelectedMode || !(props.groups?.length ?? 0)) return

    setSidebarMode("work")
    props.onSidebarModeChange?.("work")
  }, [savedSidebarMode, hasUserSelectedMode, props.groups?.length, props.onSidebarModeChange])
  const selectMode = (mode: SidebarMode): void => {
    setSidebarMode(mode)
    setHasUserSelectedMode(true)
    props.onSidebarModeChange?.(mode)
    try {
      window.localStorage.setItem(SIDEBAR_MODE_KEY, mode)
    } catch {
      // The in-memory selection remains usable if browser storage is unavailable.
    }
  }
  const handleModeKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const nextMode = getNextSidebarMode(sidebarMode, event.key)
    if (!nextMode || nextMode === sidebarMode) return

    event.preventDefault()
    selectMode(nextMode)
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-sidebar-mode="${nextMode}"]`)?.focus()
  }
  const renderBotEntries = (mode: SidebarMode): ReactNode => (
    <div className="bot-list" ref={mode === "bots" ? ordered.listRef : undefined}>
      {mode === "work" && <h2 className="bot-status-heading">{t("Direct messages")}</h2>}
      {ordered.bots.map((bot) => {
        const activity = ordered.activity.get(bot.id)
        const selected = props.section === "bots" && bot.id === props.selectedBotId && !selectedThreadIsGroup
        const expanded = mode === "bots" && bot.id === props.selectedBotId && !selectedThreadIsGroup
        const botData = sidebarDataByBot.get(bot.id)

        return (
          <Fragment key={`${mode}:${bot.id}`}>
            <BotEntry
              compact={mode === "work"}
              navigationKey={bot.id === props.selectedBotId ? botNavigationKey : ""}
              bot={bot}
              activity={activity?.kind ?? null}
              onHold={ordered.hold}
              insertedThreads={insertedThreads}
              threads={botData?.threads ?? EMPTY_THREADS}
              routineRuns={botData?.routineRuns ?? EMPTY_ROUTINE_RUNS}
              routineRunCountsToday={routineRunCountsToday}
              runs={runs}
              routineIds={routineIds}
              routinesById={routinesById}
              messages={messages}
              attention={attentionByBot.get(bot.id) ?? EMPTY_NOTIFICATIONS}
              notifications={notifications}
              selected={selected}
              expanded={expanded}
              selectedThreadId={expanded ? props.selectedThreadId : null}
              onSelect={select}
              onSelectThread={selectThread}
              onNewThread={createThread}
              onSettings={openBotSettings}
              onRoutines={openBotRoutines}
              onRoutineHistory={openBotRoutineHistory}
              onReviewApproval={reviewApproval}
              onNotification={openNotification}
              onDelete={props.onDeleteBot ? deleteBot : undefined}
            />
          </Fragment>
        )
      })}
    </div>
  )
  return (
    <nav className="bot-sidebar r8-sidebar" aria-label={t("Workspace sidebar")}>
      <div className="traffic-light-row" data-tauri-drag-region="deep">
        {props.showFakeTrafficLights ? (
          <div className="sidebar-traffic-lights" aria-hidden="true">
            <span className="traffic-light red" />
            <span className="traffic-light yellow" />
            <span className="traffic-light green" />
          </div>
        ) : (
          <span className="traffic-light-spacer" aria-hidden="true" />
        )}
        <div className="sidebar-top-actions">
          <button
            type="button"
            className="sidebar-icon-button"
            onClick={() => navigate(props.onSearch)}
            aria-label={t("Search conversations")}
            aria-keyshortcuts="Meta+K Control+K"
            title={`${t("Search bots, conversations and settings")} (${paletteShortcutLabel()})`}
          >
            <SidebarIcon>
              <circle cx="10.5" cy="10.5" r="6.5" />
              <path d="m16 16 4 4" />
            </SidebarIcon>
          </button>
          <button
            type="button"
            className="sidebar-icon-button"
            onClick={() => navigate(props.onNewBot)}
            aria-label={t("Create teammate")}
            title={t("Create teammate")}
            aria-keyshortcuts="Meta+N Control+N"
          >
            <SidebarIcon>
              <path d="M12 5v14M5 12h14" />
            </SidebarIcon>
          </button>
          {props.onNavigate && (
            <button
              type="button"
              className="sidebar-icon-button sidebar-close"
              onClick={props.onNavigate}
              aria-label={t("Close menu")}
            >
              ×
            </button>
          )}
        </div>
      </div>
      <div className="sidebar-mode-tabs" role="tablist" aria-label={t("Sidebar mode")}>
        {(
          [
            {
              id: "bots",
              label: t("Bots"),
              count: botsWaitingCount,
              needsYouCount: botsWaitingCount,
              unreadCount: 0,
            },
            {
              id: "work",
              label: t("Work mode tab"),
              count: workWaitingCount,
              needsYouCount: workNeedsYouCount,
              unreadCount: workUnreadCount,
            },
          ] as const
        ).map((mode) => {
          const activityLabels = [
            ...(mode.needsYouCount ? [t("Tab attention count", { count: mode.needsYouCount })] : []),
            ...(mode.unreadCount ? [t("Tab unread count", { count: mode.unreadCount })] : []),
          ]
          const label = `${mode.label}, ${activityLabels.join(", ") || t("Tab waiting count", { count: 0 })}`
          const tone = mode.needsYouCount ? "attention" : mode.unreadCount ? "unread" : "empty"

          return (
            <button
              key={mode.id}
              type="button"
              role="tab"
              id={`sidebar-mode-${mode.id}`}
              data-sidebar-mode={mode.id}
              aria-selected={sidebarMode === mode.id}
              aria-controls={`sidebar-mode-panel-${mode.id}`}
              aria-label={label}
              tabIndex={sidebarMode === mode.id ? 0 : -1}
              onClick={() => selectMode(mode.id)}
              onKeyDown={handleModeKeyDown}
            >
              <span>{mode.label}</span>
              {mode.count > 0 && sidebarMode !== mode.id && (
                <span className={`sidebar-mode-dot tone-${tone}`} aria-hidden="true" />
              )}
            </button>
          )
        })}
      </div>
      {hasNeedsYou ? (
        <NotificationAttentionBar
          notifications={needsYou}
          onSelect={(item) => {
            const selectNotification = props.onNeedsYou ?? props.notificationActions.open
            if (item.kind === "approval" && item.threadId && item.requestId) props.onNavigate?.()
            selectNotification(item)
          }}
        />
      ) : (
        hasWork && (
          <button
            type="button"
            className="sidebar-work-badge"
            aria-label={t("View work summary", { running: runningWorkCount, queued: queuedWorkCount })}
            onClick={() => navigate(() => props.onAdvancedPage("work"))}
          >
            <span className="sidebar-status-dot state-running" aria-hidden="true" />
            <span className="sidebar-work-copy">
              {t("Working")} · {runningWorkCount}
              {queuedWorkCount > 0 && (
                <>
                  {" "}
                  <small>{t("Work queued count", { count: queuedWorkCount })}</small>
                </>
              )}
            </span>
            <span className="sidebar-work-action" aria-hidden="true">
              ›
            </span>
          </button>
        )
      )}
      <div
        id="sidebar-mode-panel-bots"
        className="sidebar-mode-panel"
        role="tabpanel"
        aria-labelledby="sidebar-mode-bots"
        tabIndex={-1}
        hidden={sidebarMode !== "bots"}
      >
        {sidebarMode === "bots" && <div className="bot-groups">{renderBotEntries("bots")}</div>}
      </div>
      <div
        id="sidebar-mode-panel-work"
        className="sidebar-mode-panel work-mode-panel"
        role="tabpanel"
        aria-labelledby="sidebar-mode-work"
        tabIndex={-1}
        hidden={sidebarMode !== "work"}
      >
        {props.onNewGroup && (
          <GroupSidebar
            groups={props.groups ?? EMPTY_GROUPS}
            threads={props.threads}
            attentionThreadIds={attentionThreadIds}
            selectedThreadId={props.selectedThreadId}
            onSelect={selectThread}
            onCreate={createChannel}
            onEdit={editChannel}
            onDelete={props.onDeleteGroup ? deleteChannel : undefined}
            onNewThread={createChannelThread}
          />
        )}
        <div className="bot-groups work-mode-dms">{sidebarMode === "work" ? renderBotEntries("work") : null}</div>
      </div>
      {props.onRecovery && (props.recoveryCount ?? 0) > 0 && (
        <button type="button" className="sidebar-recovery" onClick={() => navigate(() => props.onRecovery?.())}>
          <SidebarIcon>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </SidebarIcon>
          <span>{t("Interrupted tasks")}</span>
        </button>
      )}
      <div className="sidebar-footer">
        <div className="sidebar-user-row">
          <button type="button" className="user-chip" onClick={() => navigate(props.onSettings)}>
            <span className="user-avatar" aria-hidden="true">
              T
            </span>
            <span>
              <strong>{t("Você")}</strong>
              <small title={props.serverUrl ?? undefined}>
                {props.serverMode ? t("Modo servidor") : t("Local · grátis")}
              </small>
            </span>
          </button>
          <NotificationBell
            notifications={notifications}
            messages={messages}
            runs={runs}
            {...(props.notificationFocus ? { focusNotification: props.notificationFocus } : {})}
            actions={{
              ...props.notificationActions,
              open: (item) => navigate(() => props.notificationActions.open(item)),
            }}
            onOpenChange={props.onNotificationsOpen}
            onReviewApproval={(target) => navigate(() => props.onReviewApproval(target))}
          />
        </div>
        <GlobalAdvancedMenu
          host={props.host}
          page={props.section === "advanced" ? props.advancedPage : null}
          onPage={(page) => navigate(() => props.onAdvancedPage(page))}
          onProject={() => navigate(props.onProject)}
          onDoctor={() => navigate(props.onDoctor)}
          onImport={() => navigate(props.onImport)}
        />
      </div>
    </nav>
  )
}

const BotEntry = memo(
  ({
    navigationKey,
    compact,
    insertedThreads,
    bot,
    activity,
    onHold,
    threads,
    routineRuns,
    routineRunCountsToday,
    runs,
    routineIds,
    routinesById,
    messages,
    attention,
    notifications,
    selected,
    expanded,
    selectedThreadId,
    onSelect,
    onSelectThread,
    onNewThread,
    onSettings,
    onRoutines,
    onRoutineHistory,
    onReviewApproval,
    onNotification,
    onDelete,
  }: {
    navigationKey: string
    compact: boolean
    bot: Bot
    activity: BotActivityKind | null
    onHold: (botId: Id, reason: HoldReason, active: boolean) => void
    insertedThreads: ReadonlySet<string>
    threads: Array<Thread>
    routineRuns: Array<RoutineRun>
    routineRunCountsToday: ReadonlyMap<string, number>
    runs: Array<Run>
    routineIds: ReadonlySet<string> | undefined
    routinesById: ReadonlyMap<string, Routine>
    messages: Array<Message>
    attention: Array<NotificationRecord>
    notifications: Array<NotificationRecord>
    selected: boolean
    expanded: boolean
    selectedThreadId: Id | null
    onSelect: (botId: Id) => void
    onSelectThread: (id: Id) => void
    onNewThread: (botId: Id) => void
    onSettings: (botId: Id) => void
    onRoutines: (botId: Id) => void
    onRoutineHistory: (botId: Id, routineId?: Id) => void
    onReviewApproval: (target: ApprovalTarget) => void
    onNotification: (item: NotificationRecord) => void
    onDelete?: ((botId: string, name: string, deleteVolumes: boolean) => Promise<void>) | undefined
  }) => {
    const [menuOpen, setMenuOpen] = useState(false)
    // biome-ignore lint/correctness/useExhaustiveDependencies: dismiss on any navigation, including another bot's thread
    useEffect(() => setMenuOpen(false), [navigationKey])
    const [deleting, setDeleting] = useState(false)
    const [treeCollapsed, setTreeCollapsed] = useState(false)
    useEffect(() => {
      if (!expanded) setTreeCollapsed(false)
    }, [expanded])
    const snapshot = useMascotSnapshot(bot)
    const ids = threads.map((thread) => thread.id)
    const botMessages = messages.filter((message) => ids.includes(message.threadId))
    const latestAssistant = botMessages
      .filter((message) => message.role === "assistant")
      .reduce<Message | undefined>((latest, message) => {
        if (!latest || message.createdAt > latest.createdAt) return message

        return latest
      }, undefined)
    const failureRead =
      latestAssistant &&
      notifications.some(
        (item) =>
          item.botId === bot.id &&
          item.threadId === latestAssistant.threadId &&
          isFailureNotice(item) &&
          item.resolvedAt !== null &&
          item.createdAt >= latestAssistant.createdAt &&
          item.resolvedAt >= latestAssistant.updatedAt,
      )
    const completedAfterFailure =
      latestAssistant &&
      notifications.some(
        (item) =>
          item.kind === "done" &&
          item.threadId === latestAssistant.threadId &&
          item.createdAt > latestAssistant.updatedAt,
      )
    const newestCompletion = Math.max(
      0,
      ...botMessages
        .filter((message) => message.role === "assistant" && message.status === "complete")
        .map((message) => message.updatedAt),
      ...notifications.filter((item) => item.botId === bot.id && item.kind === "done").map((item) => item.createdAt),
    )
    const actionable = attention.filter((item) => !isInformationalNotice(item))
    const postponed = attention.some(isInformationalNotice)
    const failure = actionable.find(isFailureNotice)
    const failed = Boolean(
      failure ||
        (latestAssistant?.status === "failed" &&
          latestAssistant.updatedAt >= newestCompletion &&
          !failureRead &&
          !completedAfterFailure),
    )
    const waiting = attention.find((item) => ["approval", "question", "takeover", "incident"].includes(item.kind))
    const approvals = pendingApprovalTargets(botMessages)
    const unread = threads.reduce((count, thread) => count + thread.unread, 0)
    const preview = latestPreview({ threadIds: ids, messages, runs })
    const reason =
      approvals.length || waiting?.kind === "approval"
        ? t("your approval")
        : waiting
          ? waiting.kind === "question"
            ? t("your answer")
            : waiting.kind === "takeover"
              ? t("your help")
              : t("your decision")
          : actionable.length
            ? t("review the interrupted task")
            : null
    const status = reason
      ? t("Waiting for you: {reason}", { reason })
      : failed
        ? t("Reply interrupted")
        : postponed
          ? t("Routine postponed")
          : bot.paused
            ? t("Paused")
            : null
    const badgeState =
      approvals.length || waiting
        ? "waiting"
        : failed
          ? "failed"
          : activity === "working" ||
              mascotIsBusy(snapshot.state) ||
              botMessages.some((message) => message.status === "streaming")
            ? "running"
            : null
    const hasActionBadge = approvals.length > 0 || Boolean((waiting || failure)?.threadId)
    const trailingState = !hasActionBadge && badgeState && (!compact || badgeState !== "running") ? badgeState : null
    // A dismissed or superseded failure must not keep the sidebar mascot in an error pose.
    const avatarState = snapshot.state === "error" && !failed ? "idle" : undefined
    const activityKind = activity
    const runningThreadIds = useMemo(
      () => new Set(messages.filter((message) => message.status === "streaming").map((message) => message.threadId)),
      [messages],
    )
    const showTree = expanded && !treeCollapsed
    const sidebarThreads = useMemo(
      () =>
        showTree
          ? getSidebarThreads(
              threads,
              routineRuns,
              selectedThreadId,
              runningThreadIds,
              routineIds,
              routineRunCountsToday,
            )
          : [],
      [showTree, threads, routineRuns, selectedThreadId, runningThreadIds, routineIds, routineRunCountsToday],
    )
    const visibleUnread = sidebarThreads.reduce((count, entry) => count + entry.unread, 0)
    const botUnread = unread - visibleUnread
    const visibleRoutineIds = [
      ...new Set(
        routineRuns
          .filter((routineRun) => !routineIds || routineIds.has(routineRun.routineId))
          .map((routineRun) => routineRun.routineId),
      ),
    ]
    const selectedRoutineId = sidebarThreads.find(({ thread }) => thread.id === selectedThreadId)?.routineRun?.routineId
    const historyRoutineId = selectedRoutineId ?? (visibleRoutineIds.length === 1 ? visibleRoutineIds[0] : undefined)
    const deletedRoutine = sidebarThreads.find((entry) => entry.deletedRoutine)
    const [showAllConversations, setShowAllConversations] = useState(false)
    const routineEntries = sidebarThreads.filter((entry) => entry.thread.kind === "routine" && !entry.deletedRoutine)
    const conversationEntries = sidebarThreads.filter((entry) => !routineEntries.includes(entry))
    const shownConversations = showAllConversations
      ? conversationEntries
      : conversationEntries.filter(
          (entry, index) => index < MAX_SIDEBAR_CONVERSATIONS || entry.thread.id === selectedThreadId,
        )
    const selectedRoutineEntry = routineEntries.find((entry) => entry.thread.id === selectedThreadId)
    const labelledRoutineEntry = selectedRoutineEntry ?? routineEntries[0]
    const routineRunLabel = labelledRoutineEntry
      ? getRoutineRunSidebarDateLabel(
          labelledRoutineEntry.routineRun?.scheduledFor ?? labelledRoutineEntry.thread.createdAt,
          "pt-BR",
          routinesById.get(labelledRoutineEntry.routineRun?.routineId ?? "")?.timezone,
        )
      : ""
    const hiddenConversationCount = conversationEntries.length - shownConversations.length
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: hover and focus only pause reordering; they trigger no action
      <div
        className={`bot-entry ${expanded ? "expanded" : ""} ${compact ? "compact-dm" : ""}`}
        data-bot-entry={compact ? undefined : bot.id}
        data-work-bot-entry={compact ? bot.id : undefined}
        data-activity={activityKind ?? undefined}
        onMouseEnter={() => onHold(bot.id, "hover", true)}
        onMouseLeave={() => onHold(bot.id, "hover", false)}
        onFocus={() => onHold(bot.id, "focus", true)}
        onBlur={(event) => {
          if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)))
            onHold(bot.id, "focus", false)
        }}
      >
        <SidebarRow
          rowClassName="bot-row"
          className="bot-row-main"
          selected={selected}
          rowAttention={badgeState ?? undefined}
          title={status || preview || undefined}
          expanded={selected ? !treeCollapsed : undefined}
          leading={<BotAvatar bot={bot} size={22} {...(avatarState ? { state: avatarState } : {})} motion="idle" />}
          label={
            <>
              <strong title={bot.roleLine || bot.title || undefined}>{bot.name}</strong>
              <small className="bot-role visually-hidden">{bot.roleLine || bot.title || t("Bot local")}</small>
              <small
                className={bot.paused ? "bot-preview paused" : "bot-preview visually-hidden"}
                title={status || preview || undefined}
              >
                {status || preview || t("Start a conversation")}
              </small>
            </>
          }
          trailing={
            trailingState ? (
              <SidebarDot tone={trailingState} label={status ?? t("Em execução")} />
            ) : botUnread > 0 && !hasActionBadge ? (
              <SidebarCount count={botUnread} label={t("Unread messages", { count: botUnread })} />
            ) : activity === "new" && !hasActionBadge ? (
              <SidebarDot tone="new" label={`${bot.name}: ${BOT_ACTIVITY_LABELS.new.toLocaleLowerCase("pt-BR")}`} />
            ) : null
          }
          actions={
            <>
              {approvals.length > 0 ? (
                <button
                  type="button"
                  className="sidebar-approval-badge"
                  aria-label={t(approvals.length === 1 ? "Review approval for {name}" : "Review approvals for {name}", {
                    name: bot.name,
                  })}
                  title={t("Pending approval count", { count: approvals.length })}
                  onClick={() => {
                    const target = approvals[0]
                    if (target) onReviewApproval(target)
                  }}
                >
                  <span className="sidebar-status-dot state-waiting" />
                </button>
              ) : (waiting || failure)?.threadId ? (
                <button
                  type="button"
                  className={`sidebar-attention-button state-${badgeState}`}
                  aria-label={t(badgeState === "failed" ? "Open failure for {name}" : "Open request for {name}", {
                    name: bot.name,
                  })}
                  title={t(badgeState === "failed" ? "Open and mark read" : "Open request")}
                  onClick={() => {
                    const item = waiting || failure
                    if (item) onNotification(item)
                  }}
                >
                  <span className="sidebar-status-dot" />
                </button>
              ) : null}
              <BotActionsMenu
                name={bot.name}
                open={menuOpen}
                onOpenChange={setMenuOpen}
                onSettings={() => onSettings(bot.id)}
                onRoutines={() => onRoutines(bot.id)}
                onDelete={onDelete ? () => setDeleting(true) : undefined}
              />
            </>
          }
          onClick={() => {
            if (selected) setTreeCollapsed((collapsed) => !collapsed)
            onSelect(bot.id)
          }}
          onContextMenu={(event) => {
            event.preventDefault()
            setMenuOpen(true)
          }}
        />
        {deleting && onDelete && <DeleteBotDialog bot={bot} onDelete={onDelete} onClose={() => setDeleting(false)} />}
        {showTree && (
          <section className="bot-thread-tree" aria-label={t("Conversations for {name}", { name: bot.name })}>
            {shownConversations.map(({ thread, taskGroupName, countToday, running, unread, deletedRoutine }) => {
              const dateLabel =
                thread.kind === "routine"
                  ? getRoutineRunSidebarDateLabel(thread.createdAt, "pt-BR")
                  : relativeThreadDate(thread.updatedAt)
              const title = deletedRoutine
                ? t("Deleted routine")
                : taskGroupName
                  ? t("Task row title", { name: taskGroupName })
                  : getSidebarThreadTitle(thread)
              const countLabel = taskGroupName ? t("Today count suffix", { count: countToday }) : undefined

              return (
                <Fragment key={thread.id}>
                  <ThreadRow
                    inserted={insertedThreads.has(thread.id)}
                    title={title}
                    countLabel={countLabel}
                    dateLabel={unread > 0 || running ? "" : dateLabel}
                    unread={unread}
                    selected={thread.id === selectedThreadId}
                    running={running}
                    onClick={() => onSelectThread(thread.id)}
                  />
                  {taskGroupName && (
                    <ThreadGroupHistory
                      label={t("Task conversation history for {name}", { name: taskGroupName })}
                      threads={threads}
                      routineRuns={routineRuns}
                      routineIds={routineIds}
                      groupThreadId={thread.id}
                      selectedThreadId={selectedThreadId}
                      onSelectThread={onSelectThread}
                    />
                  )}
                </Fragment>
              )
            })}
            {hiddenConversationCount > 0 && (
              <button type="button" className="new-thread-row" onClick={() => setShowAllConversations(true)}>
                {t("Show more conversations", { count: hiddenConversationCount })}
              </button>
            )}
            {visibleRoutineIds.length > 0 && (
              <RoutinesRow
                selected={selectedRoutineEntry !== undefined}
                runLabel={routineRunLabel}
                running={routineEntries.some((entry) => entry.running)}
                unread={routineEntries.reduce((count, entry) => count + entry.unread, 0)}
                todayCount={visibleRoutineIds.reduce((count, id) => count + (routineRunCountsToday.get(id) ?? 0), 0)}
                onClick={() => {
                  const [only] = routineEntries.length === 1 ? routineEntries : []
                  if (only) onSelectThread(only.thread.id)
                  onRoutineHistory(bot.id, historyRoutineId)
                }}
              />
            )}
            {deletedRoutine && (
              <ThreadGroupHistory
                label={t("Deleted routine conversations")}
                threads={threads}
                routineRuns={routineRuns}
                routineIds={routineIds}
                groupThreadId={deletedRoutine.thread.id}
                selectedThreadId={selectedThreadId}
                onSelectThread={onSelectThread}
              />
            )}
            <button type="button" className="new-thread-row" onClick={() => onNewThread(bot.id)}>
              <SidebarIcon>
                <path d="M12 5v14M5 12h14" />
              </SidebarIcon>
              {t("Nova conversa")}
            </button>
          </section>
        )}
      </div>
    )
  },
)

const RoutinesRow = ({
  selected,
  runLabel,
  running,
  unread,
  todayCount,
  onClick,
}: {
  selected: boolean
  runLabel: string
  running: boolean
  unread: number
  todayCount: number
  onClick: () => void
}) => (
  <button
    type="button"
    className={`thread-row routines-row ${selected ? "selected" : ""}`}
    onClick={onClick}
    aria-current={selected ? "page" : undefined}
  >
    <span className="thread-icon" aria-hidden="true">
      <SidebarIcon>
        <circle cx="12" cy="12" r="8" />
        <path d="M12 7v5l3 2" />
      </SidebarIcon>
    </span>
    <span className="thread-copy">
      <strong>{t("Rotinas")}</strong>
    </span>
    {running ? (
      <SidebarDot tone="running" label={t("Em execução")} />
    ) : unread > 0 ? (
      <SidebarCount count={unread} label={t("Unread messages", { count: unread })} />
    ) : (
      <small className="thread-meta">
        {todayCount > 0 ? t("Routines today count", { count: todayCount }) : runLabel}
      </small>
    )}
  </button>
)

const ThreadRow = ({
  inserted,
  title,
  countLabel,
  dateLabel,
  unread,
  selected,
  running,
  onClick,
}: {
  title: string
  countLabel: string | undefined
  dateLabel: string
  unread: number
  inserted: boolean
  selected: boolean
  running: boolean
  onClick: () => void
}) => (
  <button
    type="button"
    data-motion-insert={inserted}
    className={`thread-row ${selected ? "selected" : ""}`}
    onClick={onClick}
    aria-current={selected ? "page" : undefined}
  >
    <span className="thread-icon" aria-hidden="true">
      <SidebarIcon>
        <path d="M5 5h14v10H9l-4 4Z" />
      </SidebarIcon>
    </span>
    <span className="thread-copy">
      <strong title={title}>{title}</strong>
      {(countLabel || dateLabel) && <small>{countLabel ?? dateLabel}</small>}
    </span>
    {running ? (
      <SidebarDot tone="running" label={t("Em execução")} />
    ) : unread > 0 ? (
      <SidebarCount count={unread} label={t("Unread messages", { count: unread })} />
    ) : null}
  </button>
)
