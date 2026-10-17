import type { Bot, BotGroup, Id, MachineState, Message, Routine, RoutineRun, Run, Thread } from "@touri/contracts"
import { Fragment, type ReactNode, useContext, useId, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { UiApi } from "../api/client"
import type { ApprovalFocus } from "../approvalNavigation"
import { userFacingRunError } from "../errors"
import { ComputerGrantCard } from "../features/computer"
import { InlineLivePreview, InlinePreviewContext, screenTool } from "../features/desktop/InlineLivePreview"
import { localizeNotice, t, threadTitle } from "../i18n"
import { machineStateForDisplay } from "../machineState"
import { messageMarkdown } from "../messageMarkdown"
import { failureTimeLabel, runErrorFor } from "../runError"
import { ActivityMark } from "./ActivityMark"
import { useAvatarBot, useMascotSnapshot, useMessageMascotState, useThreadBot } from "./AvatarRuntime"
import { withApprovalAnswers } from "./activityStatus"
import { BotAvatar } from "./BotAvatar"
import { ChatDisclosure } from "./ChatDisclosure"
import { Composer } from "./Composer"
import { ConnectDataCard, connectDataMarker } from "./ConnectDataCard"
import { ConversationStart } from "./ConversationStart"
import { ErrorDetails, ErrorText } from "./ErrorDetails"
import { EvidenceContext } from "./EvidenceGallery"
import { FailureActionContext } from "./FailureActionContext"
import { GroupConversationStart, GroupHeader } from "./Groups"
import { MachineServiceButton } from "./MachineServiceButton"
import { MachineStatus } from "./MachineStatus"
import { MarkdownContent } from "./MarkdownContent"
import { MessageAttachments } from "./MessageAttachments"
import { useInsertedIds } from "./Motion"
import { mascotSignalFor } from "./mascotState"
import { ToolCallList } from "./ToolCallList"
import { ToolText } from "./ToolOutput"
import { toolStatus } from "./toolPresentation"
import { type EditMessage, UserMessageEdit } from "./UserMessageEdit"

type ChatPanelProps = {
  group?: BotGroup | null
  groupMembers?: Bot[]
  onEditGroup?: () => void
  focusApproval?: ApprovalFocus | undefined
  panelOpen?: boolean
  onTogglePanel?: () => void
  routines?: Array<Routine>
  routineRuns?: Array<RoutineRun>
  onOpenPermissions?: () => void
  onOpenToolCatalog?: () => void
  onOpenProviderLogin?: () => void
  onOpenComputer?: () => void
  thread: Thread | null
  bot: Bot | null
  machine?: MachineState | undefined
  messages: Array<Message>
  runs: Array<Run>
  onSend: (text: string, parentId?: Id | null, attachmentIds?: Array<Id>) => Promise<void>
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
  sent: "Enviada · aguardando confirmação",
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
            "summary, .chat-disclosure-toggle, .disclosure-summary, .message-error-history > button",
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
  api,
  siblings,
  branchIndex,
  onSwitchBranch,
  onRetry,
  onEdit,
  editDisabled,
}: {
  inserted: boolean
  vmBotId?: string | undefined
  machine?: MachineState | undefined
  recovered: boolean
  message: Message
  run?: Run | undefined
  api?: UiApi
  siblings: Array<Message>
  branchIndex: number
  onSwitchBranch: (message: Message, siblings: Array<Message>, index: number) => void
  onRetry: (runId: Id) => Promise<void>
  onEdit?: EditMessage | undefined
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
  const reasoning = message.parts.filter((part) => part.type === "reasoning" && part.text.trim())
  const reasoningId = useId()
  const [reasoningExpanded, setReasoningExpanded] = useState(false)
  const markdown = messageMarkdown(message)
  const text = message.role === "assistant" ? markdown.replace(connectDataMarker, "") : markdown
  const longContent =
    message.role === "assistant" &&
    message.status !== "streaming" &&
    (text.length > 4000 || text.split("\n").length > 40)
  const failure = runErrorFor(message, run, machine?.status === "running")
  const runError =
    vmBotId &&
    (machine?.status === "running" || machine?.status === "starting") &&
    (failure?.code === "TOURI-E8001" || failure?.code === "TOURI-E8002")
      ? null
      : failure
  const [failureExpanded, setFailureExpanded] = useState(false)
  const failedAt = run?.finishedAt ?? message.updatedAt
  const failureTime = failureTimeLabel(failedAt)
  const onFailureAction = useContext(FailureActionContext)
  const failureAction = runError?.action
  const failureContent = runError && (
    <div className="message-error" role="alert">
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
        <button type="button" className="text-button retry-button" onClick={() => void onRetry(message.runId ?? "")}>
          {vmBotId ? "Tentar de novo" : t("Tentar novamente")}
        </button>
      )}
    </div>
  )
  return (
    <article
      ref={root}
      className={`message-bubble ${message.role === "user" ? "message-user" : "message-assistant"}`}
      data-message-id={message.id}
      data-motion-insert={inserted}
    >
      <div className="message-meta">
        {message.role === "assistant" &&
          message.sender &&
          (senderBot ? (
            <BotAvatar bot={senderBot} size={22} state={mascotState} />
          ) : (
            <span role="img" aria-label={t("Membro excluído: {name}", { name: message.sender.name })}>
              <BotAvatar
                bot={{ id: message.sender.id, color: "#6b7280", avatarShape: "cercle" }}
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
      {reasoning.length > 0 && (
        <ChatDisclosure
          key={message.status === "streaming" ? "live" : "saved"}
          id={reasoningId}
          className="chat-reasoning"
          label="Raciocínio"
          expanded={message.status === "streaming" ? reasoningExpanded : undefined}
          onExpandedChange={setReasoningExpanded}
        >
          <MarkdownContent
            content={reasoning.map((part) => (part.type === "reasoning" ? part.text : "")).join("\n\n")}
          />
        </ChatDisclosure>
      )}
      {text &&
        (message.role === "tool" ? (
          <ToolText text={text} />
        ) : longContent ? (
          <ChatDisclosure
            className="chat-long-content"
            label="Mostrar mais"
            expandedLabel="Mostrar menos"
            preview={<MarkdownContent content={text} evidence={evidence} preview />}
          >
            <MarkdownContent content={text} evidence={evidence} />
          </ChatDisclosure>
        ) : (
          <MarkdownContent
            content={message.role === "system" ? localizeNotice(text) : text}
            evidence={message.role === "assistant" ? evidence : undefined}
          />
        ))}
      <MessageAttachments parts={parts.filter((part) => part.type === "image" || part.type === "file")} api={api} />
      {message.role === "user" && onEdit && (
        <UserMessageEdit
          message={message}
          onEdit={onEdit}
          disabled={editDisabled || message.delivery?.status === "queued" || message.delivery?.status === "sent"}
        />
      )}
      <ToolCallList
        parts={parts}
        api={api}
        finished={message.status !== "streaming"}
        createdAt={message.createdAt}
        onResolved={(approvalId, decision) => setAnswers((current) => ({ ...current, [approvalId]: decision }))}
      />
      {message.role === "assistant" && message.status === "streaming" && (
        <ActivityMark
          state={mascotState}
          bot={bot}
          threadId={message.threadId}
          parts={parts}
          reasoningId={reasoningId}
          reasoningExpanded={reasoningExpanded}
          onExpandReasoning={() => setReasoningExpanded(true)}
          onFocusApproval={(approvalId) => {
            const card = Array.from(root.current?.querySelectorAll<HTMLElement>("[data-approval-id]") ?? []).find(
              (element) => element.dataset.approvalId === approvalId,
            )
            card?.scrollIntoView?.({ block: "center", behavior: "instant" })
            card?.focus({ preventScroll: true })
          }}
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
      {runError && recovered ? (
        <div className="message-error-history">
          <button
            type="button"
            className="text-button"
            aria-expanded={failureExpanded}
            onClick={() => setFailureExpanded((expanded) => !expanded)}
          >
            {runError.title} · {failureTime} · {t("A reply followed this error")} ·{" "}
            {failureExpanded ? t("Hide error") : t("View error")}
          </button>
          {failureExpanded && failureContent}
        </div>
      ) : (
        failureContent
      )}
    </article>
  )
}

export const ChatPanel = ({
  group = null,
  groupMembers = [],
  onEditGroup = () => {},
  focusApproval,
  thread,
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
  onOpenToolCatalog,
  onOpenProviderLogin,
  onOpenComputer,
  routines = [],
  routineRuns = [],
}: ChatPanelProps) => {
  const machine = machineStateForDisplay(rawMachine)
  const [draft, setDraft] = useState("")
  const mascotSnapshot = useMascotSnapshot({ id: bot?.id ?? "", color: bot?.color ?? null }, thread?.id)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const attachmentButtonRef = useRef<HTMLButtonElement>(null)
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
          (run.trigger === "routine" || run.routineRunId !== null) &&
          !(serviceRecovered && /^machine_service_(?:unavailable|start_failed)$/.test(run.errorClass ?? "")),
      ),
    [runs, thread?.id, serviceRecovered],
  )

  // A draft belongs to one conversation, including when navigating while an upload is pending.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the conversation changes
  useLayoutEffect(() => {
    setDraft("")
  }, [thread?.id])

  if (!thread)
    return (
      <section className="chat-panel">
        <header className="chat-header" data-tauri-drag-region>
          <span className="chat-header-crumb">Bots / {bot?.name ?? "touri"}</span>
          <div className="chat-bot-chip">
            {bot && <BotAvatar bot={bot} size={18} />}
            <h1 className="chat-page-heading">{bot?.name ?? "touri"}</h1>
            {bot?.anyFolderAccess && <span className="any-folder-badge">{t("Qualquer pasta do Mac")}</span>}
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

  const visibleMessages = group
    ? messages.filter((message) => message.threadId === thread.id)
    : activeMessagePath(
        messages.filter((message) => message.threadId === thread.id),
        thread.activeLeafId,
      )
  for (const message of messages) {
    if (
      message.threadId === thread.id &&
      ((message.delivery && message.delivery.status !== "acked") ||
        message.parts.some((part) => part.type === "approval" && part.decision === "pending")) &&
      !visibleMessages.some((visible) => visible.id === message.id)
    )
      visibleMessages.push(message)
  }
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
    <section className="chat-panel">
      {group ? (
        <GroupHeader
          group={group}
          bots={groupMembers}
          onEdit={onEditGroup}
          panelOpen={panelOpen}
          onTogglePanel={onTogglePanel}
        />
      ) : (
        <header className="chat-header" data-tauri-drag-region>
          <span className="chat-header-crumb">Bots / {bot?.name ?? "touri"}</span>
          <div className="chat-bot-chip">
            {bot ? (
              <BotAvatar bot={bot} size={18} threadId={thread.id} state={activityState} />
            ) : (
              <img src="/touri-bull.png" alt="" />
            )}
            <h1 className="chat-page-heading">{bot?.name ?? "touri"}</h1>
            {bot?.anyFolderAccess && <span className="any-folder-badge">{t("Qualquer pasta do Mac")}</span>}
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
          key={thread.id}
          messages={visibleMessages}
          api={api}
          runs={runs}
          allMessages={messages}
          onSwitchBranch={(_message, siblings, index) => {
            const next = siblings[index]
            if (next) void onSwitchBranch(thread.id, next.id)
          }}
          onRetry={onRetry}
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
                    setDraft(prompt)
                    composerRef.current?.focus()
                  }}
                />
              )
            ) : null
          }
          timelineCards={[
            ...(connectDataReply && onOpenToolCatalog
              ? [
                  {
                    id: `connect-data-${connectDataReply.id}`,
                    createdAt: connectDataReply.createdAt + 1,
                    content: (
                      <ConnectDataCard
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
                        <ActivityMark state={activityState} bot={bot ?? undefined} threadId={thread.id} />
                      </article>
                    ),
                  },
                ]
              : []),
            ...visibleRuns.map((run) => ({
              id: `card-${run.id}`,
              createdAt: run.queuedAt,
              content: (
                <RunCard
                  bot={bot}
                  run={run}
                  thread={thread}
                  onRetry={onRetry}
                  routineName={
                    routines.find(
                      (routine) => routine.id === routineRuns.find((item) => item.id === run.routineRunId)?.routineId,
                    )?.name
                  }
                  waitingApproval={messages.some(
                    (message) =>
                      message.runId === run.id &&
                      message.parts.some((part) => part.type === "approval" && part.decision === "pending"),
                  )}
                />
              ),
            })),
          ]}
        />
      </InlinePreviewContext.Provider>
      {/* r8 composer: notices and the input island stay isolated from transcript activity. */}
      <Composer
        key={`composer-${thread.id}`}
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
        draft={draft}
        onDraft={setDraft}
        inputRef={composerRef}
        attachmentButtonRef={attachmentButtonRef}
        activeRun={activeRun}
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
  waitingApproval,
}: {
  waitingApproval: boolean
  routineName?: string | undefined
  bot: Bot | null
  run: Run
  thread: Thread
  onRetry: (runId: Id) => Promise<void>
}) => {
  const failed = ["failed", "interrupted"].includes(run.status)
  const running = ["queued", "starting", "running"].includes(run.status)
  const status = running
    ? waitingApproval
      ? t("Waiting for approval")
      : t("Em execução")
    : run.status === "canceled"
      ? t("Cancelado por você")
      : failed
        ? t("Falhou")
        : t("Concluído")
  const summary =
    run.status === "canceled"
      ? t("Cancelado por você")
      : failed
        ? userFacingRunError(run)
        : running
          ? waitingApproval
            ? t("Review the approval card to continue the routine.")
            : t("A rotina está trabalhando em segundo plano.")
          : t("A rotina terminou e deixou o resultado nesta conversa.")
  return (
    <article className={`run-card ${failed ? "run-failed" : ""}`}>
      <div className="run-card-heading">
        <div>
          {bot && <BotAvatar bot={bot} size={28} />}
          <strong>{routineName ?? threadTitle(thread.title, thread.createdAt)}</strong>
          <span
            className={`run-status ${running ? (waitingApproval ? "status-waiting-approval" : "status-running") : failed ? "status-failed" : run.status === "canceled" ? "status-canceled" : "status-complete"}`}
          >
            {status}
          </span>
          {running && !waitingApproval && (
            <span className="tb-typing" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          )}
        </div>
        {failed && (
          <button type="button" className="open-run-link" onClick={() => void onRetry(run.id)}>
            {t("Tentar novamente")}
          </button>
        )}
      </div>
      <time>
        {new Date(run.finishedAt ?? run.startedAt ?? run.queuedAt).toLocaleDateString("pt-BR", {
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        })}
      </time>
      <div className="run-card-summary">
        <ErrorText text={summary} />
      </div>
    </article>
  )
}
