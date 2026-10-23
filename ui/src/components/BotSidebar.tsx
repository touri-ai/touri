import type {
  ApiRoutes,
  Bot,
  BotGroup,
  ChannelPerson,
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
  lazy,
  memo,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { type ApprovalTarget, pendingApprovalTargets } from "../approvalNavigation"
import { reconcileApprovalMessages } from "../approvalState"
import { BOT_ACTIVITY_LABELS, type BotActivityKind } from "../botActivity"
import { latestPreview } from "../botPreview"
import { ApiError } from "../errors"
import { getChannelWorking } from "../features/channelBrowser/channelBrowserModel"
import { paletteShortcutLabel } from "../features/commandPalette/shortcut"
import { getRoutineRunDateLabel, getRoutineRunSidebarDateLabel, t } from "../i18n"
import { isRoutineConversation } from "../routineConversation"
import {
  getLastActivityAt,
  getSidebarRowTime,
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
import { DeleteOldAutomaticThreadsDialog } from "./DeleteOldAutomaticThreadsDialog"
import { DeleteThreadDialog, type ThreadDeleteTarget } from "./DeleteThreadDialog"
import { GlobalAdvancedMenu } from "./GlobalAdvancedMenu"
import { Modal } from "./Modal"
import { useInsertedIds } from "./Motion"
import { mascotIsBusy } from "./mascotState"
import { NotificationAttentionBar } from "./NotificationAttentionBar"
import { type NotificationActions, NotificationBell } from "./NotificationCenter"
import { PersonAvatar } from "./PersonAvatar"
import { SidebarCount, SidebarDot, SidebarRow } from "./SidebarRow"
import { ThreadActionsMenu } from "./ThreadActionsMenu"
import { ThreadGroupHistory } from "./ThreadGroupHistory"
import { type HoldReason, useSidebarOrder } from "./useSidebarOrder"
import { getThreadDeletionError, type ThreadDeletion } from "./useThreadDeletion"
import "./bot-sidebar.css"

const GroupSidebar = lazy(() => import("./Groups").then((module) => ({ default: module.GroupSidebar })))

type SidebarProps = {
  currentPerson?: ChannelPerson | undefined
  deletedThreadIds?: ReadonlySet<string> | undefined
  threadDeletion?: ThreadDeletion | undefined
  serverMode?: boolean
  serverUrl?: string | null
  host?: HostKind
  onNavigate?: () => void
  onSidebarModeChange?: (mode: SidebarMode) => void
  groups?: BotGroup[]
  onInvitePerson?: (() => void) | undefined
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
  onArchiveThread?: ((threadId: string, archived: boolean) => Promise<Thread>) | undefined
  onArchiveThreads?: ((threadIds: Array<string>, archived: boolean) => Promise<void>) | undefined
  onDeleteThread?: (threadId: string, botId: string) => Promise<void>
  onDeleteThreads?: ((threadIds: Array<string>, botId: string) => Promise<void>) | undefined
  onGetThreadDeletePreview?:
    | ((threadId: string) => Promise<ApiRoutes["GET /threads/:id/delete-preview"]["res"]>)
    | undefined
  onLoadArchivedThreads?: ((botId: string, before?: string) => Promise<Array<Thread>>) | undefined
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

/** One bot row: name and last-activity time on top, one gray line with the latest message or state below. */
const BotRowLabel = ({ bot, preview, time }: { bot: Bot; preview: string; time: string }) => (
  <span className="bot-row-text">
    <span className="bot-row-top">
      <strong title={bot.roleLine || bot.title || undefined}>{bot.name}</strong>
      <small className="bot-role visually-hidden">{bot.roleLine || bot.title || t("Bot local")}</small>
      {time && <small className="bot-row-time">{time}</small>}
    </span>
    <small className={bot.paused ? "bot-preview paused" : "bot-preview"} title={preview}>
      {preview}
    </small>
  </span>
)

export const Sidebar = (props: SidebarProps) => {
  const [savedSidebarMode] = useState(getSavedSidebarMode)
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>(
    () => savedSidebarMode ?? ((props.groups?.length ?? 0) > 0 ? "work" : "bots"),
  )
  const [hasOpenedWork, setHasOpenedWork] = useState(sidebarMode === "work")
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
  const [newThreadBotId, setNewThreadBotId] = useState<Id | null>(null)
  const createThread = useCallback((botId: Id): void => {
    const currentProps = propsRef.current
    const selectedThreadIsGroup = currentProps.threads.some(
      (thread) => thread.id === currentProps.selectedThreadId && thread.groupId,
    )
    if (currentProps.selectedBotId !== botId || selectedThreadIsGroup) {
      currentProps.onSelect(botId)
      setNewThreadBotId(botId)
      return
    }

    currentProps.onNavigate?.()
    if (selectionState.current.section !== "bots") currentProps.onChat()
    currentProps.onNewThread()
  }, [])
  useEffect(() => {
    if (!newThreadBotId || props.selectedBotId !== newThreadBotId) return

    setNewThreadBotId(null)
    createThread(newThreadBotId)
  }, [newThreadBotId, props.selectedBotId, createThread])
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
        const selectedRoutineId = currentProps.selectedBotId === botId ? selectedRoutineRef.current : undefined
        openHistory(botId, routineId ?? selectedRoutineId)
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
      const currentProps = propsRef.current
      if (!isFailureNotice(item) && currentProps.onNeedsYou) {
        if (item.kind === "approval" && item.threadId && item.requestId) currentProps.onNavigate?.()
        currentProps.onNeedsYou(item)
        return
      }
      navigate(() => currentProps.notificationActions.open(item))
    },
    [navigate],
  )
  const openSearch = useCallback((): void => {
    navigate(() => propsRef.current.onSearch())
  }, [navigate])
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
  const invitePerson = useCallback((): void => {
    navigate(() => propsRef.current.onInvitePerson?.())
  }, [navigate])
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
  const channelWorking = useMemo(() => getChannelWorking(props.threads, messages), [props.threads, messages])
  const notifications = useMemo(
    () => reconcileFailureNotifications(props.notifications, runs),
    [props.notifications, runs],
  )
  const attention = useMemo(() => pendingNotifications(notifications, messages), [notifications, messages])
  const needsYou = useMemo(() => attention.filter((item) => !isInformationalNotice(item)), [attention])
  const ordered = useSidebarOrder({ ...props, messages, notifications, attention })
  const botsWaitingCount = [...ordered.activity.values()].filter((activity) => activity.kind === "needs-you").length
  const attentionThreadIds = useMemo(
    () => new Set(attention.flatMap((item) => (item.threadId ? [item.threadId] : []))),
    [attention],
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
  const workUnreadCount = props.threads.reduce((count, thread) => {
    if (thread.id === props.selectedThreadId || thread.archivedAt !== null || thread.groupThreadId) return count

    return count + thread.unread
  }, 0)
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
  const workThreadsByBot = useMemo(
    () =>
      new Map(
        [...sidebarDataByBot].map(([botId, data]) => [
          botId,
          data.threads.filter((thread) => !thread.groupId && !thread.groupThreadId && thread.archivedAt === null),
        ]),
      ),
    [sidebarDataByBot],
  )
  const workThreadIdsByBot = useMemo(
    () =>
      new Map([...workThreadsByBot].map(([botId, threads]) => [botId, new Set(threads.map((thread) => thread.id))])),
    [workThreadsByBot],
  )
  const workAttentionByBot = useMemo(
    () =>
      new Map(
        [...attentionByBot].map(([botId, botAttention]) => {
          const threadIds = workThreadIdsByBot.get(botId)
          return [botId, botAttention.filter((item) => !item.threadId || threadIds?.has(item.threadId))]
        }),
      ),
    [attentionByBot, workThreadIdsByBot],
  )
  const workNotificationsByBot = useMemo(
    () =>
      new Map(
        props.bots.map((bot) => {
          const threadIds = workThreadIdsByBot.get(bot.id)
          return [
            bot.id,
            notifications.filter((item) => item.botId === bot.id && (!item.threadId || threadIds?.has(item.threadId))),
          ]
        }),
      ),
    [props.bots, notifications, workThreadIdsByBot],
  )
  const visibleBotIds = useMemo(() => new Set(props.bots.map((bot) => bot.id)), [props.bots])
  const rowAttentionIds = useMemo(() => {
    const rowNotifications =
      sidebarMode === "bots"
        ? needsYou.filter((item) => item.botId && visibleBotIds.has(item.botId))
        : Array.from(workAttentionByBot.values()).flat()

    return new Set(rowNotifications.map((item) => item.id))
  }, [sidebarMode, needsYou, visibleBotIds, workAttentionByBot])
  const barNeedsYou = needsYou.filter((item) => !rowAttentionIds.has(item.id))
  const hasNeedsYou = barNeedsYou.length > 0
  const botNavigationKey = `${props.section}:${props.advancedPage}:${props.selectedBotId}:${props.selectedThreadId}`
  useEffect(() => {
    if (savedSidebarMode !== null || hasUserSelectedMode || !(props.groups?.length ?? 0)) return

    setSidebarMode("work")
    setHasOpenedWork(true)
    props.onSidebarModeChange?.("work")
  }, [savedSidebarMode, hasUserSelectedMode, props.groups?.length, props.onSidebarModeChange])
  const selectMode = (mode: SidebarMode): void => {
    setSidebarMode(mode)
    if (mode === "work") setHasOpenedWork(true)
    setHasUserSelectedMode(true)
    props.onSidebarModeChange?.(mode)
    if (props.section !== "bots") navigate(props.onChat)
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
        const botData = sidebarDataByBot.get(bot.id)
        const threads =
          mode === "work" ? (workThreadsByBot.get(bot.id) ?? EMPTY_THREADS) : (botData?.threads ?? EMPTY_THREADS)
        const entryAttention =
          mode === "work"
            ? (workAttentionByBot.get(bot.id) ?? EMPTY_NOTIFICATIONS)
            : (attentionByBot.get(bot.id) ?? EMPTY_NOTIFICATIONS)
        const entryNotifications = mode === "work" ? (workNotificationsByBot.get(bot.id) ?? []) : notifications

        return (
          <Fragment key={`${mode}:${bot.id}`}>
            <BotEntry
              compact={mode === "work"}
              navigationKey={bot.id === props.selectedBotId ? botNavigationKey : ""}
              bot={bot}
              activity={activity?.kind ?? null}
              onHold={ordered.hold}
              insertedThreads={insertedThreads}
              threads={threads}
              conversationThreads={botData?.threads ?? EMPTY_THREADS}
              routineRuns={botData?.routineRuns ?? EMPTY_ROUTINE_RUNS}
              routineRunCountsToday={routineRunCountsToday}
              runs={runs}
              routineIds={routineIds}
              routinesById={routinesById}
              messages={messages}
              attention={entryAttention}
              notifications={entryNotifications}
              selected={selected}
              selectedThreadId={bot.id === props.selectedBotId ? props.selectedThreadId : null}
              onSelect={select}
              onSelectThread={selectThread}
              onNewThread={createThread}
              onSettings={openBotSettings}
              onRoutines={openBotRoutines}
              onRoutineHistory={openBotRoutineHistory}
              onReviewApproval={reviewApproval}
              onNotification={openNotification}
              onDelete={props.onDeleteBot ? deleteBot : undefined}
              onArchiveThread={props.onArchiveThread}
              onArchiveThreads={props.onArchiveThreads}
              onDeleteThreads={props.onDeleteThreads}
              onGetThreadDeletePreview={props.onGetThreadDeletePreview}
              onLoadArchivedThreads={props.onLoadArchivedThreads}
              threadDeletion={props.threadDeletion}
              deletedThreadIds={props.deletedThreadIds}
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
          {sidebarMode === "bots" && (
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
          )}
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
              <SidebarIcon>
                <path d="m6 6 12 12M18 6 6 18" />
              </SidebarIcon>
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
              {mode.needsYouCount > 0 && <SidebarCount count={mode.needsYouCount} label={label} tone="attention" />}
              {mode.unreadCount > 0 && <SidebarCount count={mode.unreadCount} label={label} tone="unread" />}
            </button>
          )
        })}
      </div>
      {hasNeedsYou ? (
        <NotificationAttentionBar
          notifications={barNeedsYou}
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
            <span className="visually-hidden">{t("View work")}</span>
          </button>
        )
      )}
      <div className="sidebar-panel-stack">
        <div
          id="sidebar-mode-panel-bots"
          className="sidebar-mode-panel"
          role="tabpanel"
          aria-labelledby="sidebar-mode-bots"
          tabIndex={-1}
          hidden={sidebarMode !== "bots"}
          aria-hidden={sidebarMode !== "bots" || undefined}
          inert={sidebarMode !== "bots" || undefined}
        >
          <div className="bot-groups">{renderBotEntries("bots")}</div>
        </div>
        <div
          id="sidebar-mode-panel-work"
          className="sidebar-mode-panel work-mode-panel"
          role="tabpanel"
          aria-labelledby="sidebar-mode-work"
          tabIndex={-1}
          hidden={sidebarMode !== "work"}
          aria-hidden={sidebarMode !== "work" || undefined}
          inert={sidebarMode !== "work" || undefined}
        >
          <Suspense fallback={null}>
            {props.onNewGroup && hasOpenedWork && (
              <GroupSidebar
                groups={props.groups ?? EMPTY_GROUPS}
                threads={props.threads}
                attentionThreadIds={attentionThreadIds}
                channelWorking={channelWorking}
                selectedThreadId={props.selectedThreadId}
                onSelect={selectThread}
                onCreate={createChannel}
                onInvite={props.onInvitePerson ? invitePerson : undefined}
                messages={messages}
                runs={runs}
                onSearch={openSearch}
                onEdit={editChannel}
                onDelete={props.onDeleteGroup ? deleteChannel : undefined}
                onNewThread={createChannelThread}
              />
            )}
            <div className="bot-groups work-mode-dms">{renderBotEntries("work")}</div>
          </Suspense>
        </div>
      </div>
      <div className="sidebar-footer">
        <div className="sidebar-user-row">
          <button type="button" className="user-chip" onClick={() => navigate(props.onSettings)}>
            <PersonAvatar person={props.currentPerson ?? { id: "owner", avatarSeed: "owner" }} />
            <span>
              <strong>{props.currentPerson?.handle ?? props.currentPerson?.name ?? t("Você")}</strong>
              <small title={props.serverUrl ?? undefined}>
                {props.serverMode ? t("Modo servidor") : t("Local · grátis")}
              </small>
            </span>
          </button>
          {props.onRecovery && (props.recoveryCount ?? 0) > 0 && (
            <button
              type="button"
              className="sidebar-recovery-badge"
              aria-label={t("Interrupted tasks count", { count: props.recoveryCount ?? 0 })}
              title={t("Interrupted tasks")}
              onClick={() => navigate(() => props.onRecovery?.())}
            >
              <SidebarIcon>
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
              </SidebarIcon>
              <span aria-hidden="true">{props.recoveryCount}</span>
            </button>
          )}
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

const BotEntryView = ({
  compact,
  navigationKey,
  insertedThreads,
  bot,
  activity,
  onHold,
  threads,
  conversationThreads,
  routineRuns,
  routineRunCountsToday,
  runs,
  routineIds,
  routinesById,
  messages,
  attention,
  notifications,
  selected,
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
  onArchiveThread,
  onArchiveThreads,
  onDeleteThreads,
  onGetThreadDeletePreview,
  onLoadArchivedThreads,
  threadDeletion,
  deletedThreadIds,
}: {
  deletedThreadIds?: ReadonlySet<string> | undefined
  threadDeletion?: ThreadDeletion | undefined
  navigationKey: string
  compact: boolean
  bot: Bot
  activity: BotActivityKind | null
  onHold: (botId: Id, reason: HoldReason, active: boolean) => void
  insertedThreads: ReadonlySet<string>
  threads: Array<Thread>
  conversationThreads: Array<Thread>
  routineRuns: Array<RoutineRun>
  routineRunCountsToday: ReadonlyMap<string, number>
  runs: Array<Run>
  routineIds: ReadonlySet<string> | undefined
  routinesById: ReadonlyMap<string, Routine>
  messages: Array<Message>
  attention: Array<NotificationRecord>
  notifications: Array<NotificationRecord>
  selected: boolean
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
  onArchiveThread?: ((threadId: string, archived: boolean) => Promise<Thread>) | undefined
  onArchiveThreads?: ((threadIds: Array<string>, archived: boolean) => Promise<void>) | undefined
  onDeleteThreads?: ((threadIds: Array<string>, botId: string) => Promise<void>) | undefined
  onGetThreadDeletePreview?:
    | ((threadId: string) => Promise<ApiRoutes["GET /threads/:id/delete-preview"]["res"]>)
    | undefined
  onLoadArchivedThreads?: ((botId: string, before?: string) => Promise<Array<Thread>>) | undefined
}) => {
  const [menuOpen, setMenuOpen] = useState(false)
  const [conversationsOpen, setConversationsOpen] = useState(false)
  const [compactOpen, setCompactOpen] = useState(false)
  const compactTreeId = useId()
  const showTree = conversationsOpen
  const openConversations = (): void => {
    setCompactOpen(false)
    setConversationsOpen(true)
  }
  const selectConversation = (threadId: Id): void => {
    setConversationsOpen(false)
    onSelectThread(threadId)
  }
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectionPage, setSelectionPage] = useState(0)
  const [selectedThreadIds, setSelectedThreadIds] = useState<Set<string>>(new Set())
  const [archivedThreads, setArchivedThreads] = useState<Array<Thread>>([])
  const [archivedLoaded, setArchivedLoaded] = useState(false)
  const [archivePage, setArchivePage] = useState(0)
  const [archiveCursor, setArchiveCursor] = useState<string | undefined>()
  const archiveEntries = useMemo(
    () =>
      Array.from(
        new Map(archivedThreads.concat(conversationThreads).map((thread) => [thread.id, thread])).values(),
      ).filter((thread) => thread.archivedAt !== null && !thread.groupId && !deletedThreadIds?.has(thread.id)),
    [archivedThreads, conversationThreads, deletedThreadIds],
  )
  const visibleArchivePage = Math.min(archivePage, Math.max(0, Math.ceil(archiveEntries.length / 100) - 1))
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [archivedLoading, setArchivedLoading] = useState(false)
  const [deleteTargets, setDeleteTargets] = useState<Array<ThreadDeleteTarget> | null>(null)
  const [oldAutomaticOpen, setOldAutomaticOpen] = useState(false)
  const pendingDelete = threadDeletion?.pending ?? null
  const [actionError, setActionError] = useState<string | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: dismiss on any navigation, including another bot's thread
  useEffect(() => {
    setMenuOpen(false)
    setCompactOpen(false)
    setConversationsOpen(false)
    setSelectionMode(false)
    setSelectionPage(0)
    setSelectedThreadIds(new Set())
  }, [navigationKey])
  const [deleting, setDeleting] = useState(false)
  const snapshot = useMascotSnapshot(bot)
  const ids = threads.map((thread) => thread.id)
  const botMessages = messages.filter((message) => ids.includes(message.threadId))
  const latestAssistant = botMessages.reduce<Message | undefined>((latest, message) => {
    if (message.role !== "assistant") return latest
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
  const unread = threads.reduce((count, thread) => count + (thread.id === selectedThreadId ? 0 : thread.unread), 0)
  const preview = latestPreview({ threadIds: ids, messages, runs })
  const rowTime = getSidebarRowTime(getLastActivityAt(threads.filter((thread) => thread.archivedAt === null)))
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
  const canShowTrailingState = !compact || badgeState !== "running"
  const trailingState = !hasActionBadge && badgeState && canShowTrailingState ? badgeState : null
  // A dismissed or superseded failure must not keep the sidebar mascot in an error pose.
  const avatarState = snapshot.state === "error" && !failed ? "idle" : undefined
  const activityKind = activity
  const runningThreadIds = useMemo(
    () =>
      new Set([
        ...messages.filter((message) => message.status === "streaming").map((message) => message.threadId),
        ...runs.filter((run) => ["queued", "starting", "running"].includes(run.status)).map((run) => run.threadId),
      ]),
    [messages, runs],
  )
  const sidebarThreads = useMemo(
    () =>
      showTree || compactOpen
        ? getSidebarThreads(
            conversationThreads.filter((thread) => thread.archivedAt === null),
            routineRuns,
            selectedThreadId,
            runningThreadIds,
            routineIds,
            routineRunCountsToday,
          )
        : [],
    [
      showTree,
      compactOpen,
      conversationThreads,
      routineRuns,
      selectedThreadId,
      runningThreadIds,
      routineIds,
      routineRunCountsToday,
    ],
  )
  const [showAllConversations, setShowAllConversations] = useState(false)
  const [conversationPage, setConversationPage] = useState(0)
  const routineEntries = sidebarThreads.filter((entry) => entry.thread.kind === "routine" && !entry.deletedRoutine)
  const conversationEntries = sidebarThreads.filter((entry) => !routineEntries.includes(entry))
  const recentConversations = conversationEntries.slice(0, MAX_SIDEBAR_CONVERSATIONS)
  const selectedConversation = conversationEntries.find((entry) => entry.thread.id === selectedThreadId)
  const compactConversations =
    selectedConversation && !recentConversations.includes(selectedConversation)
      ? recentConversations.slice(0, MAX_SIDEBAR_CONVERSATIONS - 1).concat(selectedConversation)
      : recentConversations
  const visibleConversationPage = Math.min(
    conversationPage,
    Math.max(0, Math.ceil(conversationEntries.length / 100) - 1),
  )
  const shownConversations = showAllConversations
    ? conversationEntries.slice(visibleConversationPage * 100, (visibleConversationPage + 1) * 100)
    : compactConversations
  const botUnread = unread
  const hiddenConversationCount = conversationEntries.length - shownConversations.length
  const selectedRoutineEntry = routineEntries.find((entry) => entry.thread.id === selectedThreadId)
  const labelledRoutineEntry = selectedRoutineEntry ?? routineEntries[0]
  const routineRunLabel = labelledRoutineEntry
    ? getRoutineRunSidebarDateLabel(
        labelledRoutineEntry.routineRun?.scheduledFor ?? labelledRoutineEntry.thread.createdAt,
        "pt-BR",
        routinesById.get(labelledRoutineEntry.routineRun?.routineId ?? "")?.timezone,
      )
    : ""
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
  const selectableThreads = conversationThreads.filter((thread) => !thread.groupId && thread.archivedAt === null)
  const visibleSelectionPage = Math.min(selectionPage, Math.max(0, Math.ceil(selectableThreads.length / 100) - 1))
  const automaticThreads = selectableThreads.filter((thread) =>
    isRoutineConversation({ thread, runs, routineRuns, routines: [...routinesById.values()] }),
  )
  const hiddenThreadIds = new Set(pendingDelete?.targets.map((target) => target.id) ?? [])
  const compactSidebarThreads = sidebarThreads.filter(({ thread }) => !hiddenThreadIds.has(thread.id))
  const hasCompactHistory =
    !compact &&
    conversationThreads.filter(
      (thread) =>
        thread.archivedAt === null && !thread.groupId && !thread.groupThreadId && !hiddenThreadIds.has(thread.id),
    ).length > 1
  const openDeletePrompt = async (thread: Thread): Promise<void> => {
    if (!onGetThreadDeletePreview || pendingDelete) return
    setActionError(null)
    try {
      const preview = await onGetThreadDeletePreview(thread.id)
      setDeleteTargets([{ ...preview.thread, messageCount: preview.messageCount }])
    } catch (error) {
      setActionError(getThreadDeletionError(error))
    }
  }
  const openSelectedDeletePrompt = async (): Promise<void> => {
    if (!onGetThreadDeletePreview || pendingDelete) return
    const targets = selectableThreads.filter((thread) => selectedThreadIds.has(thread.id))
    setActionError(null)
    try {
      const batches = Array.from({ length: Math.ceil(targets.length / 8) }, (_, index) =>
        targets.slice(index * 8, (index + 1) * 8),
      )
      const previews: Array<ThreadDeleteTarget> = []
      for (const batch of batches) {
        const results = await Promise.all(batch.map((thread) => onGetThreadDeletePreview(thread.id)))
        // This local accumulator is limited to the 200 selected conversations.
        previews.push(...results.map((preview) => ({ ...preview.thread, messageCount: preview.messageCount })))
      }
      setDeleteTargets(previews)
    } catch (error) {
      setActionError(getThreadDeletionError(error))
    }
  }
  const queueDelete = (targets: Array<ThreadDeleteTarget>): void => {
    const ids = new Set(targets.map((target) => target.id))
    if (
      !threadDeletion?.queue(bot.id, targets, () => {
        setArchivedThreads((current) => current.filter((thread) => !ids.has(thread.id)))
      })
    )
      return
    setDeleteTargets(null)
    setConversationsOpen(false)
    setSelectedThreadIds(new Set())
  }
  const archiveOne = async (thread: Thread, archived: boolean): Promise<void> => {
    if (!onArchiveThread) return
    setActionError(null)
    try {
      const updated = await onArchiveThread(thread.id, archived)
      setArchivedThreads((current) =>
        archived
          ? [updated, ...current.filter((candidate) => candidate.id !== updated.id)]
          : current.filter((candidate) => candidate.id !== updated.id),
      )
    } catch (error) {
      if (error instanceof ApiError && error.errorCode === "THREAD_ACTIVE") {
        setActionError(t("Finish the active run before archiving this conversation."))
        return
      }
      setActionError(t("Could not update this conversation. Try again."))
    }
  }
  const openArchivedThread = async (thread: Thread): Promise<void> => {
    if (!onArchiveThread) return
    setActionError(null)
    try {
      const updated = await onArchiveThread(thread.id, false)
      setArchivedThreads((current) => current.filter((candidate) => candidate.id !== updated.id))
      selectConversation(updated.id)
    } catch (error) {
      if (error instanceof ApiError && error.errorCode === "THREAD_ACTIVE") {
        setActionError(t("Finish the active run before archiving this conversation."))
        return
      }
      setActionError(t("Could not update this conversation. Try again."))
    }
  }
  const archiveSelected = async (): Promise<void> => {
    if (!onArchiveThreads) return
    const threadIds = selectableThreads.filter((thread) => selectedThreadIds.has(thread.id)).map((thread) => thread.id)
    if (!threadIds.length) return
    setActionError(null)
    try {
      await onArchiveThreads(threadIds, true)
      setSelectedThreadIds(new Set())
      setSelectionMode(false)
    } catch {
      setActionError(t("Could not update these conversations. Try again."))
    }
  }
  const toggleArchives = async (): Promise<void> => {
    const open = !archivedOpen
    setArchivedOpen(open)
    if (!open || archivedLoaded || !onLoadArchivedThreads) return
    setArchivedLoading(true)
    setActionError(null)
    try {
      const page = await onLoadArchivedThreads(bot.id)
      setArchivedThreads(page)
      setArchivePage(0)
      setArchiveCursor(page.length === 100 ? page.at(-1)?.id : undefined)
      setArchivedLoaded(true)
    } catch {
      setActionError(t("Could not load archived conversations."))
    } finally {
      setArchivedLoading(false)
    }
  }
  const loadMoreArchives = async (): Promise<void> => {
    if (!onLoadArchivedThreads || !archiveCursor || archivedLoading) return
    setArchivedLoading(true)
    try {
      const page = await onLoadArchivedThreads(bot.id, archiveCursor)
      setArchivedThreads((current) => [...current, ...page])
      if (page.length) setArchivePage(visibleArchivePage + 1)
      setArchiveCursor(page.length === 100 ? page.at(-1)?.id : undefined)
    } catch {
      setActionError(t("Could not load archived conversations."))
    } finally {
      setArchivedLoading(false)
    }
  }
  const toggleSelection = (threadId: string): void => {
    if (selectedThreadIds.has(threadId)) {
      setSelectedThreadIds(new Set([...selectedThreadIds].filter((id) => id !== threadId)))
      return
    }
    if (selectedThreadIds.size >= 200) {
      setActionError(t("Select up to {count} conversations.", { count: 200 }))
      return
    }
    setSelectedThreadIds(new Set([...selectedThreadIds, threadId]))
  }
  const selectAll = (): void => {
    setSelectedThreadIds(
      new Set(
        selectableThreads
          .filter((thread) => thread.kind !== "main")
          .slice(0, 200)
          .map((thread) => thread.id),
      ),
    )
  }
  const deleteOldAutomatic = (_days: number, oldThreads: Array<Thread>): void => {
    setOldAutomaticOpen(false)
    setDeleteTargets(
      oldThreads.map((thread) => ({ id: thread.id, title: getSidebarThreadTitle(thread), messageCount: null })),
    )
    setActionError(null)
  }
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover and focus only pause reordering; they trigger no action
    <div
      className={`bot-entry ${compact ? "compact-dm" : ""}`}
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
        leading={<BotAvatar bot={bot} size={32} {...(avatarState ? { state: avatarState } : {})} motion="idle" />}
        label={<BotRowLabel bot={bot} preview={status || preview || t("Start a conversation")} time={rowTime} />}
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
            {hasCompactHistory && (
              <button
                type="button"
                className="bot-thread-toggle"
                aria-label={t("Conversations for {name}", { name: bot.name })}
                aria-expanded={compactOpen}
                aria-controls={compactOpen ? compactTreeId : undefined}
                onClick={() => setCompactOpen(!compactOpen)}
              >
                <SidebarIcon>
                  <path d="m9 6 6 6-6 6" />
                </SidebarIcon>
              </button>
            )}
            <BotActionsMenu
              name={bot.name}
              open={menuOpen}
              onOpenChange={setMenuOpen}
              onSettings={() => onSettings(bot.id)}
              onRoutines={() => onRoutines(bot.id)}
              onConversations={openConversations}
              conversations={{
                onNewThread: () => onNewThread(bot.id),
                onSelectThreads:
                  onArchiveThreads || onDeleteThreads
                    ? () => {
                        openConversations()
                        setSelectionMode(true)
                      }
                    : undefined,
                onDeleteOldAutomatic: onDeleteThreads ? () => setOldAutomaticOpen(true) : undefined,
                onArchived: onLoadArchivedThreads
                  ? () => {
                      openConversations()
                      if (!archivedOpen) void toggleArchives()
                    }
                  : undefined,
              }}
              onDelete={onDelete ? () => setDeleting(true) : undefined}
            />
          </>
        }
        onClick={() => onSelect(bot.id)}
        onContextMenu={(event) => {
          event.preventDefault()
          setMenuOpen(true)
        }}
      />
      {deleting && onDelete && <DeleteBotDialog bot={bot} onDelete={onDelete} onClose={() => setDeleting(false)} />}
      {hasCompactHistory && compactOpen && !conversationsOpen && (
        <section
          className="bot-thread-tree"
          id={compactTreeId}
          aria-label={t("Recent conversations for {name}", { name: bot.name })}
        >
          {compactSidebarThreads.slice(0, MAX_SIDEBAR_CONVERSATIONS).map(({ thread }) => (
            <button
              key={thread.id}
              type="button"
              className={`thread-row ${thread.id === selectedThreadId ? "selected" : ""}`}
              aria-current={thread.id === selectedThreadId ? "page" : undefined}
              onClick={() => selectConversation(thread.id)}
            >
              <span className="thread-copy">
                <strong>{getSidebarThreadTitle(thread)}</strong>
                <small>{relativeThreadDate(thread.updatedAt)}</small>
              </span>
            </button>
          ))}
          {compactSidebarThreads.length > MAX_SIDEBAR_CONVERSATIONS && (
            <button
              type="button"
              className="new-thread-row"
              onClick={() => {
                openConversations()
                setShowAllConversations(true)
                setConversationPage(0)
              }}
            >
              {t("See all conversations")}
            </button>
          )}
        </section>
      )}
      {showTree && (
        <Modal
          title={t("Conversations for {name}", { name: bot.name })}
          className="bot-conversations-dialog r8-sidebar"
          onClose={() => setConversationsOpen(false)}
        >
          <section className="bot-thread-tree" aria-label={t("Conversations for {name}", { name: bot.name })}>
            <div className="thread-list-tools">
              {(onArchiveThreads || onDeleteThreads) && (
                <button
                  type="button"
                  className="thread-list-tool"
                  aria-pressed={selectionMode}
                  onClick={() => {
                    setSelectionMode(!selectionMode)
                    setSelectionPage(0)
                    setSelectedThreadIds(new Set())
                  }}
                >
                  {t(selectionMode ? "Exit selection" : "Select")}
                </button>
              )}
              {selectionMode && (
                <>
                  <button type="button" className="thread-list-tool" onClick={selectAll}>
                    {t("Select all")}
                  </button>
                  <span className="thread-selection-count" role="status">
                    {t("Selected: {count}", { count: selectedThreadIds.size })}
                  </span>
                  {onArchiveThreads && (
                    <button
                      type="button"
                      className="thread-list-tool"
                      disabled={!selectedThreadIds.size || Boolean(pendingDelete)}
                      onClick={() => void archiveSelected()}
                    >
                      {t("Archive selected")}
                    </button>
                  )}
                  {onDeleteThreads && (
                    <button
                      type="button"
                      className="thread-list-tool thread-list-tool-danger"
                      disabled={!selectedThreadIds.size || Boolean(pendingDelete)}
                      onClick={() => void openSelectedDeletePrompt()}
                    >
                      {t("Delete selected…")}
                    </button>
                  )}
                </>
              )}
            </div>
            {actionError && (
              <p className="thread-action-error" role="alert">
                {actionError}
                <button type="button" aria-label={t("Dismiss notice")} onClick={() => setActionError(null)}>
                  ×
                </button>
              </p>
            )}
            {selectionMode
              ? selectableThreads
                  .slice(visibleSelectionPage * 100, (visibleSelectionPage + 1) * 100)
                  .filter((thread) => !hiddenThreadIds.has(thread.id))
                  .map((thread) => (
                    <FullThreadRow
                      key={thread.id}
                      inserted={insertedThreads.has(thread.id)}
                      thread={thread}
                      title={getSidebarThreadTitle(thread)}
                      countLabel={relativeThreadDate(thread.updatedAt)}
                      dateLabel={relativeThreadDate(thread.updatedAt)}
                      dateTitle={undefined}
                      unread={thread.unread}
                      selected={thread.id === selectedThreadId}
                      running={runningThreadIds.has(thread.id)}
                      onClick={() => selectConversation(thread.id)}
                      selectionMode
                      checked={selectedThreadIds.has(thread.id)}
                      selectionDisabled={thread.kind === "main" || thread.id === bot.mainThreadId}
                      onToggleSelect={() => toggleSelection(thread.id)}
                      canArchive={thread.kind !== "main" && thread.id !== bot.mainThreadId}
                      onArchive={onArchiveThread ? () => void archiveOne(thread, true) : undefined}
                      onDelete={onGetThreadDeletePreview ? () => void openDeletePrompt(thread) : undefined}
                    />
                  ))
              : shownConversations
                  .filter(({ thread }) => !hiddenThreadIds.has(thread.id))
                  .map(({ thread, routineRun, taskGroupName, countToday, running, unread, deletedRoutine }) => {
                    const timestamp = routineRun?.scheduledFor ?? thread.createdAt
                    const routine = routineRun ? routinesById.get(routineRun.routineId) : undefined
                    const timeZone = routine?.timezone
                    const title = deletedRoutine
                      ? t("Deleted routine")
                      : routineRun
                        ? t("Routine row title", { name: routine?.name ?? getSidebarThreadTitle(thread) })
                        : taskGroupName
                          ? t("Task row title", { name: taskGroupName })
                          : getSidebarThreadTitle(thread)
                    const countLabel =
                      (routineRun || taskGroupName) && countToday > 0
                        ? t("Today count suffix", { count: countToday })
                        : undefined
                    const dateLabel =
                      thread.kind === "routine"
                        ? getRoutineRunSidebarDateLabel(timestamp, "pt-BR", timeZone)
                        : relativeThreadDate(thread.updatedAt)
                    const dateTitle =
                      thread.kind === "routine" ? getRoutineRunDateLabel(timestamp, "pt-BR", timeZone) : undefined
                    const secondaryLabel = routineRun
                      ? [countLabel, dateLabel].filter(Boolean).join(" · ")
                      : (countLabel ?? dateLabel)

                    return (
                      <Fragment key={thread.id}>
                        <FullThreadRow
                          inserted={insertedThreads.has(thread.id)}
                          thread={thread}
                          title={title}
                          countLabel={secondaryLabel}
                          dateLabel={dateLabel}
                          dateTitle={dateTitle}
                          unread={unread}
                          selected={thread.id === selectedThreadId}
                          running={running}
                          onClick={() => selectConversation(thread.id)}
                          canArchive={thread.kind !== "main" && thread.id !== bot.mainThreadId}
                          onArchive={onArchiveThread ? () => void archiveOne(thread, true) : undefined}
                          onDelete={onGetThreadDeletePreview ? () => void openDeletePrompt(thread) : undefined}
                        />
                        {taskGroupName && (
                          <ThreadGroupHistory
                            label={t("Task conversation history for {name}", { name: taskGroupName })}
                            threads={conversationThreads}
                            routineRuns={routineRuns}
                            routineIds={routineIds}
                            groupThreadId={thread.id}
                            selectedThreadId={selectedThreadId}
                            onSelectThread={selectConversation}
                          />
                        )}
                      </Fragment>
                    )
                  })}
            {selectionMode && selectableThreads.length > 100 && (
              <div className="thread-list-tools">
                <button
                  type="button"
                  className="thread-list-tool"
                  disabled={visibleSelectionPage === 0}
                  onClick={() => setSelectionPage(visibleSelectionPage - 1)}
                >
                  {t("Previous conversations")}
                </button>
                <button
                  type="button"
                  className="thread-list-tool"
                  disabled={(visibleSelectionPage + 1) * 100 >= selectableThreads.length}
                  onClick={() => setSelectionPage(visibleSelectionPage + 1)}
                >
                  {t("Next conversations")}
                </button>
              </div>
            )}
            {hiddenConversationCount > 0 && !showAllConversations && (
              <button type="button" className="new-thread-row" onClick={() => setShowAllConversations(true)}>
                {t("Show more conversations", { count: hiddenConversationCount })}
              </button>
            )}
            {!selectionMode && showAllConversations && conversationEntries.length > 100 && (
              <div className="thread-list-tools">
                <button
                  type="button"
                  className="thread-list-tool"
                  disabled={visibleConversationPage === 0}
                  onClick={() => setConversationPage(visibleConversationPage - 1)}
                >
                  {t("Previous conversations")}
                </button>
                <button
                  type="button"
                  className="thread-list-tool"
                  disabled={(visibleConversationPage + 1) * 100 >= conversationEntries.length}
                  onClick={() => setConversationPage(visibleConversationPage + 1)}
                >
                  {t("Next conversations")}
                </button>
              </div>
            )}
            {visibleRoutineIds.length > 0 && (
              <RoutinesRow
                selected={selectedRoutineEntry !== undefined}
                runLabel={routineRunLabel}
                running={routineEntries.some((entry) => entry.running)}
                unread={routineEntries.reduce((count, entry) => count + entry.unread, 0)}
                todayCount={visibleRoutineIds.reduce((count, id) => count + (routineRunCountsToday.get(id) ?? 0), 0)}
                onClick={() => {
                  setConversationsOpen(false)
                  onRoutineHistory(bot.id, historyRoutineId)
                }}
              />
            )}
            {deletedRoutine && (
              <ThreadGroupHistory
                label={t("Deleted routine conversations")}
                threads={conversationThreads}
                routineRuns={routineRuns}
                routineIds={routineIds}
                groupThreadId={deletedRoutine.thread.id}
                selectedThreadId={selectedThreadId}
                onSelectThread={selectConversation}
              />
            )}
            {onDeleteThreads && (
              <button type="button" className="new-thread-row" onClick={() => setOldAutomaticOpen(true)}>
                {t("Delete old automatic conversations…")}
              </button>
            )}
            <button
              type="button"
              className="new-thread-row"
              onClick={() => {
                setConversationsOpen(false)
                onNewThread(bot.id)
              }}
            >
              <SidebarIcon>
                <path d="M12 5v14M5 12h14" />
              </SidebarIcon>
              {t("Nova conversa")}
            </button>
            {onLoadArchivedThreads && (
              <>
                <button
                  type="button"
                  className="archived-threads-toggle"
                  aria-expanded={archivedOpen}
                  onClick={() => void toggleArchives()}
                >
                  {t("Archived")}
                  <span>{archiveEntries.length}</span>
                </button>
                {archivedOpen && (
                  <section className="archived-thread-list" aria-label={t("Archived")}>
                    {archivedLoading ? (
                      <p className="field-help">{t("Loading archived conversations…")}</p>
                    ) : archiveEntries.filter((thread) => !hiddenThreadIds.has(thread.id)).length ? (
                      archiveEntries
                        .slice(visibleArchivePage * 100, (visibleArchivePage + 1) * 100)
                        .filter((thread) => !hiddenThreadIds.has(thread.id))
                        .map((thread) => (
                          <FullThreadRow
                            key={thread.id}
                            inserted={false}
                            thread={thread}
                            title={getSidebarThreadTitle(thread)}
                            countLabel={relativeThreadDate(thread.updatedAt)}
                            dateLabel={relativeThreadDate(thread.updatedAt)}
                            dateTitle={undefined}
                            unread={thread.unread}
                            selected={thread.id === selectedThreadId}
                            running={runningThreadIds.has(thread.id)}
                            onClick={() => void openArchivedThread(thread)}
                            archived
                            canArchive={thread.kind !== "main" && thread.id !== bot.mainThreadId}
                            onArchive={onArchiveThread ? () => void archiveOne(thread, false) : undefined}
                            onDelete={onGetThreadDeletePreview ? () => void openDeletePrompt(thread) : undefined}
                          />
                        ))
                    ) : (
                      <p className="field-help">{t("No archived conversations.")}</p>
                    )}
                    {visibleArchivePage > 0 && (
                      <button
                        type="button"
                        className="new-thread-row"
                        onClick={() => setArchivePage(visibleArchivePage - 1)}
                      >
                        {t("Previous archived conversations")}
                      </button>
                    )}
                    {(archiveCursor || (visibleArchivePage + 1) * 100 < archiveEntries.length) && (
                      <button
                        type="button"
                        className="new-thread-row"
                        disabled={archivedLoading}
                        onClick={() => {
                          if ((visibleArchivePage + 1) * 100 < archiveEntries.length) {
                            setArchivePage(visibleArchivePage + 1)
                            return
                          }
                          void loadMoreArchives()
                        }}
                      >
                        {t("Load more archived conversations")}
                      </button>
                    )}
                  </section>
                )}
              </>
            )}
          </section>
        </Modal>
      )}
      {deleteTargets && (
        <DeleteThreadDialog
          targets={deleteTargets}
          onClose={() => setDeleteTargets(null)}
          onConfirm={() => queueDelete(deleteTargets)}
        />
      )}
      {oldAutomaticOpen && (
        <DeleteOldAutomaticThreadsDialog
          threads={automaticThreads.filter((thread) => !runningThreadIds.has(thread.id))}
          onClose={() => setOldAutomaticOpen(false)}
          onContinue={deleteOldAutomatic}
        />
      )}
    </div>
  )
}

const BotEntry = memo(BotEntryView)

const FullThreadRow = ({
  inserted,
  thread,
  title,
  countLabel,
  dateLabel,
  dateTitle,
  unread,
  selected,
  running,
  onClick,
  archived = false,
  canArchive = true,
  onArchive,
  onDelete,
  selectionMode = false,
  checked = false,
  selectionDisabled = false,
  onToggleSelect,
}: {
  thread: Thread
  title: string
  countLabel: string | undefined
  dateLabel: string
  dateTitle: string | undefined
  unread: number
  inserted: boolean
  selected: boolean
  running: boolean
  onClick: () => void
  archived?: boolean
  canArchive?: boolean
  onArchive?: (() => void) | undefined
  onDelete?: (() => void) | undefined
  selectionMode?: boolean
  checked?: boolean
  selectionDisabled?: boolean
  onToggleSelect?: (() => void) | undefined
}) => {
  const titleId = useId()

  return (
    <div className="thread-row-shell" data-motion-insert={inserted}>
      {selectionMode && (
        <label className="thread-selection-control">
          <input
            type="checkbox"
            className="thread-selection-checkbox"
            checked={checked}
            disabled={selectionDisabled}
            aria-label={t("Select conversation {title}", { title })}
            onChange={onToggleSelect}
          />
        </label>
      )}
      <button
        type="button"
        className={`thread-row ${selected ? "selected" : ""}`}
        onClick={selectionMode && !selectionDisabled ? onToggleSelect : onClick}
        aria-label={archived ? t("Open archived conversation {title}", { title }) : undefined}
        aria-current={selected ? "page" : undefined}
        aria-pressed={selectionMode ? checked : undefined}
      >
        <span className="thread-icon" aria-hidden="true">
          {thread.kind === "routine" ? (
            <SidebarIcon>
              <circle cx="12" cy="12" r="8" />
              <path d="M12 7v5l3 2" />
            </SidebarIcon>
          ) : (
            <SidebarIcon>
              <path d="M5 5h14v10H9l-4 4Z" />
            </SidebarIcon>
          )}
        </span>
        <span className="thread-copy">
          <strong id={titleId} title={thread.kind === "routine" ? `${title} · ${dateTitle ?? dateLabel}` : title}>
            {title}
          </strong>
          <small>{countLabel ?? dateLabel}</small>
        </span>
        {running ? (
          <span className="sidebar-status-dot state-running" role="img" aria-label={t("Em execução")} />
        ) : unread > 0 ? (
          <span className="sidebar-unread" role="img" aria-label={t("Unread messages", { count: unread })}>
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </button>
      {!selectionMode && (onArchive || onDelete) && (
        <ThreadActionsMenu
          title={title}
          titleId={titleId}
          archived={archived}
          canArchive={canArchive}
          {...(onArchive ? { onArchive } : {})}
          {...(onDelete ? { onDelete } : {})}
        />
      )}
    </div>
  )
}
