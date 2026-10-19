import type {
  Bot,
  BotGroup,
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
import { Fragment, type ReactNode, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { UiApi } from "../api/client"
import type { ApprovalFocus } from "../approvalNavigation"
import { userFacingRunError } from "../errors"
import { ComputerGrantCard } from "../features/computer"
import { InlineLivePreview, InlinePreviewContext, screenTool } from "../features/desktop/InlineLivePreview"
import { useIsServerMode } from "../features/server/serverMode"
import { getQueueLabel } from "../features/work/presentation"
import { getHostLabel, getRoutineRunDateLabel, getRoutineRunTimeLabel, localizeNotice, t } from "../i18n"
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
import { BotAvatar } from "./BotAvatar"
import { ChatDisclosure } from "./ChatDisclosure"
import { ConnectDataCard, connectDataMarker } from "./ConnectDataCard"
import { ConversationStart } from "./ConversationStart"
import { DraftComposer, type DraftComposerHandle } from "./DraftComposer"
import { ErrorDetails, ErrorText } from "./ErrorDetails"
import { ErrorNotice } from "./ErrorNotice"
import { EvidenceContext } from "./EvidenceGallery"
import { FailureActionContext } from "./FailureActionContext"
import { GoalPanel } from "./GoalPanel"
import { GroupConversationStart, GroupHeader } from "./Groups"
import { MachineServiceButton } from "./MachineServiceButton"
import { MachineStatus } from "./MachineStatus"
import { MarkdownContent } from "./MarkdownContent"
import { MessageAttachments } from "./MessageAttachments"
import { useInsertedIds } from "./Motion"
import { mascotSignalFor } from "./mascotState"
import { ToolCallList } from "./ToolCallList"
import { ToolText } from "./ToolOutput"
import { TurnActivity } from "./TurnActivity"
import { toolStatus } from "./toolPresentation"
import { approvalTools, assistantSegments } from "./turnActivityModel"
import { type EditMessage, UserMessageEdit } from "./UserMessageEdit"
import { usePhoneViewport } from "./usePhoneViewport"

type ChatPanelProps = {
  composerKey?: string | undefined
  threadCreation?: Exclude<ThreadCreationStatus, "draft"> | undefined
  onRetryCreateThread?: (() => void) | undefined
  onRepeatTask?: ((draft: RoutineDraft) => void) | undefined
  group?: BotGroup | null
  groupMembers?: Bot[]
  onEditGroup?: () => void
  focusApproval?: ApprovalFocus | undefined
  panelOpen?: boolean
  onTogglePanel?: () => void
  routines?: Array<Routine>
  routineRuns?: Array<RoutineRun>
  attachmentButtonRef?: React.RefObject<HTMLButtonElement | null> | undefined
  onOpenPermissions?: () => void
  onOpenToolCatalog?: () => void
  onOpenProviderLogin?: () => void
  onOpenComputer?: () => void
  projects?: Project[]
  onOpenModel?: () => void
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
  machine?: MachineState | undefined
  focusApproval?: ApprovalFocus | undefined
  messages: Array<Message>
  api?: UiApi
  runs?: Array<Run>
  onSwitchBranch: (message: Message, siblings: Array<Message>, index: number) => void
  onRetry: (runId: Id) => Promise<void>
  onEdit?: EditMessage | undefined
  onCancel?: ((runId: Id) => Promise<void>) | undefined
  editDisabled?: boolean
  header?: ReactNode
  allMessages?: Array<Message>
  timelineCards?: Array<{ id: string; createdAt: number; content: ReactNode }>
}

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
  sent: t("Sending message…"),
  acked: "Entregue",
  failed: "Falha na entrega",
}
const rowHeight = 158

/** Jump to the end and remember the position so its own scroll event is not mistaken for the user leaving the bottom. */
const scrollToEnd = (list: HTMLElement, programmaticTop: { current: number | null }): void => {
  list.scrollTop = Math.max(0, list.scrollHeight - list.clientHeight)
  programmaticTop.current = list.scrollTop
}

export const VirtualMessageList = ({
  vmBotId,
  machine,
  focusApproval,
  messages,
  api,
  runs = [],
  allMessages = messages,
  onSwitchBranch,
  onRetry,
  onEdit,
  onCancel,
  editDisabled = false,
  header,
  timelineCards = [],
}: VirtualMessageListProps) => {
  // r8 motion: immutable IDs drive text entry, never streaming tokens or status/cards.
  const insertedMessages = useInsertedIds(
    messages.map((message) => message.id),
    messages[0]?.threadId ?? "",
  )
  const [scrollTop, setScrollTop] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const followBottom = useRef(true)
  const programmaticTop = useRef<number | null>(null)
  const readingAnchor = useRef<{ element: HTMLElement; top: number; scrollTop: number } | null>(null)
  const [awayFromBottom, setAwayFromBottom] = useState(false)
  const [unseenCount, setUnseenCount] = useState(0)
  const observedMessages = useRef(messages)
  const lastUser = useRef<Id | undefined>(undefined)
  const focusedRequest = useRef<number | undefined>(undefined)
  const latestUserId = [...messages].reverse().find((message) => message.role === "user")?.id
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
    const content = contentRef.current
    if (!list || !content || typeof ResizeObserver === "undefined") return
    // Markdown and the virtual window can grow after the first layout of a new turn.
    const observer = new ResizeObserver(() => {
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
      const collapsed = anchor?.element.matches("summary")
        ? anchor.element.parentElement instanceof HTMLDetailsElement && !anchor.element.parentElement.open
        : anchor?.element.getAttribute("aria-expanded") === "false"
      if (atBottom && collapsed) {
        readingAnchor.current = null
        followBottom.current = true
      }
      setAwayFromBottom(!atBottom)
      setScrollTop(list.scrollTop)
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [])
  const timeline = [
    ...messages.map((message) => ({
      id: message.id,
      createdAt: message.createdAt,
      message,
      content: null as ReactNode,
    })),
    ...timelineCards.map((card) => ({ ...card, message: null })),
  ].sort((a, b) => a.createdAt - b.createdAt)
  const visibleCount = 34
  const targetIndex = focusApproval
    ? timeline.findIndex((entry) =>
        entry.message?.parts.some((part) => part.type === "approval" && part.approvalId === focusApproval.approvalId),
      )
    : -1
  const revealTarget = targetIndex >= 0 && focusApproval?.request !== focusedRequest.current
  const start =
    timeline.length > 100
      ? Math.min(
          Math.max(0, timeline.length - visibleCount),
          Math.max(0, (revealTarget ? targetIndex : Math.floor(scrollTop / rowHeight)) - 4),
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
    if (timeline.length > 100) list.scrollTop = targetIndex * rowHeight
    card.scrollIntoView?.({ block: "center", behavior: "instant" })
    card.focus({ preventScroll: true })
    setScrollTop(list.scrollTop)
  }, [focusApproval, targetIndex, timeline.length])

  return (
    <div className="chat-message-list">
      <div
        className="message-scroll"
        ref={scrollRef}
        data-testid="virtual-message-list"
        onClickCapture={(event) => {
          if (!(event.target instanceof Element)) return
          const control = event.target.closest<HTMLElement>(
            "summary, .chat-disclosure-toggle, .turn-activity-toggle, .disclosure-summary, .message-error-history > button",
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
        <div style={{ height: timeline.length > 100 ? timeline.length * rowHeight : undefined }}>
          <div
            ref={contentRef}
            style={{ transform: timeline.length > 100 ? `translateY(${start * rowHeight}px)` : undefined }}
          >
            {visible.map((entry, index) => {
              if (!entry.message) return <Fragment key={entry.id}>{entry.content}</Fragment>
              const saved = entry.message
              if (isResumeMarker(saved))
                return (
                  <p key={saved.id} className="run-resumed-marker" role="note" data-message-id={saved.id}>
                    <span>
                      {saved.text === "Retomado após aprovação de acesso"
                        ? t("Retomado após aprovação de acesso")
                        : saved.text}
                    </span>
                  </p>
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
                <Fragment key={message.id}>
                  {(index === 0 || !sameCalendarDay(visible[index - 1]?.createdAt ?? 0, message.createdAt)) && (
                    <div className="day-divider">
                      <span>{formatDaySeparator(message.createdAt)}</span>
                    </div>
                  )}
                  <MessageBubble
                    inserted={insertedMessages.has(message.id)}
                    vmBotId={vmBotId}
                    machine={machine}
                    message={message}
                    run={run}
                    routineReply={getRoutineReplyRun(message, runs, allMessages) !== undefined}
                    routinePrompt={
                      message.role === "user" &&
                      runs.some((candidate) => isRoutineRun(candidate) && candidate.requestMessageId === message.id)
                    }
                    recovered={
                      runs.some(
                        (later) =>
                          later.threadId === message.threadId &&
                          later.status === "succeeded" &&
                          (later.finishedAt ?? later.startedAt ?? later.queuedAt) >
                            (run?.finishedAt ?? message.updatedAt),
                      ) ||
                      allMessages.some(
                        (later) =>
                          later.threadId === message.threadId &&
                          later.role === "assistant" &&
                          later.status === "complete" &&
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
                  />
                </Fragment>
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

const isGroupCoordinationPrompt = (message: Message): boolean => {
  const marker = message.parts[0]
  return message.role === "system" && marker?.type === "notice" && marker.code === "group_coordination_prompt"
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
  machine,
  recovered,
  message,
  run,
  routineReply,
  routinePrompt,
  api,
  siblings,
  branchIndex,
  onSwitchBranch,
  onRetry,
  onEdit,
  onCancel,
  editDisabled,
}: {
  inserted: boolean
  vmBotId?: string | undefined
  machine?: MachineState | undefined
  recovered: boolean
  message: Message
  run?: Run | undefined
  routineReply: boolean
  routinePrompt: boolean
  api?: UiApi
  siblings: Array<Message>
  branchIndex: number
  onSwitchBranch: (message: Message, siblings: Array<Message>, index: number) => void
  onRetry: (runId: Id) => Promise<void>
  onEdit?: EditMessage | undefined
  onCancel?: ((runId: Id) => Promise<void>) | undefined
  editDisabled: boolean
}) => {
  const runtimeState = useMessageMascotState(message, run)
  const threadBot = useThreadBot(message.threadId)
  const senderBot = useAvatarBot(message.sender?.id ?? null)
  const parentEvidence = useContext(EvidenceContext)
  const bot = senderBot ?? threadBot
  const evidence = useMemo(
    () =>
      parentEvidence
        ? {
            ...parentEvidence,
            bot: bot ?? parentEvidence.bot,
            onLibrary: (path: string) => parentEvidence.onLibrary?.(path, bot?.id ?? parentEvidence.bot.id),
            onComputer: () => parentEvidence.onComputer?.(bot?.id ?? parentEvidence.bot.id),
          }
        : undefined,
    [parentEvidence, bot],
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
  const finalText = segments.filter((segment) => segment.type === "text").at(-1)
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
  const failure = runErrorFor(message, run, machine?.status === "running")
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
        ? [{ kind: "retry" as const, label: t("Tentar de novo") }]
        : []),
    ].map((action) => (action.kind === "retry" ? { ...action, label: t("Tentar de novo") } : action)),
  }
  const failureContent = runError && (
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
              <p>{t("Revise as ações registradas antes de continuar. Nenhuma ação será repetida automaticamente.")}</p>
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
                          <details>
                            <summary>
                              {t("Ações registradas")} {index + 1}
                            </summary>
                            <pre>{sanitizeDiagnostic(summary)}</pre>
                          </details>
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
                (part) => part.type === "notice" && /^machine_service_(?:unavailable|start_failed):/.test(part.text),
              )) && <MachineServiceButton api={api} botId={vmBotId} />}
          {message.runId && (!vmBotId || machine?.status === "running") && (
            <button
              type="button"
              className="text-button retry-button"
              onClick={() => void onRetry(message.runId ?? "")}
            >
              {t("Tentar de novo")}
            </button>
          )}
        </>
      )}
    </div>
  )
  return (
    <article
      ref={root}
      className={`message-bubble ${message.role === "user" ? "message-user" : "message-assistant"}${routinePrompt ? " message-routine-prompt" : ""}`}
      data-message-id={message.id}
      data-motion-insert={inserted}
    >
      {!routinePrompt && (
        <div className="message-meta">
          {message.role === "assistant" &&
            message.sender &&
            (senderBot ? (
              <BotAvatar bot={senderBot} size={22} state={mascotState} />
            ) : (
              <span role="img" aria-label={t("Membro excluído: {name}", { name: message.sender.name })}>
                <BotAvatar
                  bot={{ id: message.sender.id, color: "#6b7280", avatarShape: "none-none" }}
                  size={22}
                  state="idle"
                  still
                />
              </span>
            ))}
          <span className="message-role">
            {message.role === "user"
              ? t("Você")
              : message.role === "assistant"
                ? (message.sender?.name ?? bot?.name ?? "touri")
                : t(message.role)}
          </span>
          <time dateTime={new Date(message.createdAt).toISOString()}>
            {new Date(message.createdAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
          </time>
          {message.role === "user" && message.delivery && (
            <span className="delivery-state" role="status">
              {deliveryLabels[message.delivery.status]}
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
          if (segment.type === "text")
            return <Fragment key={segment.key}>{renderAnswer(segment.text, segment === finalText)}</Fragment>
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
              state={mascotState}
              run={run}
              api={api}
              bot={bot}
              onCancel={onCancel}
              preparingEnvironment={Boolean(vmBotId)}
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
      {parts.some(screenTool) && (
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
            ›
          </button>
        </fieldset>
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
  composerKey,
  threadCreation,
  onRetryCreateThread,
  onRepeatTask,
  group = null,
  groupMembers = [],
  onEditGroup = () => {},
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
  onOpenModel,
  onSelectProject,
  onAddProject,
  routines = [],
  routineRuns = [],
}: ChatPanelProps) => {
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
  const activeRun = useMemo(
    () =>
      runs.find(
        (run) => thread && run.threadId === thread.id && ["queued", "starting", "running"].includes(run.status),
      ) ?? null,
    [runs, thread],
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
      <section className="chat-panel" inert={chatIsCovered || undefined} aria-hidden={chatIsCovered || undefined}>
        <header className="chat-header" data-tauri-drag-region="deep">
          <span className="chat-header-crumb">{t("Bots")}</span>
          <div className="chat-bot-chip">
            {bot && <BotAvatar bot={bot} size={18} />}
            <h1 className="chat-page-heading">{bot?.name ?? "touri"}</h1>
            {bot?.anyFolderAccess && (
              <span className="any-folder-badge">{t("Any folder on this {host}", { host: getHostLabel(host) })}</span>
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
                ◧
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
  const visibleMessages = [...messagePath, ...pendingMessages]
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
  const awaitingReply =
    activeRun && !visibleMessages.some((message) => message.role === "assistant" && message.runId === activeRun.id)

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

  return (
    <section className="chat-panel" inert={chatIsCovered || undefined} aria-hidden={chatIsCovered || undefined}>
      {group ? (
        <GroupHeader
          group={group}
          bots={groupMembers}
          onEdit={onEditGroup}
          panelOpen={panelOpen}
          onTogglePanel={onTogglePanel}
        />
      ) : (
        <header className="chat-header" data-tauri-drag-region="deep">
          <span className="chat-header-crumb">{t("Bots")}</span>
          <div className="chat-bot-chip">
            {bot ? (
              <BotAvatar bot={bot} size={18} threadId={thread.id} state={activityState} />
            ) : (
              <img src="/touri-bull.png" alt="" />
            )}
            <h1 className="chat-page-heading">{bot?.name ?? "touri"}</h1>
            {bot?.anyFolderAccess && (
              <span className="any-folder-badge">{t("Any folder on this {host}", { host: getHostLabel(host) })}</span>
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
                ◧
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
          machine={machine}
          focusApproval={focusApproval}
          key={composerKey ?? thread.id}
          messages={visibleMessages}
          api={api}
          runs={runs}
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
          header={
            visibleMessages.length === 0 && !activeRun && visibleRuns.length === 0 ? (
              group ? (
                <GroupConversationStart group={group} bots={groupMembers} />
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
            ...(awaitingReply
              ? [
                  {
                    id: `activity-${activeRun.id}`,
                    createdAt: activeRun.queuedAt,
                    content: (
                      <article className="message-bubble message-assistant" data-pending-run={activeRun.id}>
                        <div className="message-meta">
                          <span className="message-role">{bot?.name ?? "touri"}</span>
                        </div>
                        <ActivityMark
                          state={activityState === "waiting-approval" ? activityState : "thinking"}
                          bot={bot ?? undefined}
                          threadId={thread.id}
                          run={activeRun}
                          api={api}
                          onCancel={onCancel}
                          preparingEnvironment={bot?.machine === "vm"}
                        />
                      </article>
                    ),
                  },
                ]
              : []),
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
        draftRef={draftComposerRef}
        notice={{
          bot,
          latestReply,
          machine,
          onOpenPermissions,
          onOpenProviderLogin: group ? undefined : onOpenProviderLogin,
          onRetry,
        }}
        bot={group ? null : bot}
        groupName={group?.name}
        mentionBots={groupMembers}
        threadId={thread.id}
        parentId={thread.activeLeafId}
        api={api}
        inputRef={composerRef}
        attachmentButtonRef={attachmentButtonRef}
        activeRun={activeRun}
        botActive={runs.some((run) => run.botId === bot?.id && ["queued", "starting", "running"].includes(run.status))}
        projects={projects}
        onOpenModel={onOpenModel}
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
            {t("Tentar de novo")}
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
