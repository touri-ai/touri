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
import { Fragment, type ReactNode, useEffect, useMemo, useState } from "react"
import { type ApprovalTarget, pendingApprovalTargets } from "../approvalNavigation"
import { reconcileApprovalMessages } from "../approvalState"
import { BOT_ACTIVITY_LABELS, type BotActivity } from "../botActivity"
import { latestPreview } from "../botPreview"
import { paletteShortcutLabel } from "../features/commandPalette/shortcut"
import { getRoutineRunDateLabel, getRoutineRunSidebarDateLabel, t } from "../i18n"
import {
  isFailureNotice,
  pendingNotifications,
  reconcileFailureNotifications,
  relativeThreadDate,
} from "../sidebarAttention"
import { getSidebarDataByBot, getSidebarThreads } from "../sidebarThreads"
import { getSidebarThreadTitle } from "../sidebarThreadTitle"
import { useMascotSnapshot } from "./AvatarRuntime"
import { BotActionsMenu } from "./BotActionsMenu"
import { BotAvatar } from "./BotAvatar"
import { DeleteBotDialog } from "./DeleteBotDialog"
import { DeletedRoutineHistory } from "./DeletedRoutineHistory"
import { GlobalAdvancedMenu } from "./GlobalAdvancedMenu"
import { GroupSidebar } from "./Groups"
import { useInsertedIds } from "./Motion"
import { mascotIsBusy } from "./mascotState"
import { type NotificationActions, NotificationBell } from "./NotificationCenter"
import { type HoldReason, useSidebarOrder } from "./useSidebarOrder"
import "./bot-sidebar.css"

type SidebarProps = {
  serverMode?: boolean
  serverUrl?: string | null
  host?: HostKind
  onNavigate?: () => void
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
  onNotificationsOpen: (open: boolean) => void
  notificationActions: NotificationActions
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
  const sidebarDataByBot = useMemo(
    () => getSidebarDataByBot(props.threads, props.routineRuns ?? []),
    [props.threads, props.routineRuns],
  )
  const workRuns = props.workRuns ?? []
  const runningWorkCount = workRuns.filter((run) => run.status !== "queued").length
  const queuedWorkCount = workRuns.filter((run) => run.status === "queued").length
  const hasWork = runningWorkCount + queuedWorkCount > 0
  const routineIds = useMemo(
    () => props.routines && new Set(props.routines.map((routine) => routine.id)),
    [props.routines],
  )
  const routinesById = useMemo(
    () => new Map((props.routines ?? []).map((routine) => [routine.id, routine])),
    [props.routines],
  )
  const openRoutineHistory = props.onRoutineHistory ?? props.onRoutines
  const selectedRoutineThreadId = props.threads.find(
    (thread) => thread.id === props.selectedThreadId && thread.kind === "routine",
  )?.id
  const selectedRoutineId = props.routineRuns?.find((run) => run.threadId === selectedRoutineThreadId)?.routineId
  const navigate = (action: () => void): void => {
    props.onNavigate?.()
    action()
  }
  // Switching bots inside Preview keeps that view; global pages return to the bot conversation.
  const select = (id: Id): void => {
    props.onNavigate?.()
    props.onSelect(id)
    if (props.section !== "bots") props.onChat()
  }
  const selectThread = (id: Id): void => {
    props.onNavigate?.()
    props.onSelectThread(id)
    if (props.section !== "bots") props.onChat()
  }
  const insertedThreads = useInsertedIds(props.threads.map((thread) => thread.id))
  const messages = useMemo(
    () => reconcileApprovalMessages(props.messages, props.notifications),
    [props.messages, props.notifications],
  )
  const notifications = useMemo(
    () => reconcileFailureNotifications(props.notifications, props.runs ?? []),
    [props.notifications, props.runs],
  )
  const attention = useMemo(() => pendingNotifications(notifications, messages), [notifications, messages])
  const ordered = useSidebarOrder({ ...props, messages, notifications, attention })
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
      <div className="sidebar-list-heading">
        <button
          type="button"
          className="sidebar-bots-link"
          aria-current={props.section === "bots" ? "page" : undefined}
          onClick={() => navigate(props.onChat)}
        >
          {t("Bots")} <span>{props.bots.length}</span>
        </button>
      </div>
      {hasWork && (
        <button
          type="button"
          className="sidebar-work-badge"
          aria-label={t("View work summary", { running: runningWorkCount, queued: queuedWorkCount })}
          onClick={() => navigate(() => props.onAdvancedPage("work"))}
        >
          <span>
            {t("Working")} <strong>{runningWorkCount}</strong>
          </span>
          <span>{t("Work queued count", { count: queuedWorkCount })}</span>
          <span className="sidebar-work-action">
            {t("View work")} <span aria-hidden="true">›</span>
          </span>
        </button>
      )}
      <div className="bot-groups">
        <div className="bot-list" ref={ordered.listRef}>
          {ordered.bots.map((bot, index) => {
            const kind = ordered.activity.get(bot.id)?.kind
            const group = kind === "needs-you" ? "needs-you" : kind === "working" ? "working" : "idle"
            const previousKind = ordered.activity.get(ordered.bots[index - 1]?.id ?? "")?.kind
            const previousGroup =
              previousKind === "needs-you" ? "needs-you" : previousKind === "working" ? "working" : "idle"
            return (
              <Fragment key={bot.id}>
                {(index === 0 || group !== previousGroup) && (
                  <h2 className="bot-status-heading">
                    {t(group === "needs-you" ? "Needs you" : group === "working" ? "Working" : "Idle bots")}
                  </h2>
                )}
                <BotEntry
                  key={bot.id}
                  navigationKey={`${props.section}:${props.advancedPage}:${props.selectedBotId}:${props.selectedThreadId}`}
                  bot={bot}
                  activity={ordered.activity.get(bot.id) ?? null}
                  onHold={ordered.hold}
                  insertedThreads={insertedThreads}
                  threads={sidebarDataByBot.get(bot.id)?.threads ?? []}
                  routineRuns={sidebarDataByBot.get(bot.id)?.routineRuns ?? []}
                  runs={props.runs ?? []}
                  routineIds={routineIds}
                  routinesById={routinesById}
                  messages={messages}
                  attention={attention.filter((item) => item.botId === bot.id)}
                  notifications={notifications}
                  selected={
                    props.section === "bots" &&
                    bot.id === props.selectedBotId &&
                    !props.threads.find((t) => t.id === props.selectedThreadId)?.groupId
                  }
                  expanded={
                    bot.id === props.selectedBotId &&
                    !props.threads.find((t) => t.id === props.selectedThreadId)?.groupId
                  }
                  selectedThreadId={props.section === "bots" ? props.selectedThreadId : null}
                  onSelect={() => select(bot.id)}
                  onSelectThread={selectThread}
                  onNewThread={() => {
                    props.onNavigate?.()
                    if (props.section !== "bots") props.onChat()
                    props.onNewThread()
                  }}
                  onSettings={() => {
                    select(bot.id)
                    props.onBotSettings()
                  }}
                  onRoutines={() => navigate(() => props.onRoutines(bot.id))}
                  onRoutineHistory={(routineId) =>
                    navigate(() => openRoutineHistory(bot.id, routineId ?? selectedRoutineId))
                  }
                  onReviewApproval={(target) => navigate(() => props.onReviewApproval(target))}
                  onNotification={(item) => navigate(() => props.notificationActions.open(item))}
                  onDelete={props.onDeleteBot}
                />
              </Fragment>
            )
          })}
        </div>
      </div>
      {props.onNewGroup && (
        <GroupSidebar
          groups={props.groups ?? []}
          bots={props.bots}
          threads={props.threads}
          selectedThreadId={props.selectedThreadId}
          onSelect={selectThread}
          onCreate={() => navigate(() => props.onNewGroup?.())}
          onEdit={(g) => navigate(() => props.onEditGroup?.(g))}
          onDelete={props.onDeleteGroup}
          onNewThread={(g) => navigate(() => props.onNewGroupThread?.(g))}
        />
      )}
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
            runs={props.runs ?? []}
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

const BotEntry = ({
  navigationKey,
  insertedThreads,
  bot,
  activity,
  onHold,
  threads,
  routineRuns,
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
  bot: Bot
  activity: BotActivity | null
  onHold: (botId: Id, reason: HoldReason, active: boolean) => void
  insertedThreads: ReadonlySet<string>
  threads: Array<Thread>
  routineRuns: Array<RoutineRun>
  runs: Array<Run>
  routineIds: ReadonlySet<string> | undefined
  routinesById: ReadonlyMap<string, Routine>
  messages: Array<Message>
  attention: Array<NotificationRecord>
  notifications: Array<NotificationRecord>
  selected: boolean
  expanded: boolean
  selectedThreadId: Id | null
  onSelect: () => void
  onSelectThread: (id: Id) => void
  onNewThread: () => void
  onSettings: () => void
  onRoutines: () => void
  onRoutineHistory: (routineId?: Id) => void
  onReviewApproval: (target: ApprovalTarget) => void
  onNotification: (item: NotificationRecord) => void
  onDelete?: ((botId: string, name: string, deleteVolumes: boolean) => Promise<void>) | undefined
}) => {
  const [menuOpen, setMenuOpen] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: dismiss on any navigation, including another bot's thread
  useEffect(() => setMenuOpen(false), [navigationKey])
  const [deleting, setDeleting] = useState(false)
  const snapshot = useMascotSnapshot(bot)
  const ids = threads.map((thread) => thread.id)
  const botMessages = messages.filter((message) => ids.includes(message.threadId))
  const latestAssistant = [...botMessages]
    .filter((message) => message.role === "assistant")
    .sort((a, b) => b.createdAt - a.createdAt)[0]
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
  const failure = attention.find(isFailureNotice)
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
        : attention.length
          ? t("review the interrupted task")
          : null
  const status = reason
    ? t("Waiting for you: {reason}", { reason })
    : failed
      ? t("Reply interrupted")
      : bot.paused
        ? t("Paused")
        : null
  const badgeState =
    approvals.length || waiting
      ? "waiting"
      : failed
        ? "failed"
        : activity?.kind === "working" ||
            mascotIsBusy(snapshot.state) ||
            botMessages.some((message) => message.status === "streaming")
          ? "running"
          : null
  // A dismissed or superseded failure must not keep the sidebar mascot in an error pose.
  const avatarState = snapshot.state === "error" && !failed ? "idle" : undefined
  const activityKind = activity?.kind ?? null
  const runningThreadIds = useMemo(
    () => new Set(messages.filter((message) => message.status === "streaming").map((message) => message.threadId)),
    [messages],
  )
  const sidebarThreads = useMemo(
    () => (expanded ? getSidebarThreads(threads, routineRuns, selectedThreadId, runningThreadIds, routineIds) : []),
    [expanded, threads, routineRuns, selectedThreadId, runningThreadIds, routineIds],
  )
  const visibleUnread = sidebarThreads.reduce((count, entry) => count + entry.unread, 0)
  const botUnread = unread - visibleUnread
  const visibleRoutineIds = sidebarThreads.flatMap(({ routineRun, deletedRoutine }) =>
    routineRun && !deletedRoutine ? [routineRun.routineId] : [],
  )
  const selectedRoutineId = sidebarThreads.find(({ thread }) => thread.id === selectedThreadId)?.routineRun?.routineId
  const historyRoutineId = selectedRoutineId ?? (visibleRoutineIds.length === 1 ? visibleRoutineIds[0] : undefined)
  const deletedRoutine = sidebarThreads.find((entry) => entry.deletedRoutine)
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover and focus only pause reordering; they trigger no action
    <div
      className={`bot-entry ${expanded ? "expanded" : ""}`}
      data-bot-entry={bot.id}
      data-activity={activityKind ?? undefined}
      onMouseEnter={() => onHold(bot.id, "hover", true)}
      onMouseLeave={() => onHold(bot.id, "hover", false)}
      onFocus={() => onHold(bot.id, "focus", true)}
      onBlur={(event) => {
        if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)))
          onHold(bot.id, "focus", false)
      }}
    >
      <div className={`bot-row ${selected ? "selected" : ""}`} data-attention={badgeState ?? undefined}>
        {activityKind && (
          <span
            className={`bot-activity-dot activity-${activityKind}`}
            role="img"
            aria-label={`${bot.name}: ${BOT_ACTIVITY_LABELS[activityKind].toLocaleLowerCase("pt-BR")}`}
            title={BOT_ACTIVITY_LABELS[activityKind]}
          />
        )}
        <button
          type="button"
          className="bot-row-main"
          onClick={onSelect}
          onContextMenu={(event) => {
            event.preventDefault()
            setMenuOpen(true)
          }}
          aria-current={selected ? "page" : undefined}
        >
          <BotAvatar bot={bot} size={30} {...(avatarState ? { state: avatarState } : {})} motion="idle" />
          <span className="bot-row-copy">
            <strong title={bot.roleLine || bot.title || undefined}>{bot.name}</strong>
            <small className="bot-role visually-hidden">{bot.roleLine || bot.title || t("Bot local")}</small>
            <small
              className={`bot-preview ${badgeState === "waiting" || badgeState === "failed" ? `state-${badgeState}` : ""}`}
              title={status || preview || undefined}
            >
              {status || preview || t("Start a conversation")}
            </small>
          </span>
        </button>
        <div className="sidebar-row-actions">
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
              {approvals.length}
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
          ) : badgeState ? (
            <span
              className={`sidebar-status-dot state-${badgeState}`}
              role="img"
              aria-label={status ?? t("Em execução")}
            />
          ) : botUnread > 0 ? (
            <span className="sidebar-unread" role="img" aria-label={t("Unread messages", { count: botUnread })}>
              {botUnread > 99 ? "99+" : botUnread}
            </span>
          ) : null}
          <BotActionsMenu
            name={bot.name}
            open={menuOpen}
            onOpenChange={setMenuOpen}
            onSettings={onSettings}
            onRoutines={onRoutines}
            onDelete={onDelete ? () => setDeleting(true) : undefined}
          />
        </div>
      </div>
      {deleting && onDelete && <DeleteBotDialog bot={bot} onDelete={onDelete} onClose={() => setDeleting(false)} />}
      {expanded && (
        <section className="bot-thread-tree" aria-label={t("Conversations for {name}", { name: bot.name })}>
          {sidebarThreads.map(({ thread, routineRun, running, unread, deletedRoutine }) => {
            const timestamp = routineRun?.scheduledFor ?? thread.createdAt
            const timeZone = routineRun ? routinesById.get(routineRun.routineId)?.timezone : undefined
            const dateLabel =
              thread.kind === "routine"
                ? getRoutineRunSidebarDateLabel(timestamp, "pt-BR", timeZone)
                : relativeThreadDate(thread.updatedAt)
            const dateTitle =
              thread.kind === "routine" ? getRoutineRunDateLabel(timestamp, "pt-BR", timeZone) : undefined

            return (
              <ThreadRow
                key={thread.id}
                inserted={insertedThreads.has(thread.id)}
                thread={thread}
                deletedRoutine={deletedRoutine}
                dateLabel={dateLabel}
                dateTitle={dateTitle}
                unread={unread}
                selected={thread.id === selectedThreadId}
                running={running}
                onClick={() => onSelectThread(thread.id)}
              />
            )
          })}
          {visibleRoutineIds.length > 0 && (
            <button type="button" className="new-thread-row" onClick={() => onRoutineHistory(historyRoutineId)}>
              {t("Routine run history")}
            </button>
          )}
          {deletedRoutine && (
            <DeletedRoutineHistory
              threads={threads}
              routineRuns={routineRuns}
              routineIds={routineIds}
              groupThreadId={deletedRoutine.thread.id}
              selectedThreadId={selectedThreadId}
              onSelectThread={onSelectThread}
            />
          )}
          <button type="button" className="new-thread-row" onClick={onNewThread}>
            <SidebarIcon>
              <path d="M12 5v14M5 12h14" />
            </SidebarIcon>
            {t("Nova conversa")}
          </button>
        </section>
      )}
    </div>
  )
}

const ThreadRow = ({
  inserted,
  thread,
  deletedRoutine,
  dateLabel,
  dateTitle,
  unread,
  selected,
  running,
  onClick,
}: {
  thread: Thread
  deletedRoutine: boolean
  dateLabel: string
  dateTitle: string | undefined
  unread: number
  inserted: boolean
  selected: boolean
  running: boolean
  onClick: () => void
}) => {
  const title = deletedRoutine ? t("Deleted routine") : getSidebarThreadTitle(thread)

  return (
    <button
      type="button"
      data-motion-insert={inserted}
      className={`thread-row ${selected ? "selected" : ""}`}
      onClick={onClick}
      aria-current={selected ? "page" : undefined}
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
        <strong title={thread.kind === "routine" ? `${title} · ${dateTitle ?? dateLabel}` : title}>{title}</strong>
        <small>{dateLabel}</small>
      </span>
      {running ? (
        <span className="sidebar-status-dot state-running" role="img" aria-label={t("Em execução")} />
      ) : unread > 0 ? (
        <span className="sidebar-unread" role="img" aria-label={t("Unread messages", { count: unread })}>
          {unread > 99 ? "99+" : unread}
        </span>
      ) : null}
    </button>
  )
}
