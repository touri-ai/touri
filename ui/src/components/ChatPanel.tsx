import type {
  Bot,
  BotGroup,
  BrowserChannelRun,
  GroupAction,
  Id,
  MachineState,
  Message,
  Project,
  Routine,
  RoutineRun,
  Run,
  Thread,
} from "@touri/contracts"
import { failureRetryHint, sanitizeDiagnostic } from "@touri/contracts/run-failure"
import {
  Fragment,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import type { UiApi } from "../api/client"
import type { ApprovalFocus } from "../approvalNavigation"
import { getChannelThreads } from "../channelThreads"
import { getDocumentLocale } from "../documentLanguage"
import { userFacingRunError } from "../errors"
import {
  ChannelBrowserContext,
  ChannelBrowserRunsContext,
  type ChannelBrowserValue,
} from "../features/channelBrowser/ChannelBrowser"
import { getChannelBrowserValue } from "../features/channelBrowser/channelBrowserModel"
import { useChannelPeople } from "../features/channelBrowser/useChannelPeople"
import { ComputerGrantCard } from "../features/computer"
import { InlineLivePreview, InlinePreviewContext, screenTool } from "../features/desktop/InlineLivePreview"
import { useIsServerMode } from "../features/server/serverMode"
import { getQueueLabel } from "../features/work/presentation"
import {
  getHostLabel,
  getRoutineRunDateLabel,
  getRoutineRunTimeLabel,
  type Locale,
  localizeNotice,
  type TranslationKey,
  t,
} from "../i18n"
import { machineStateForDisplay } from "../machineState"
import { messageMarkdown } from "../messageMarkdown"
import { consumeTaskReview, requestTaskResume, reviewTaskEvent } from "../recoveryEvents"
import { getRoutineReplyRun, isRoutineConversation, isRoutineEmptyResult, isRoutineRun } from "../routineConversation"
import { type RoutineDraft, repeatTaskDraft, suggestedRoutineDraft } from "../routineDraft"
import { failureTimeLabel, runErrorFor } from "../runError"
import { getSidebarThreadTitle } from "../sidebarThreadTitle"
import { useHost } from "../useHost"
import { RecoveryTasksContext } from "../useRecoveryTasks"
import type { ThreadCreationStatus } from "../workspaceState"
import { ActivityMark } from "./ActivityMark"
import { ApprovalCard } from "./ApprovalCard"
import { useAvatarBot, useMascotSnapshot, useMessageMascotState, useThreadBot } from "./AvatarRuntime"
import { withApprovalAnswers } from "./activityStatus"
import { getAutomaticResumeMessages } from "./automaticResumeMessages"
import { BotAvatar } from "./BotAvatar"
import { BrowserActivityControlsProvider } from "./BrowserActivityControls"
import { getBrowserActivityTools } from "./browserActivityPresentation"
import { type BrowserContinuationActivity, getBrowserContinuationActivities } from "./browserContinuationActivity"
import { getBrowserRequestMessages } from "./browserRequestMessages"
import { ChatDisclosure } from "./ChatDisclosure"
import { ConnectDataCard, connectDataMarker } from "./ConnectDataCard"
import { ConversationStart } from "./ConversationStart"
import { DeferredGoalPanel as GoalPanel } from "./DeferredGoalPanel"
import { Disclosure } from "./Disclosure"
import { DraftComposer, type DraftComposerHandle } from "./DraftComposer"
import { ErrorDetails, ErrorText } from "./ErrorDetails"
import { ErrorNotice } from "./ErrorNotice"
import { EvidenceContext } from "./EvidenceGallery"
import { FailureActionContext } from "./FailureActionContext"
import { getGroupProgress } from "./groupProjection"
import { MachineServiceButton } from "./MachineServiceButton"
import { MachineStatus } from "./MachineStatus"
import { MarkdownContent } from "./MarkdownContent"
import { MessageAttachments } from "./MessageAttachments"
import { useInsertedIds } from "./Motion"
import { mascotSignalFor } from "./mascotState"
import { PanelIcon } from "./PanelIcon"
import { PersonAvatar } from "./PersonAvatar"
import { ToolCallList } from "./ToolCallList"
import { ToolText } from "./ToolOutput"
import { BrowserTurnCard, TurnActivity } from "./TurnActivity"
import { toolStatus } from "./toolPresentation"
import { approvalTools, assistantSegments } from "./turnActivityModel"
import { type EditMessage, UserMessageEdit } from "./UserMessageEdit"
import { usePhoneViewport } from "./usePhoneViewport"

const GroupHeader = lazy(() => import("./Groups").then((module) => ({ default: module.GroupHeader })))
const GroupConversationStart = lazy(() =>
  import("./Groups").then((module) => ({ default: module.GroupConversationStart })),
)
const ChannelThreads = lazy(() => import("./ChannelThreads").then((module) => ({ default: module.ChannelThreads })))

type ChatPanelProps = {
  channelThreads?: Thread[]
  channelMessages?: Message[]
  onSelectChannelThread?: ((threadId: string) => void) | undefined
  composerKey?: string | undefined
  threadCreation?: ThreadCreationStatus | undefined
  onRetryCreateThread?: (() => void) | undefined
  onResumeBot?: (() => Promise<void>) | undefined
  autoFocusComposer?: boolean | undefined
  onRepeatTask?: ((draft: RoutineDraft) => void) | undefined
  group?: BotGroup | null
  groupMembers?: Bot[]
  channelMode?: boolean
  workspaceMode?: "bots" | "work"
  onEditGroup?: () => void
  channelBrowser?: ChannelBrowserValue | null
  browserRuns?: BrowserChannelRun[]
  onInviteToGroup?: (() => void) | undefined
  focusApproval?: ApprovalFocus | undefined
  panelOpen?: boolean
  onTogglePanel?: () => void
  routines?: Array<Routine>
  routineRuns?: Array<RoutineRun>
  currentPersonId?: string | null
  attachmentButtonRef?: React.RefObject<HTMLButtonElement | null> | undefined
  onOpenPermissions?: () => void
  onOpenToolCatalog?: () => void
  onOpenProviderLogin?: () => void
  onOpenComputer?: () => void
  projects?: Project[]
  onSaveModel?: (model: string | null) => Promise<void>
  onNotice?: (message: string) => void
  onSelectProject?: (projectId: Id | null) => Promise<void>
  onAddProject?: () => void
  activePath?: Array<Message> | undefined
  goalRefreshRequest?: number
  onGoalChange?: () => void
  thread: Thread | null
  bot: Bot | null
  machine?: MachineState | undefined
  messages: Array<Message>
  runs: Array<Run>
  onSend: (text: string, parentId?: Id | null, attachmentIds?: Array<Id>, groupAction?: GroupAction) => Promise<void>
  onRetry: (runId: Id) => Promise<void>
  onCancel: (runId: Id) => Promise<void>
  onSwitchBranch: (threadId: Id, leafId: Id) => Promise<void>
  computerGrant: { botId: Id; threadId: Id; botName: string } | null
  api: UiApi
  onComputerGrant: () => void
  onOpenTools: (tab: "preview" | "processes" | "browser") => void
}

type VirtualMessageListProps = {
  vmBotId?: string | undefined
  currentPersonId?: string | null | undefined
  machine?: MachineState | undefined
  focusApproval?: ApprovalFocus | undefined
  messages: Array<Message>
  api?: UiApi
  runs?: Array<Run>
  mainThread?: boolean
  routines?: Array<Routine>
  routineRuns?: Array<RoutineRun>
  onSwitchBranch: (message: Message, siblings: Array<Message>, index: number) => void
  onRetry: (runId: Id) => Promise<void>
  onEdit?: EditMessage | undefined
  onCancel?: ((runId: Id) => Promise<void>) | undefined
  editDisabled?: boolean
  showActivityStop?: boolean
  header?: ReactNode
  allMessages?: Array<Message>
  timelineCards?: Array<{ id: string; createdAt: number; content: ReactNode }>
}
const emptyTimelineCards: NonNullable<VirtualMessageListProps["timelineCards"]> = []

export const activeMessagePath = (messages: Array<Message>, leafId: Id | null): Array<Message> => {
  if (!leafId) return messages
  const byId = new Map(messages.map((message) => [message.id, message]))
  const path: Message[] = []
  const seen = new Set<Id>()
  let next: Id | null = leafId
  while (next && !seen.has(next)) {
    seen.add(next)
    const message = byId.get(next)
    if (!message) break
    path.unshift(message)
    next = message.parentId
  }
  return path
}

const deliveryLabels = {
  queued: "Na fila · aguardando conexão",
  sent: "Sending message…",
  failed: "Falha na entrega",
} as const
const routineTriggerKeys: Record<RoutineRun["triggerSource"], TranslationKey> = {
  cron: "Routine trigger scheduled",
  manual: "Routine trigger manual",
  "catch-up": "Routine trigger catch-up",
  import: "Routine trigger imported",
}
const estimatedRowHeight = 158

const getTimelineOffsets = (timeline: Array<{ id: string }>, heights: Record<string, number>): number[] => {
  const offsets = [0]
  let offset = 0
  // Prefix sums keep variable-height virtualization linear in the history length.
  for (const entry of timeline) {
    offset += heights[entry.id] ?? estimatedRowHeight
    offsets.push(offset)
  }
  return offsets
}

const getTimelineIndex = (offsets: number[], position: number): number => {
  let low = 0
  let high = offsets.length - 1
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if ((offsets[middle + 1] ?? Number.POSITIVE_INFINITY) <= position) low = middle + 1
    else high = middle
  }
  return low
}

/** Jump to the end and remember the position so its own scroll event is not mistaken for the user leaving the bottom. */
const scrollToEnd = (list: HTMLElement, programmaticTop: { current: number | null }): void => {
  list.scrollTop = Math.max(0, list.scrollHeight - list.clientHeight)
  programmaticTop.current = list.scrollTop
}

const emptyRuns: Run[] = []

export const VirtualMessageList = ({
  vmBotId,
  currentPersonId = "owner",
  machine,
  focusApproval,
  messages: sourceMessages,
  api,
  runs = emptyRuns,
  mainThread = false,
  routines = [],
  routineRuns = [],
  allMessages = sourceMessages,
  onSwitchBranch,
  onRetry,
  onEdit,
  onCancel,
  editDisabled = false,
  showActivityStop = true,
  header,
  timelineCards = emptyTimelineCards,
}: VirtualMessageListProps) => {
  const messages = useMemo(
    () => getAutomaticResumeMessages(getBrowserRequestMessages(sourceMessages, runs), runs),
    [sourceMessages, runs],
  )
  const locale = getDocumentLocale(document.documentElement)
  const browserContinuations = useMemo(() => getBrowserContinuationActivities(messages, runs), [messages, runs])
  // r8 motion: immutable IDs drive text entry, never streaming tokens or status/cards.
  const insertedMessages = useInsertedIds(
    messages.map((message) => message.id),
    messages[0]?.threadId ?? "",
  )
  const runsById = useMemo(() => new Map(runs.map((run) => [run.id, run])), [runs])
  const routineRunHeaderByMessage = useMemo(() => {
    const routineRunsById = new Map(routineRuns.map((routineRun) => [routineRun.id, routineRun]))
    const routinesById = new Map(routines.map((routine) => [routine.id, routine]))

    return runs.reduce((headers, run) => {
      if (!run.requestMessageId || !isRoutineRun(run)) return headers
      const routineRun = routineRunsById.get(run.routineRunId ?? "")
      const routine = routineRun ? routinesById.get(routineRun.routineId) : undefined

      headers.set(
        run.requestMessageId,
        t("Routine run header", {
          name: routine?.name ?? t("Work routine"),
          trigger: routineRun ? t(routineTriggerKeys[routineRun.triggerSource]) : t("Automatic"),
          time: getRoutineRunTimeLabel(routineRun?.scheduledFor ?? run.queuedAt, "pt-BR", routine?.timezone),
        }),
      )
      return headers
    }, new Map<string, string>())
  }, [runs, routineRuns, routines])
  const [scrollTop, setScrollTop] = useState(0)
  const [rowHeights, setRowHeights] = useState<Record<string, number>>({})
  const scrollRef = useRef<HTMLDivElement>(null)
  const spacerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const pendingRowMeasurements = useRef(new Set<string>())
  const measurementFrame = useRef<number | null>(null)
  const followBottom = useRef(true)
  const programmaticTop = useRef<number | null>(null)
  const readingAnchor = useRef<{ element: HTMLElement; top: number; scrollTop: number } | null>(null)
  const [awayFromBottom, setAwayFromBottom] = useState(false)
  const [unseenCount, setUnseenCount] = useState(0)
  const observedMessages = useRef(messages)
  const lastUser = useRef<Id | undefined>(undefined)
  const focusedRequest = useRef<number | undefined>(undefined)
  const latestUserId = [...messages].reverse().find((message) => message.role === "user")?.id
  const timeline = useMemo(() => {
    // This disposable list is sorted because the TypeScript target does not include toSorted.
    const entries = [
      ...messages.map((message) => ({
        id: message.id,
        createdAt: message.createdAt,
        message,
        content: null as ReactNode,
      })),
      ...timelineCards.map((card) => ({ ...card, message: null })),
    ]
    return Array.from(entries).sort((a, b) => a.createdAt - b.createdAt)
  }, [messages, timelineCards])
  const isVirtualized = timeline.length > 100
  const rowOffsets = useMemo(
    () => (isVirtualized ? getTimelineOffsets(timeline, rowHeights) : [0]),
    [timeline, rowHeights, isVirtualized],
  )
  const measureRowOnNextFrame = useCallback(
    (id: string) => {
      if (!isVirtualized) return

      // Coalesce image loads and mounted rows so one frame reads each visible row at most once.
      pendingRowMeasurements.current.add(id)
      if (measurementFrame.current !== null) return
      measurementFrame.current = requestAnimationFrame(() => {
        measurementFrame.current = null
        const content = contentRef.current
        const elements = Array.from(content?.querySelectorAll<HTMLElement>("[data-message-row]") ?? [])
        const rowsById = new Map(elements.map((element) => [element.dataset.messageRow ?? "", element]))
        const rows = [...pendingRowMeasurements.current].flatMap((rowId) => {
          const element = rowsById.get(rowId)
          return element ? [[rowId, Math.ceil(element.getBoundingClientRect().height)] as [string, number]] : []
        })
        pendingRowMeasurements.current.clear()
        if (rows.length === 0) return
        setRowHeights((heights) => {
          const changed = rows.filter(
            ([rowId, height]) => Math.abs((heights[rowId] ?? estimatedRowHeight) - height) > 0.5,
          )
          return changed.length > 0 ? { ...heights, ...Object.fromEntries(changed) } : heights
        })
      })
    },
    [isVirtualized],
  )
  useEffect(() => {
    return () => {
      if (measurementFrame.current !== null) cancelAnimationFrame(measurementFrame.current)
      measurementFrame.current = null
      pendingRowMeasurements.current.clear()
    }
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: messages and cards change the rendered scroll height during a turn
  useLayoutEffect(() => {
    const list = scrollRef.current
    const newTurn = latestUserId !== lastUser.current
    lastUser.current = latestUserId
    if (
      !list ||
      (focusApproval && focusApproval.request !== focusedRequest.current) ||
      (!newTurn && !followBottom.current)
    )
      return
    followBottom.current = true
    readingAnchor.current = null
    setAwayFromBottom(false)
    setUnseenCount(0)
    scrollToEnd(list, programmaticTop)
    // Updating the virtual window explicitly also works before the browser fires its scroll event.
    setScrollTop(list.scrollTop)
  }, [latestUserId, messages, timelineCards.length, focusApproval?.request])
  useLayoutEffect(() => {
    const previous = observedMessages.current
    observedMessages.current = messages
    if (followBottom.current) return
    const previousIds = new Set(previous.map((message) => message.id))
    const added = messages.filter((message) => !previousIds.has(message.id)).length
    const reply = messages.at(-1)
    const oldReply = previous.at(-1)
    if (added || reply?.text !== oldReply?.text || reply?.status !== oldReply?.status)
      setUnseenCount((count) => Math.max(1, count + added))
  }, [messages])
  useLayoutEffect(() => {
    const list = scrollRef.current
    const spacer = spacerRef.current
    const content = contentRef.current
    if (!list || !spacer || !content || typeof ResizeObserver === "undefined") return
    const measureMountedRows = () =>
      content.querySelectorAll<HTMLElement>("[data-message-row]").forEach((row) => {
        const id = row.dataset.messageRow
        if (id) measureRowOnNextFrame(id)
      })
    // Markdown and the virtual window can grow after the first layout of a new turn.
    const observer = new ResizeObserver(() => {
      measureMountedRows()
      const anchor = readingAnchor.current
      if (anchor?.element.isConnected) {
        const delta = anchor.element.getBoundingClientRect().top - list.getBoundingClientRect().top - anchor.top
        if (Math.abs(delta) > 0.5) list.scrollTop += delta
        anchor.scrollTop = list.scrollTop
      } else if (followBottom.current) {
        scrollToEnd(list, programmaticTop)
      }
      const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 48
      // Once a disclosure has settled back at the end, resume following the next reply.
      const collapsed = anchor?.element.getAttribute("aria-expanded") === "false"
      if (atBottom && collapsed) {
        readingAnchor.current = null
        followBottom.current = true
      }
      setAwayFromBottom(!atBottom)
      setScrollTop(list.scrollTop)
    })
    observer.observe(spacer)
    observer.observe(content)
    const mutations = new MutationObserver(measureMountedRows)
    mutations.observe(content, { childList: true })
    measureMountedRows()
    return () => {
      mutations.disconnect()
      observer.disconnect()
    }
  }, [measureRowOnNextFrame])
  const visibleCount = 34
  const totalHeight = rowOffsets.at(-1) ?? 0
  const targetIndex = focusApproval
    ? timeline.findIndex((entry) =>
        entry.message?.parts.some((part) => part.type === "approval" && part.approvalId === focusApproval.approvalId),
      )
    : -1
  const revealTarget = targetIndex >= 0 && focusApproval?.request !== focusedRequest.current
  const firstVisibleIndex = getTimelineIndex(rowOffsets, Math.max(0, scrollTop - estimatedRowHeight * 4))
  const start =
    timeline.length > 100
      ? Math.min(
          Math.max(0, timeline.length - visibleCount),
          Math.max(0, (revealTarget ? targetIndex : firstVisibleIndex) - 4),
        )
      : 0
  const end = timeline.length > 100 ? Math.min(timeline.length, start + visibleCount) : timeline.length
  const visible = timeline.slice(start, end)

  useLayoutEffect(() => {
    if (!focusApproval || targetIndex < 0 || focusedRequest.current === focusApproval.request) return
    const list = scrollRef.current
    const card = Array.from(list?.querySelectorAll<HTMLElement>("[data-approval-id]") ?? []).find(
      (element) => element.dataset.approvalId === focusApproval.approvalId,
    )
    if (!list || !card) return
    focusedRequest.current = focusApproval.request
    followBottom.current = false
    readingAnchor.current = null
    setAwayFromBottom(true)
    if (timeline.length > 100) list.scrollTop = rowOffsets[targetIndex] ?? 0
    card.scrollIntoView?.({ block: "center", behavior: "instant" })
    card.focus({ preventScroll: true })
    setScrollTop(list.scrollTop)
  }, [focusApproval, targetIndex, timeline.length, rowOffsets])

  return (
    <div className="chat-message-list">
      <div
        className="message-scroll"
        ref={scrollRef}
        data-testid="virtual-message-list"
        onClickCapture={(event) => {
          if (!(event.target instanceof Element)) return
          const control = event.target.closest<HTMLElement>(
            ".ds-disclosure-trigger, .chat-disclosure-toggle, .turn-activity-toggle, .message-error-history > button",
          )
          if (!control) return
          const list = event.currentTarget
          readingAnchor.current = {
            element: control,
            top: control.getBoundingClientRect().top - list.getBoundingClientRect().top,
            scrollTop: list.scrollTop,
          }
          followBottom.current = false
        }}
        onScroll={(event) => {
          const list = event.currentTarget
          const expected = programmaticTop.current
          programmaticTop.current = null
          if (expected !== null && Math.abs(list.scrollTop - expected) <= 1) {
            setScrollTop(list.scrollTop)
            return
          }
          const anchor = readingAnchor.current
          if (anchor && Math.abs(list.scrollTop - anchor.scrollTop) > 2) readingAnchor.current = null
          const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 48
          followBottom.current = !readingAnchor.current && atBottom
          setAwayFromBottom(!atBottom)
          if (atBottom) setUnseenCount(0)
          setScrollTop(list.scrollTop)
        }}
      >
        {header}
        <div ref={spacerRef} style={timeline.length > 100 ? { height: totalHeight, position: "relative" } : undefined}>
          <div
            ref={contentRef}
            style={
              timeline.length > 100
                ? {
                    position: "absolute",
                    top: 0,
                    right: 0,
                    left: 0,
                    transform: `translateY(${rowOffsets[start] ?? 0}px)`,
                  }
                : undefined
            }
          >
            {visible.map((entry, index) => {
              if (!entry.message)
                return (
                  <div key={entry.id} className="message-row" data-message-row={entry.id}>
                    {entry.content}
                  </div>
                )
              const saved = entry.message
              if (isResumeMarker(saved))
                return (
                  <div key={saved.id} className="message-row" data-message-row={saved.id}>
                    <p className="run-resumed-marker" role="note" data-message-id={saved.id}>
                      <span>{getResumeMarkerText(saved.text, locale)}</span>
                    </p>
                  </div>
                )
              const run = runs.find((run) => run.id === saved.runId)
              const finished = run && ["succeeded", "failed", "canceled", "interrupted"].includes(run.status)
              const message: Message =
                finished && saved.status === "streaming"
                  ? {
                      ...saved,
                      status:
                        run.status === "succeeded" ? "complete" : run.status === "canceled" ? "canceled" : "failed",
                      parts:
                        run.status === "interrupted" &&
                        !saved.parts.some((part) => part.type === "notice" && part.code === "app_restart")
                          ? [
                              ...saved.parts,
                              {
                                type: "notice",
                                level: "error",
                                code: "app_restart",
                                text: `app_restart: ${userFacingRunError(run)}`,
                              },
                            ]
                          : saved.parts,
                    }
                  : saved
              const siblings = allMessages.filter(
                (candidate) =>
                  candidate.threadId === message.threadId &&
                  candidate.parentId === message.parentId &&
                  candidate.role === message.role &&
                  candidate.kind !== "notice",
              )
              const branchIndex = siblings.findIndex((candidate) => candidate.id === message.id)
              return (
                <div key={message.id} className="message-row" data-message-row={message.id}>
                  {(index === 0 || !sameCalendarDay(visible[index - 1]?.createdAt ?? 0, message.createdAt)) && (
                    <div className="day-divider">
                      <span>{formatDaySeparator(message.createdAt)}</span>
                    </div>
                  )}
                  <MessageBubble
                    inserted={insertedMessages.has(message.id)}
                    vmBotId={vmBotId}
                    currentPersonId={currentPersonId}
                    machine={machine}
                    message={message}
                    run={run}
                    browserActivity={browserContinuations.activities.get(message.id)}
                    hideBrowserActivity={browserContinuations.hidden.has(message.id)}
                    routineReply={getRoutineReplyRun(message, runs, allMessages) !== undefined}
                    routinePrompt={
                      !mainThread &&
                      message.role === "user" &&
                      runs.some((candidate) => isRoutineRun(candidate) && candidate.requestMessageId === message.id)
                    }
                    routineHeader={routineRunHeaderByMessage.get(message.id)}
                    automaticRecovery={Boolean(
                      run?.groupTurnId &&
                        ["cli_crash", "oom", "machine_service_unavailable", "app_restart"].includes(
                          run.errorClass ?? "",
                        ) &&
                        runs.some(
                          (candidate) =>
                            (candidate.id === run.groupTurnId &&
                              ["queued", "starting", "running"].includes(candidate.status)) ||
                            (candidate.threadId === run.threadId &&
                              candidate.botId === run.botId &&
                              isSameChannelRequest(run, candidate, runsById) &&
                              (candidate.queuedAt > run.queuedAt ||
                                (candidate.queuedAt === run.queuedAt && candidate.id > run.id))),
                        ),
                    )}
                    recovered={
                      runs.some(
                        (later) =>
                          later.threadId === message.threadId &&
                          later.status === "succeeded" &&
                          (!run?.groupTurnId || isSameChannelRequest(run, later, runsById)) &&
                          (later.finishedAt ?? later.startedAt ?? later.queuedAt) >
                            (run?.finishedAt ?? message.updatedAt),
                      ) ||
                      allMessages.some(
                        (later) =>
                          later.threadId === message.threadId &&
                          later.role === "assistant" &&
                          later.status === "complete" &&
                          (!run?.groupTurnId || isSameChannelRequest(run, runsById.get(later.runId ?? ""), runsById)) &&
                          later.createdAt > (run?.finishedAt ?? message.updatedAt),
                      )
                    }
                    {...(api ? { api } : {})}
                    siblings={siblings}
                    branchIndex={branchIndex}
                    onSwitchBranch={onSwitchBranch}
                    onRetry={onRetry}
                    onEdit={onEdit}
                    onCancel={onCancel}
                    editDisabled={editDisabled}
                    showActivityStop={showActivityStop}
                    onImageLoad={measureRowOnNextFrame}
                  />
                </div>
              )
            })}
          </div>
        </div>
      </div>
      {awayFromBottom && (
        <button
          type="button"
          className="chat-scroll-bottom"
          onClick={() => {
            const list = scrollRef.current
            if (!list) return
            readingAnchor.current = null
            followBottom.current = true
            scrollToEnd(list, programmaticTop)
            setScrollTop(list.scrollTop)
            setAwayFromBottom(false)
            setUnseenCount(0)
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            aria-hidden="true"
          >
            <path d="M12 4v16m-6-6 6 6 6-6" />
          </svg>
          <span aria-live="polite">
            {unseenCount > 0
              ? `${unseenCount} ${unseenCount === 1 ? "nova mensagem" : "novas mensagens"}`
              : "Voltar ao fim"}
          </span>
        </button>
      )}
    </div>
  )
}

/** The marker the runtime inserts before a turn it continued automatically. */
const isResumeMarker = (message: Message): boolean =>
  message.role === "system" && message.parts.some((part) => part.type === "notice" && part.code === "run_resumed")

const getResumeMarkerText = (text: string, locale: Locale): string => {
  if (text === "Retomando a resposta automaticamente…") return t(text, {}, locale)
  if (text === "Retomado após aprovação de acesso") return t(text, {}, locale)
  if (text === "Retomado após a devolução do navegador") return t(text, {}, locale)
  if (text === "A sessão anterior não pôde ser retomada. Vou continuar com o histórico salvo em uma nova sessão.")
    return t(text, {}, locale)

  return text
}

const isGroupCoordinationPrompt = (message: Message): boolean => {
  return (
    message.role === "system" &&
    message.parts.some(
      (part) =>
        part.type === "notice" &&
        ["group_coordination_prompt", "context_restored", "session_replaced"].includes(part.code),
    )
  )
}

const sameCalendarDay = (left: number, right: number): boolean => {
  const first = new Date(left)
  const second = new Date(right)
  return (
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
  )
}

const formatDaySeparator = (timestamp: number): string => {
  const date = new Date(timestamp)
  const now = new Date()
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (sameCalendarDay(timestamp, now.getTime())) return "Hoje"
  if (sameCalendarDay(timestamp, yesterday.getTime())) return "Ontem"
  return date.toLocaleDateString("pt-BR", {
    day: "numeric",
    month: "long",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  })
}

const MessageBubble = ({
  inserted,
  vmBotId,
  currentPersonId,
  machine,
  recovered,
  automaticRecovery = false,
  message,
  run,
  browserActivity,
  hideBrowserActivity,
  routineReply,
  routinePrompt,
  routineHeader,
  api,
  siblings,
  branchIndex,
  onSwitchBranch,
  onRetry,
  onEdit,
  onCancel,
  editDisabled,
  showActivityStop,
  onImageLoad,
}: {
  inserted: boolean
  vmBotId?: string | undefined
  currentPersonId: string | null
  machine?: MachineState | undefined
  recovered: boolean
  automaticRecovery?: boolean
  message: Message
  run?: Run | undefined
  browserActivity?: BrowserContinuationActivity | undefined
  hideBrowserActivity: boolean
  routineReply: boolean
  routinePrompt: boolean
  routineHeader?: string | undefined
  api?: UiApi
  siblings: Array<Message>
  branchIndex: number
  onSwitchBranch: (message: Message, siblings: Array<Message>, index: number) => void
  onRetry: (runId: Id) => Promise<void>
  onEdit?: EditMessage | undefined
  onCancel?: ((runId: Id) => Promise<void>) | undefined
  editDisabled: boolean
  showActivityStop: boolean
  onImageLoad: (messageId: string) => void
}) => {
  const locale = getDocumentLocale(document.documentElement)
  const runtimeState = useMessageMascotState(message, run)
  const threadBot = useThreadBot(message.threadId)
  const senderBot = useAvatarBot(message.sender?.id ?? null)
  const personSender =
    message.role === "user" && (message.sender?.kind === "person" || message.sender?.kind === "integration")
      ? message.sender
      : null
  const messageFromOtherPerson = Boolean(personSender && personSender.id !== currentPersonId)
  const personMessageClass = messageFromOtherPerson ? "message-user message-other-person" : "message-user"
  const messageClass = message.role === "user" ? personMessageClass : "message-assistant"
  const parentEvidence = useContext(EvidenceContext)
  const bot = senderBot ?? threadBot
  const evidence = useMemo(
    () =>
      parentEvidence
        ? {
            ...parentEvidence,
            bot: bot ?? parentEvidence.bot,
            onLayoutChange: () => onImageLoad(message.id),
            onLibrary: (path: string) => parentEvidence.onLibrary?.(path, bot?.id ?? parentEvidence.bot.id),
            onComputer: () => parentEvidence.onComputer?.(bot?.id ?? parentEvidence.bot.id),
          }
        : undefined,
    [parentEvidence, bot, message.id, onImageLoad],
  )
  const root = useRef<HTMLElement>(null)
  const [answers, setAnswers] = useState<Record<string, "approved" | "denied">>({})
  const parts = withApprovalAnswers(message.parts, answers)
  const mascotState =
    runtimeState === "waiting-approval" &&
    Object.keys(answers).length > 0 &&
    !parts.some((part) => part.type === "approval" && part.decision === "pending")
      ? mascotSignalFor({ botId: run?.botId ?? "", runs: run ? [run] : [], messages: [{ ...message, parts }] }).state
      : runtimeState
  const answeredId = Object.keys(answers).at(-1)
  useLayoutEffect(() => {
    if (!answeredId) return
    Array.from(root.current?.querySelectorAll<HTMLElement>("[data-approval-id]") ?? [])
      .find((card) => card.dataset.approvalId === answeredId)
      ?.focus({ preventScroll: true })
  }, [answeredId])
  const markdown = messageMarkdown(message)
  const text = message.role === "assistant" ? markdown.replace(connectDataMarker, "") : markdown
  const segments = message.role === "assistant" ? assistantSegments({ ...message, parts }) : []
  const hasBrowserTools = message.role === "assistant" && getBrowserActivityTools(parts).length > 0
  const browserHandoffExpired = parts.some(
    (part) =>
      part.type === "notice" &&
      part.code === "run_failed" &&
      part.text === "No one took over in time. Ask again when you can.",
  )
  const quietBrowserNarration = hasBrowserTools && message.status === "streaming"
  const getBrowserRunLabel = () => {
    if (browserHandoffExpired) return t("incomplete", {}, locale)
    if (quietBrowserNarration) return t("in progress", {}, locale)

    return t("finished", {}, locale)
  }
  const foldBrowserFlow = hasBrowserTools && message.status !== "streaming"
  const finalText = segments.filter((segment) => segment.type === "text").at(-1)
  const senderName = message.sender?.name ?? bot?.name ?? "touri"
  const renderBrowserSteps = (key: string, count: number) => (
    <p className="browser-steps" key={key} data-actions={count}>
      <span aria-hidden="true">✓</span>
      {t("Used the browser")}
    </p>
  )
  const getMessageRoleLabel = (): string => {
    if (message.role === "user") {
      if (messageFromOtherPerson) return personSender?.name ?? t("Você")
      return t("Você")
    }
    if (message.role === "assistant") return message.sender?.name ?? bot?.name ?? "touri"

    return t(message.role)
  }
  const messageRoleLabel = getMessageRoleLabel()
  const technicalNotice =
    message.role === "system" &&
    message.parts.some((part) => part.type === "notice" && part.code === "session_replaced")
  const renderAnswer = (content: string, final: boolean) => {
    const answer = content.replace(connectDataMarker, "")
    if (!answer.trim()) return null
    if (final && message.status === "complete" && routineReply && isRoutineEmptyResult(answer))
      return <p className="routine-empty-result">{t("Sem novidades nesta execução")}</p>

    return message.status !== "streaming" && (answer.length > 4000 || answer.split("\n").length > 40) ? (
      <ChatDisclosure
        className="chat-long-content"
        label={t("Mostrar mais")}
        expandedLabel={t("Mostrar menos")}
        preview={<MarkdownContent content={answer} evidence={evidence} preview />}
      >
        <MarkdownContent content={answer} evidence={evidence} />
      </ChatDisclosure>
    ) : (
      <MarkdownContent content={answer} evidence={evidence} streaming={message.status === "streaming"} />
    )
  }
  const matchedApprovals = approvalTools(parts)
  const failure = run?.automaticResumePending ? null : runErrorFor(message, run, machine?.status === "running")
  const runError =
    vmBotId &&
    (machine?.status === "running" || machine?.status === "starting") &&
    (failure?.code === "TOURI-E8001" || failure?.code === "TOURI-E8002")
      ? null
      : failure
  const recoveryTasks = useContext(RecoveryTasksContext)
  const resolvedInterruption = recoveryTasks.some(
    (task) => message.runId !== null && task.runId === message.runId && task.notification.resolvedAt !== null,
  )
  const [failureExpanded, setFailureExpanded] = useState(false)
  const [reviewingActions, setReviewingActions] = useState(false)
  useEffect(() => {
    const review = () => {
      if (!message.runId || !consumeTaskReview(message.runId)) return
      setReviewingActions(true)
      root.current?.scrollIntoView?.({ block: "center" })
    }
    review()
    window.addEventListener(reviewTaskEvent, review)
    return () => window.removeEventListener(reviewTaskEvent, review)
  }, [message.runId])
  const failedAt = run?.finishedAt ?? message.updatedAt
  const failureTime = failureTimeLabel(failedAt)
  const onFailureAction = useContext(FailureActionContext)
  const failureAction = runError?.action
  const failureRecovery = runError && {
    ...runError.recovery,
    actions: [
      ...runError.recovery.actions,
      ...(message.runId &&
      message.status === "failed" &&
      run?.errorClass !== "group_context_missing" &&
      !runError.recovery.actions.some((action) => ["retry", "review", "resume", "storage"].includes(action.kind))
        ? [{ kind: "retry" as const, label: t("Tentar novamente") }]
        : []),
    ].map((action) => (action.kind === "retry" ? { ...action, label: t("Tentar novamente") } : action)),
  }
  const failureContent =
    runError && automaticRecovery ? (
      <p role="status">{t(recovered ? "A reply followed this error" : "Retomando a resposta automaticamente…")}</p>
    ) : (
      runError && (
        <div className="message-error" role="alert">
          {runError.recovery.classified ||
          (runError.stage === "turn" && !/^TOURI-E800[12]$/.test(runError.code)) ||
          runError.stage === "provider_protocol" ? (
            <>
              <ErrorNotice
                recovery={failureRecovery ?? runError.recovery}
                onAction={async (action) => {
                  if (action === "retry") await onRetry(message.runId ?? "")
                  else if (action === "review") setReviewingActions(true)
                  else if (action === "resume") {
                    setReviewingActions(true)
                    requestTaskResume(message.threadId)
                  } else
                    onFailureAction(
                      action === "login"
                        ? { kind: "setting", settingId: "providerLogin", label: "" }
                        : { kind: "doctor", label: "" },
                    )
                }}
              />
              {vmBotId && !runError.recovery.classified && <p>{failureRetryHint(runError.stage)}</p>}
              {reviewingActions && (
                <section aria-label={t("Ações registradas")} tabIndex={-1}>
                  <p>
                    {t("Revise as ações registradas antes de continuar. Nenhuma ação será repetida automaticamente.")}
                  </p>
                  <ul>
                    {message.parts.flatMap((part, index) => {
                      const summary =
                        part.type === "tool_call"
                          ? part.summary
                          : part.type === "command"
                            ? part.command
                            : part.type === "file_change"
                              ? part.paths.join(", ")
                              : null
                      return summary
                        ? [
                            <li key={"callId" in part ? part.callId : part.type}>
                              <Disclosure summary={`${t("Ações registradas")} ${index + 1}`}>
                                <pre>{sanitizeDiagnostic(summary)}</pre>
                              </Disclosure>
                            </li>,
                          ]
                        : []
                    })}
                  </ul>
                  {!message.parts.some((part) => ["tool_call", "command", "file_change"].includes(part.type)) && (
                    <p>{t("Nenhuma ação confirmada no histórico. Confira o estado atual antes de continuar.")}</p>
                  )}
                </section>
              )}
            </>
          ) : (
            <>
              <strong>{runError.title}</strong>
              <p>
                {runError.stageLabel} · {runError.detail}
              </p>
              <time className="message-error-meta" dateTime={new Date(failedAt).toISOString()}>
                {failureTime}
              </time>
              <ErrorDetails code={runError.code} />
              {(vmBotId || runError.specificHint) && <p>{runError.hint}</p>}
              {failureAction && failureAction.kind !== "machine_service" && (
                <button type="button" className="text-button" onClick={() => onFailureAction(failureAction)}>
                  {failureAction.label}
                </button>
              )}
              {vmBotId &&
                api &&
                (runError.action?.kind === "machine_service" ||
                  message.parts.some(
                    (part) =>
                      part.type === "notice" && /^machine_service_(?:unavailable|start_failed):/.test(part.text),
                  )) && <MachineServiceButton api={api} botId={vmBotId} />}
              {message.runId &&
                (!vmBotId ||
                  machine?.status === "running" ||
                  (machine?.status === "error" && !/^TOURI-E800[12]$/.test(runError.code))) && (
                  <button
                    type="button"
                    className="text-button retry-button"
                    onClick={() => void onRetry(message.runId ?? "")}
                  >
                    {t("Tentar novamente")}
                  </button>
                )}
            </>
          )}
        </div>
      )
    )
  return (
    <article
      ref={root}
      className={`message-bubble ${messageClass}${routinePrompt ? " message-routine-prompt" : ""}${quietBrowserNarration ? " message-browser-narration" : ""}`}
      data-message-id={message.id}
      data-motion-insert={inserted}
    >
      {routineHeader && <small className="routine-run-header">{routineHeader}</small>}
      {!routinePrompt && (
        <div className="message-meta">
          {personSender && (
            <span className="message-sender-avatar" aria-hidden="true">
              <PersonAvatar
                person={{ id: personSender.id, avatarSeed: personSender.avatarSeed ?? personSender.id }}
                size={22}
              />
            </span>
          )}
          {message.role === "assistant" &&
            message.sender &&
            (senderBot ? (
              <BotAvatar bot={senderBot} size={22} state={mascotState} />
            ) : (
              <span role="img" aria-label={t("Membro excluído: {name}", { name: message.sender.name })}>
                <BotAvatar
                  bot={{ id: message.sender.id, color: null, avatarShape: "none-none" }}
                  size={22}
                  state="idle"
                  still
                />
              </span>
            ))}
          <span className="message-role">{messageRoleLabel}</span>
          {message.sender?.kind === "integration" && (
            <span className="message-sender-kind">{t("Integração", {}, locale)}</span>
          )}
          <time dateTime={new Date(message.createdAt).toISOString()}>
            {new Date(message.createdAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
          </time>
          {hasBrowserTools && (
            <span className="browser-run-state" role="status">
              {getBrowserRunLabel()}
            </span>
          )}
          {message.role === "user" && message.delivery && message.delivery.status !== "acked" && (
            <span className="delivery-state" role="status">
              {t(deliveryLabels[message.delivery.status], {}, locale)}
            </span>
          )}
          {message.status === "canceled" && (
            <span className="run-status chat-terminal-status" role="status">
              {t("Cancelado por você")}
            </span>
          )}
        </div>
      )}
      {message.role === "assistant" ? (
        segments.map((segment) => {
          if (segment.type === "browser-steps")
            return quietBrowserNarration ? renderBrowserSteps(segment.key, segment.count) : null
          if (segment.type === "text") {
            if (foldBrowserFlow && segment !== finalText) return null
            const answer = renderAnswer(segment.text, segment === finalText)
            if (!quietBrowserNarration) return <Fragment key={segment.key}>{answer}</Fragment>
            if (!answer) return null

            return (
              <div className="browser-narration" key={segment.key}>
                <strong>{senderName}:</strong>
                {answer}
              </div>
            )
          }
          if (segment.type === "resume")
            return (
              <p key={segment.key} className="run-resumed-marker" role="note">
                <span>{getResumeMarkerText(segment.text, locale)}</span>
              </p>
            )
          if (segment.type === "approval")
            return (
              <ApprovalCard
                key={segment.key}
                part={segment.part}
                tool={matchedApprovals.get(segment.part.approvalId)}
                api={api}
                finished={message.status !== "streaming"}
                createdAt={message.createdAt}
                onResolved={(_, decision) =>
                  setAnswers((current) => ({ ...current, [segment.part.approvalId]: decision }))
                }
              />
            )
          if (segment.type === "attachments")
            return <MessageAttachments key={segment.key} parts={segment.parts} api={api} />
          return (
            <TurnActivity
              key={segment.key}
              message={{ ...message, parts }}
              locale={locale}
              state={mascotState}
              run={run}
              browserActivity={browserActivity}
              hideBrowserActivity={hideBrowserActivity}
              botName={messageRoleLabel}
              api={api}
              bot={bot}
              onCancel={showActivityStop ? onCancel : undefined}
              preparingEnvironment={Boolean(vmBotId)}
              hideBrowserCard={hasBrowserTools}
              onFocusApproval={(approvalId) => {
                const card = Array.from(root.current?.querySelectorAll<HTMLElement>("[data-approval-id]") ?? []).find(
                  (element) => element.dataset.approvalId === approvalId,
                )
                card?.scrollIntoView?.({ block: "center", behavior: "instant" })
                card?.focus({ preventScroll: true })
              }}
            />
          )
        })
      ) : routinePrompt ? (
        <ChatDisclosure label={t("Instruções da rotina")}>
          <MarkdownContent content={text} />
          <MessageAttachments parts={parts.filter((part) => part.type === "image" || part.type === "file")} api={api} />
        </ChatDisclosure>
      ) : text ? (
        technicalNotice ? (
          <ChatDisclosure label={t("Detalhes técnicos")}>
            <pre>{text}</pre>
          </ChatDisclosure>
        ) : message.role === "tool" ? (
          <ToolText text={text} />
        ) : (
          <MarkdownContent content={message.role === "system" ? localizeNotice(text) : text} />
        )
      ) : null}
      {hasBrowserTools && !hideBrowserActivity && (
        <BrowserTurnCard
          message={Object.assign({}, message, { parts })}
          run={run}
          bot={bot}
          activity={browserActivity}
          locale={locale}
        >
          {foldBrowserFlow
            ? segments.map((flow) => {
                if (flow.type === "browser-steps") return renderBrowserSteps(flow.key, flow.count)
                if (flow.type !== "text" || flow === finalText) return null

                return (
                  <div className="browser-narration" key={flow.key}>
                    <strong>{senderName}:</strong>
                    <MarkdownContent content={flow.text.replace(connectDataMarker, "")} />
                  </div>
                )
              })
            : undefined}
        </BrowserTurnCard>
      )}
      {browserHandoffExpired && (
        <p className="chat-terminal-status" role="status">
          {t("No one took over in time. Ask again when you can.", {}, locale)}
        </p>
      )}
      {message.role !== "assistant" && !routinePrompt && (
        <MessageAttachments parts={parts.filter((part) => part.type === "image" || part.type === "file")} api={api} />
      )}
      {message.role === "user" && onEdit && (
        <UserMessageEdit
          message={message}
          onEdit={onEdit}
          disabled={editDisabled || message.delivery?.status === "queued" || message.delivery?.status === "sent"}
        />
      )}
      {message.role !== "assistant" && (
        <ToolCallList
          parts={parts}
          api={api}
          finished={message.status !== "streaming"}
          createdAt={message.createdAt}
          onResolved={(approvalId, decision) => setAnswers((current) => ({ ...current, [approvalId]: decision }))}
        />
      )}
      {parts.some(screenTool) && !hasBrowserTools && (
        <ChatDisclosure label={t("Advanced computer view")}>
          <InlineLivePreview parts={parts} finished={message.status !== "streaming"} />
        </ChatDisclosure>
      )}
      {siblings.length > 1 && (
        <fieldset className="branch-switcher">
          <legend className="visually-hidden">{t("Message branches")}</legend>
          <button
            type="button"
            onClick={() => onSwitchBranch(message, siblings, Math.max(0, branchIndex - 1))}
            disabled={branchIndex === 0}
            aria-label={t("Previous branch")}
          >
            ‹
          </button>
          <span>
            {branchIndex + 1}/{siblings.length}
          </span>
          <button
            type="button"
            onClick={() => onSwitchBranch(message, siblings, Math.min(siblings.length - 1, branchIndex + 1))}
            disabled={branchIndex === siblings.length - 1}
            aria-label={t("Next branch")}
          >
            <PanelIcon name="chevron-right" />
          </button>
        </fieldset>
      )}
      {(run?.automaticResumePending ||
        (run?.automaticResumeFromRunId && ["queued", "starting", "running"].includes(run.status))) && (
        <p className="run-resumed-marker" role="status">
          {t("Retomando automaticamente…")}
        </p>
      )}
      {run?.automaticResumePending && onCancel && (
        <button type="button" className="text-button" onClick={() => void onCancel(run.id)}>
          {t("Stop reply button")}
        </button>
      )}
      {resolvedInterruption && (
        <p className="run-resumed-marker" role="note">
          {t("Interrupção anterior · resolvida")}
        </p>
      )}
      {runError && (recovered || resolvedInterruption) ? (
        <div className="message-error-history">
          <button
            type="button"
            className="text-button"
            aria-expanded={failureExpanded}
            onClick={() => setFailureExpanded((expanded) => !expanded)}
          >
            {!resolvedInterruption && (
              <>
                {runError.title} · {failureTime} · {recovered && `${t("A reply followed this error")} · `}
              </>
            )}
            {failureExpanded ? t("Hide error") : t(resolvedInterruption ? "Ver erro" : "View error")}
          </button>
          {failureExpanded && resolvedInterruption && (
            <p className="message-error-meta">
              {runError.title} · {failureTime}
            </p>
          )}
          {failureExpanded && failureContent}
        </div>
      ) : (
        failureContent
      )}
    </article>
  )
}

export const ChatPanel = ({
  currentPersonId = "owner",
  channelThreads = [],
  channelMessages = [],
  onSelectChannelThread,
  composerKey,
  threadCreation,
  onRetryCreateThread,
  onResumeBot,
  autoFocusComposer = false,
  onRepeatTask,
  group = null,
  groupMembers = [],
  channelMode = false,
  workspaceMode = "bots",
  onEditGroup = () => {},
  channelBrowser = null,
  browserRuns = [],
  onInviteToGroup,
  focusApproval,
  thread,
  activePath,
  goalRefreshRequest = 0,
  onGoalChange,
  bot,
  panelOpen = false,
  onTogglePanel,
  machine: rawMachine,
  messages,
  runs,
  onSend,
  onRetry,
  onCancel,
  onSwitchBranch,
  computerGrant,
  api,
  onComputerGrant,
  onOpenTools,
  onOpenPermissions,
  attachmentButtonRef: sharedAttachmentButtonRef,
  onOpenToolCatalog,
  onOpenProviderLogin,
  onOpenComputer,
  projects,
  onSaveModel,
  onNotice,
  onSelectProject,
  onAddProject,
  routines = [],
  routineRuns = [],
}: ChatPanelProps) => {
  const channelBrowserValue =
    channelBrowser ??
    getChannelBrowserValue({
      runs: browserRuns,
      bots: groupMembers,
      threadId: thread?.id ?? "",
      viewerId: currentPersonId ?? "",
    })
  const phone = usePhoneViewport()
  const chatIsCovered = panelOpen && phone
  const host = useHost(api)
  const serverMode = useIsServerMode() || host === "server"
  const machine = machineStateForDisplay(rawMachine)
  const mascotSnapshot = useMascotSnapshot({ id: bot?.id ?? "", color: bot?.color ?? null }, thread?.id)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const draftComposerRef = useRef<DraftComposerHandle>(null)
  const localAttachmentButtonRef = useRef<HTMLButtonElement>(null)
  const attachmentButtonRef = sharedAttachmentButtonRef ?? localAttachmentButtonRef
  useEffect(() => {
    if (!chatIsCovered) return
    const frame = window.requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>("#bot-panel .bot-panel-top button")?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [chatIsCovered])
  const channelPeople = useChannelPeople(api, group?.id ?? null)
  const sharedChannelThreads = useMemo(
    () => (group ? getChannelThreads(channelThreads, group.id) : []),
    [group, channelThreads],
  )
  const isChannelRoot = sharedChannelThreads[0]?.id === thread?.id
  const groupProgress = useMemo(
    () => (group ? getGroupProgress(thread?.id, runs) : undefined),
    [group, thread?.id, runs],
  )
  const activeRun = useMemo(
    () =>
      groupProgress?.control ??
      runs.find(
        (run) => thread && run.threadId === thread.id && ["queued", "starting", "running"].includes(run.status),
      ) ??
      runs.find((run) => run.id === channelBrowserValue?.state.runId) ??
      null,
    [runs, thread, groupProgress?.control, channelBrowserValue?.state.runId],
  )
  const serviceRecovered = bot?.machine === "vm" && (machine?.status === "starting" || machine?.status === "running")
  const visibleRuns = useMemo(
    () =>
      runs.filter(
        (run) =>
          run.threadId === thread?.id &&
          isRoutineRun(run) &&
          !(serviceRecovered && /^machine_service_(?:unavailable|start_failed)$/.test(run.errorClass ?? "")),
      ),
    [runs, thread?.id, serviceRecovered],
  )

  if (!thread)
    return (
      <ChannelBrowserRunsContext.Provider
        value={{ runs: browserRuns, bots: groupMembers, threadId: "", viewerId: currentPersonId ?? "" }}
      >
        <ChannelBrowserContext.Provider value={channelBrowserValue}>
          <section className="chat-panel" inert={chatIsCovered || undefined} aria-hidden={chatIsCovered || undefined}>
            <header className="chat-header" data-tauri-drag-region="deep">
              <span className="chat-header-crumb">{t(workspaceMode === "work" ? "Direct messages" : "Bots")}</span>
              <div className="chat-bot-chip">
                {bot && <BotAvatar bot={bot} size={18} />}
                <h1 className="chat-page-heading">{bot?.name ?? "touri"}</h1>
                {bot?.anyFolderAccess && (
                  <span className="any-folder-badge">
                    {t("Any folder on this {host}", { host: getHostLabel(host) })}
                  </span>
                )}
              </div>
              <div className="chat-toolbar">
                {onTogglePanel && (
                  <button
                    type="button"
                    className="toolbar-icon bot-panel-toggle"
                    aria-label={t("Bot panel")}
                    title={t("Bot advanced")}
                    aria-expanded={panelOpen}
                    aria-controls="bot-panel"
                    onClick={onTogglePanel}
                  >
                    <PanelIcon name="panel" />
                  </button>
                )}
              </div>
            </header>
            <div className="empty-state">
              <img className="empty-bull" src="/touri-bull.png" alt="" />
              <h2>{t("Escolha uma conversa")}</h2>
              <p>{t("Selecione um bot ou crie uma nova thread.")}</p>
            </div>
          </section>
        </ChannelBrowserContext.Provider>
      </ChannelBrowserRunsContext.Provider>
    )

  const messagePath = group
    ? messages.filter((message) => message.threadId === thread.id && !isGroupCoordinationPrompt(message))
    : (activePath ??
      activeMessagePath(
        messages.filter((message) => message.threadId === thread.id),
        thread.activeLeafId,
      ))
  const visibleMessageIds = new Set(messagePath.map((message) => message.id))
  const pendingMessages = messages.filter(
    (message) =>
      message.threadId === thread.id &&
      ((message.delivery && message.delivery.status !== "acked") ||
        message.parts.some((part) => part.type === "approval" && part.decision === "pending")) &&
      !visibleMessageIds.has(message.id),
  )
  const visibleMessages = getBrowserRequestMessages(messagePath.concat(pendingMessages), runs)
  const routineConversation = isRoutineConversation({ thread, runs, routineRuns, routines })
  const repeatDraft =
    bot && !activeRun && !routineConversation
      ? group
        ? repeatTaskDraft(bot, thread, visibleMessages, group)
        : (repeatTaskDraft(bot, thread, visibleMessages) ??
          (visibleMessages.length === 0 ? suggestedRoutineDraft(bot) : null))
      : null
  const latestReply = [...visibleMessages].reverse().find((message) => message.role === "assistant")
  const connectDataReply =
    !group &&
    bot &&
    !activeRun &&
    latestReply?.status === "complete" &&
    [...visibleMessages].reverse().find((message) => message.role === "user" || message.role === "assistant") ===
      latestReply &&
    connectDataMarker.test(messageMarkdown(latestReply))
      ? latestReply
      : null
  const activityState =
    mascotSnapshot.state === "idle"
      ? mascotSignalFor({
          botId: bot?.id ?? activeRun?.botId ?? "",
          paused: bot?.paused ?? false,
          runs: runs.filter((run) => run.threadId === thread.id),
          messages: visibleMessages,
          waiting: computerGrant?.threadId === thread.id,
        }).state
      : mascotSnapshot.state
  // Index once for all active executions instead of rescanning history for each bot.
  const replyRunIds = new Set(
    visibleMessages.flatMap((message) => (message.role === "assistant" && message.runId ? [message.runId] : [])),
  )
  const progressRuns = groupProgress?.progress ?? (activeRun ? [activeRun] : [])
  const pendingRuns = progressRuns.filter((run) => !replyRunIds.has(run.id))
  const groupBotsById = new Map(groupMembers.map((member) => [member.id, member]))

  const activeScreenTool = [...visibleMessages]
    .reverse()
    .filter(
      (message) =>
        message.status === "streaming" &&
        !runs.some(
          (run) => run.id === message.runId && ["succeeded", "failed", "canceled", "interrupted"].includes(run.status),
        ),
    )
    .flatMap((message) => [...message.parts].reverse())
    .find((part) => screenTool(part) && part.type === "tool_call" && toolStatus(part) === "running")
  const browserWorking = Boolean(
    channelBrowserValue ||
      (latestReply?.status === "streaming" && getBrowserActivityTools(latestReply.parts).length > 0),
  )
  return (
    <ChannelBrowserRunsContext.Provider
      value={{ runs: browserRuns, bots: groupMembers, threadId: thread?.id ?? "", viewerId: currentPersonId ?? "" }}
    >
      <ChannelBrowserContext.Provider value={channelBrowserValue}>
        <BrowserActivityControlsProvider>
          <section className="chat-panel" inert={chatIsCovered || undefined} aria-hidden={chatIsCovered || undefined}>
            {group ? (
              <Suspense fallback={null}>
                <GroupHeader
                  group={group}
                  bots={groupMembers}
                  people={channelPeople}
                  channelMode={channelMode}
                  onEdit={onEditGroup}
                  onInvite={onInviteToGroup}
                  panelOpen={panelOpen}
                  onTogglePanel={onTogglePanel}
                />
              </Suspense>
            ) : (
              <header className="chat-header" data-tauri-drag-region="deep">
                <span className="chat-header-crumb">{t(workspaceMode === "work" ? "Direct messages" : "Bots")}</span>
                <div className="chat-bot-chip">
                  {bot ? (
                    <BotAvatar bot={bot} size={18} threadId={thread.id} state={activityState} />
                  ) : (
                    <img src="/touri-bull.png" alt="" />
                  )}
                  <h1 className="chat-page-heading">{bot?.name ?? "touri"}</h1>
                  {bot?.anyFolderAccess && (
                    <span className="any-folder-badge">
                      {t("Any folder on this {host}", { host: getHostLabel(host) })}
                    </span>
                  )}
                </div>
                <div className="chat-toolbar">
                  {onTogglePanel && (
                    <button
                      type="button"
                      className="toolbar-icon bot-panel-toggle"
                      aria-label={t("Bot panel")}
                      title={t("Bot advanced")}
                      aria-expanded={panelOpen}
                      aria-controls="bot-panel"
                      onClick={onTogglePanel}
                    >
                      <PanelIcon name="panel" />
                    </button>
                  )}
                </div>
              </header>
            )}
            {!group && bot && !routineConversation && (
              <GoalPanel
                key={thread.id}
                api={api}
                threadId={thread.id}
                bot={bot}
                surface="chat"
                refreshRequest={goalRefreshRequest}
                onChange={onGoalChange}
                busy={runs.some(
                  (run) => run.threadId === thread.id && ["queued", "starting", "running"].includes(run.status),
                )}
              />
            )}
            {!group && bot?.machine === "vm" && machine && (activeRun || machine.status === "starting") && (
              <MachineStatus
                key={bot.id}
                machine={machine}
                api={api}
                turnFailed={!activeRun && latestReply?.status === "failed"}
                activeTurns={runs.some(
                  (run) => run.botId === bot.id && ["queued", "starting", "running"].includes(run.status),
                )}
              />
            )}
            {computerGrant && computerGrant.threadId === thread.id && activeRun?.botId === computerGrant.botId && (
              <ComputerGrantCard
                api={api}
                botId={computerGrant.botId}
                threadId={computerGrant.threadId}
                botName={computerGrant.botName}
                onGranted={onComputerGrant}
              />
            )}
            <InlinePreviewContext.Provider
              value={{
                api,
                bot,
                machine: rawMachine,
                onOpenComputer: onOpenComputer ?? (() => onOpenTools("browser")),
                activeCallId: activeScreenTool?.type === "tool_call" ? activeScreenTool.callId : undefined,
              }}
            >
              <VirtualMessageList
                vmBotId={bot?.machine === "vm" ? bot.id : undefined}
                currentPersonId={currentPersonId}
                machine={machine}
                focusApproval={focusApproval}
                key={composerKey ?? thread.id}
                messages={visibleMessages}
                api={api}
                runs={runs}
                mainThread={thread.kind === "main"}
                routines={routines}
                routineRuns={routineRuns}
                allMessages={messages}
                onSwitchBranch={(_message, siblings, index) => {
                  const next = siblings[index]
                  if (next) void onSwitchBranch(thread.id, next.id)
                }}
                onRetry={onRetry}
                onCancel={onCancel}
                // Group replies use a flat history, so sibling edits cannot be selected there.
                onEdit={group ? undefined : onSend}
                editDisabled={Boolean(activeRun)}
                showActivityStop={!group}
                header={
                  visibleMessages.length === 0 &&
                  !activeRun &&
                  visibleRuns.length === 0 &&
                  !(isChannelRoot && sharedChannelThreads.length > 1) ? (
                    group ? (
                      <Suspense fallback={null}>
                        <GroupConversationStart
                          group={group}
                          bots={groupMembers}
                          people={channelPeople}
                          currentPersonId={currentPersonId}
                          channelMode={channelMode}
                        />
                      </Suspense>
                    ) : (
                      <ConversationStart
                        bot={bot}
                        onFolder={onOpenPermissions}
                        onAttach={() => attachmentButtonRef.current?.click()}
                        onChoose={(prompt) => {
                          draftComposerRef.current?.setDraft(prompt)
                          composerRef.current?.focus()
                        }}
                      />
                    )
                  ) : null
                }
                timelineCards={[
                  ...(group && onSelectChannelThread && isChannelRoot && sharedChannelThreads.length > 1
                    ? [
                        {
                          id: `channel-threads-${group.id}`,
                          createdAt: sharedChannelThreads
                            .slice(1)
                            .reduce((latest, candidate) => Math.max(latest, candidate.updatedAt), 0),
                          content: (
                            <Suspense fallback={null}>
                              <ChannelThreads
                                groupId={group.id}
                                threads={channelThreads}
                                messages={channelMessages}
                                onSelect={onSelectChannelThread}
                              />
                            </Suspense>
                          ),
                        },
                      ]
                    : []),
                  ...(repeatDraft && onRepeatTask && !connectDataReply
                    ? [
                        {
                          id: `repeat-${latestReply?.id}`,
                          createdAt: (latestReply?.createdAt ?? 0) + 2,
                          content: (
                            <button
                              type="button"
                              className="outline-button repeat-task-button"
                              onClick={() => onRepeatTask(repeatDraft)}
                            >
                              {t("Agendar esta tarefa")}
                            </button>
                          ),
                        },
                      ]
                    : []),
                  ...(connectDataReply && onOpenToolCatalog
                    ? [
                        {
                          id: `connect-data-${connectDataReply.id}`,
                          createdAt: connectDataReply.createdAt + 1,
                          content: (
                            <ConnectDataCard
                              desktop={!serverMode && "__TAURI_INTERNALS__" in window}
                              onAttach={() => attachmentButtonRef.current?.click()}
                              onFolder={bot?.machine === "cloud" ? undefined : onOpenPermissions}
                              onCatalog={onOpenToolCatalog}
                            />
                          ),
                        },
                      ]
                    : []),
                  ...pendingRuns.map((run) => {
                    const member = group ? groupBotsById.get(run.botId) : bot

                    return {
                      id: `activity-${run.id}`,
                      createdAt: run.queuedAt,
                      content: (
                        <article className="message-bubble message-assistant" data-pending-run={run.id}>
                          <div className="message-meta">
                            <span className="message-role">{member?.name ?? "touri"}</span>
                          </div>
                          <ActivityMark
                            state={!group && activityState === "waiting-approval" ? activityState : "thinking"}
                            bot={member ?? undefined}
                            threadId={thread.id}
                            run={run}
                            api={api}
                            onCancel={group ? undefined : onCancel}
                            preparingEnvironment={member?.machine === "vm"}
                          />
                        </article>
                      ),
                    }
                  }),
                  ...visibleRuns.map((run) => {
                    const routineRun = routineRuns.find((item) => item.id === run.routineRunId)
                    const routine = routines.find((item) => item.id === routineRun?.routineId)

                    return {
                      id: `card-${run.id}`,
                      createdAt: run.queuedAt,
                      content: (
                        <RunCard
                          bot={bot}
                          run={run}
                          thread={thread}
                          onRetry={onRetry}
                          routineName={routine?.name}
                          routineTimeZone={routine?.timezone}
                          waitingApproval={messages.some(
                            (message) =>
                              message.runId === run.id &&
                              message.parts.some((part) => part.type === "approval" && part.decision === "pending"),
                          )}
                        />
                      ),
                    }
                  }),
                ]}
              />
            </InlinePreviewContext.Provider>
            {/* r8 composer: notices and the input island stay isolated from transcript activity. */}
            <DraftComposer
              key={`composer-${composerKey ?? thread.id}`}
              draftIdentity={composerKey ?? thread.id}
              threadCreation={threadCreation}
              onRetryCreateThread={onRetryCreateThread}
              onResumeBot={onResumeBot}
              autoFocus={autoFocusComposer}
              draftRef={draftComposerRef}
              notice={{
                bot,
                latestReply,
                machine,
                onOpenPermissions,
                onOpenProviderLogin: group ? undefined : onOpenProviderLogin,
              }}
              bot={group ? null : bot}
              groupName={group?.name}
              summaryBotId={group?.coordinatorBotId}
              mentionBots={groupMembers}
              mentionPeople={channelPeople}
              threadId={thread.id}
              parentId={thread.activeLeafId}
              api={api}
              inputRef={composerRef}
              attachmentButtonRef={attachmentButtonRef}
              activeRun={activeRun}
              memberRuns={groupProgress?.executions}
              browserWorking={browserWorking}
              browserBotName={channelBrowserValue?.state.botName ?? latestReply?.sender?.name ?? bot?.name ?? "touri"}
              botActive={runs.some(
                (run) => run.botId === bot?.id && ["queued", "starting", "running"].includes(run.status),
              )}
              projects={projects}
              onSaveModel={onSaveModel}
              onNotice={onNotice}
              onSelectProject={onSelectProject}
              onAddProject={onAddProject}
              queuedCount={visibleMessages.filter((message) => message.delivery?.status === "queued").length}
              onSend={onSend}
              onCancel={onCancel}
              onOpenPermissions={group ? undefined : onOpenPermissions}
              onOpenProviderLogin={group ? undefined : onOpenProviderLogin}
            />
            {/* End r8 composer. */}
          </section>
        </BrowserActivityControlsProvider>
      </ChannelBrowserContext.Provider>
    </ChannelBrowserRunsContext.Provider>
  )
}

const RunCard = ({
  bot,
  run,
  thread,
  onRetry,
  routineName,
  routineTimeZone,
  waitingApproval,
}: {
  waitingApproval: boolean
  routineName?: string | undefined
  routineTimeZone?: string | undefined
  bot: Bot | null
  run: Run
  thread: Thread
  onRetry: (runId: Id) => Promise<void>
}) => {
  const presentation = getRoutineRunPresentation(run, waitingApproval)
  const timestamp = run.finishedAt ?? run.startedAt ?? run.queuedAt
  const date = new Date(timestamp)

  return (
    <article className={`run-card routine-run-marker ${presentation.failed ? "run-failed" : ""}`}>
      <div className="run-card-heading">
        {bot && <BotAvatar bot={bot} size={20} />}
        <strong>{routineName ?? getSidebarThreadTitle(thread)}</strong>
        <span className={`run-status ${presentation.className}`}>{presentation.label}</span>
        <time dateTime={date.toISOString()} title={getRoutineRunDateLabel(timestamp, "pt-BR", routineTimeZone)}>
          {getRoutineRunTimeLabel(timestamp, "pt-BR", routineTimeZone)}
        </time>
        {presentation.failed && (
          <button type="button" className="open-run-link" onClick={() => void onRetry(run.id)}>
            {t("Tentar novamente")}
          </button>
        )}
      </div>
      {presentation.summary && (
        <div className="run-card-summary">
          <ErrorText text={presentation.summary} />
        </div>
      )}
    </article>
  )
}

const getRoutineRunPresentation = (run: Run, waitingApproval: boolean) => {
  const running = ["queued", "starting", "running"].includes(run.status)
  if (running && waitingApproval)
    return {
      label: t("Waiting for approval"),
      className: "status-waiting-approval",
      summary: t("Review the approval card to continue the routine."),
    }
  if (run.status === "queued") return { label: getQueueLabel(run), className: "status-queued" }
  if (running) return { label: t("Em execução"), className: "status-running" }
  if (run.status === "canceled") return { label: t("Cancelado por você"), className: "status-canceled" }
  if (["failed", "interrupted"].includes(run.status))
    return { label: t("Falhou"), className: "status-failed", summary: userFacingRunError(run), failed: true }

  return { label: t("Concluído"), className: "status-complete" }
}

const isSameChannelRequest = (run: Run, candidate: Run | undefined, runsById: ReadonlyMap<string, Run>): boolean => {
  if (!candidate || candidate.botId !== run.botId) return false
  if (run.requestMessageId && candidate.requestMessageId === run.requestMessageId) return true
  const original = runsById.get(run.groupTurnId ?? "")
  const continuation = runsById.get(candidate.groupTurnId ?? "")

  return Boolean(original?.requestMessageId && original.requestMessageId === continuation?.requestMessageId)
}
