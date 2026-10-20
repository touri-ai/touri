import {
  getNotificationBody,
  type Message,
  type NotificationRecord,
  type RespondBehavior,
  type Run,
} from "@touri/contracts"
import { isTeamCreateApprovalNotice } from "@touri/contracts/approval-summary"
import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { type ApprovalTarget, pendingApprovalTargets } from "../approvalNavigation"
import { approvalNotificationSummary } from "../approvalNotice"
import {
  isResolvedNotification,
  reconcileApprovalMessages,
  reconcileApprovalNotifications,
  resolvedApprovalLabel,
  uniqueApprovalNotifications,
} from "../approvalState"
import type { RecoveryAction } from "../errorRecovery"
import { dictionaries, localizeNotice, type TranslationKey, t } from "../i18n"
import { markdownSummary } from "../markdownSummary"
// r8-sidebar: shared attention projection; resolved and superseded failures stay in history.
import { isFailureNotice, pendingNotifications } from "../sidebarAttention"
import { scopedStorageKey } from "../storageScope"
import { useAvatarBot } from "./AvatarRuntime"
import { BotAvatar } from "./BotAvatar"
import { ErrorNotice } from "./ErrorNotice"
import { MotionPresence, useInsertedIds } from "./Motion"
import "./screens.css"

export { countAttention, isAttention } from "../sidebarAttention"

const RECENT_LIMIT = 16
const CLEARED_KEY = "touri.notifications.cleared.v1"
const notificationKey = (item: NotificationRecord): string => `${item.id}:${item.createdAt}`
const readCleared = (key: string): Set<string> => {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "[]")
    return new Set(Array.isArray(saved) ? saved.filter((item): item is string => typeof item === "string") : [])
  } catch {
    return new Set()
  }
}

const KIND_KEY: Record<NotificationRecord["kind"], TranslationKey> = {
  approval: "Approval",
  question: "Question",
  takeover: "Needs you",
  "routine-deferred": "Routine skipped",
  "routine-failed": "Routine failed",
  "turn-failed": "Turn failed",
  incident: "Incident",
  done: "Done",
  notice: "Aviso do bot",
  "delegation-settled": "Delegation",
}

// Only a real question from the bot gets a reply box; a finished turn that ends in "?" is a reply.
const hasReplyBox = (item: NotificationRecord): boolean => item.kind === "question"

const getNotificationBellLabel = (count: number): string => {
  if (count > 9) return t("Notifications over nine need attention")
  if (count > 0) return t("Notifications need attention", { count })

  return t("Notifications")
}

const age = (createdAt: number, now: number): string => {
  const minutes = Math.max(0, Math.round((now - createdAt) / 60_000))
  if (minutes < 1) return t("now")
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

export type NotificationActions = {
  open: (item: NotificationRecord) => void
  openRecovery?: () => void
  dismiss: (id: number) => Promise<void>
  dismissAll: () => Promise<{ skipped: number; skippedIds?: Array<number> } | undefined>
  respond: (args: { notification: NotificationRecord; behavior: RespondBehavior; message?: string }) => Promise<void>
  reply: (args: { notification: NotificationRecord; text: string }) => Promise<void>
  recover?: (item: NotificationRecord, action: RecoveryAction) => Promise<void>
}

const NotificationRow = ({
  item,
  now,
  actions,
  inserted,
  messages,
  runs,
  onReviewApproval,
}: {
  item: NotificationRecord
  now: number
  actions: NotificationActions
  inserted: boolean
  messages: Message[]
  runs: Run[]
  onReviewApproval?: ((target: ApprovalTarget) => void) | undefined
}) => {
  const bot = useAvatarBot(item.botId)
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const resolved = isResolvedNotification(item)
  const teamProposal = isTeamCreateApprovalNotice(item)
  const approval = item.kind === "approval" ? approvalNotificationSummary(item, messages) : null
  const title =
    resolved && item.kind === "approval"
      ? item.resolution === "dismissed"
        ? "Solicitação dispensada"
        : resolvedApprovalLabel(
            item.resolution === "allow"
              ? "approved"
              : item.resolution === "expired" || item.resolution === "canceled"
                ? "expired"
                : "denied",
          )
      : (approval?.title ?? markdownSummary(localizeNotice(item.title)))
  const body = approval?.body ?? markdownSummary(localizeNotice(getNotificationBody(item)))
  const failed = item.kind === "turn-failed" || item.kind === "routine-failed" || item.kind === "incident"
  const failedRun = runs
    .filter(
      (run) =>
        run.threadId === item.threadId &&
        (run.status === "failed" || run.status === "interrupted") &&
        (run.finishedAt ?? 0) <= item.createdAt + 1000,
    )
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0]
  const failedMessage = messages.find((message) => message.id === failedRun?.replyMessageId)
  const run = async (task: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await task()
    } catch (error) {
      setError(error)
    } finally {
      setBusy(false)
    }
  }
  const submitReply = (): Promise<void> => {
    if (item.kind === "question" && item.requestId)
      return actions.respond({ notification: item, behavior: "answer", message: text })
    return actions.reply({ notification: item, text })
  }
  return (
    <li
      className={`notification-row ${resolved ? "resolved" : ""} ${inserted ? "motion-insert" : ""}`}
      data-notification-id={item.id}
      data-kind={item.kind}
      data-testid="notification-row"
      data-avatar-hover
      tabIndex={-1}
    >
      <BotAvatar
        bot={
          bot ?? {
            id: item.botId ?? "touri",
            color: item.botColor,
            avatarShape: item.avatarShape,
            avatarSeed: item.avatarSeed ?? null,
            name: item.botName ?? "touri",
          }
        }
        size={32}
      />
      <div className="notification-main">
        <div className="notification-head">
          <strong>{item.botName ?? "touri"}</strong>
          <span className={`notification-kind kind-${item.level}`}>{t(KIND_KEY[item.kind])}</span>
          {resolved && isFailureNotice(item) && <span>{t("Interrupção anterior · resolvida")}</span>}
          <time
            dateTime={new Date(item.createdAt).toISOString()}
            title={new Date(item.createdAt).toLocaleString("pt-BR")}
          >
            {age(item.createdAt, now)}
          </time>
        </div>
        {!failed &&
          ![t(KIND_KEY[item.kind]), dictionaries.en[KIND_KEY[item.kind]], item.kind].some(
            (label) => label.toLowerCase() === title.toLowerCase(),
          ) && <p className="notification-title">{title}</p>}
        {item.resolvedAt !== null && item.kind === "approval" && (
          <time dateTime={new Date(item.resolvedAt).toISOString()}>
            {new Date(item.resolvedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
          </time>
        )}
        {failed ? (
          <ErrorNotice
            error={failedRun?.errorMessage ?? item.body}
            showActions={!resolved}
            context={{
              provider: failedRun?.provider,
              errorClass: failedRun?.errorClass,
              parts: failedMessage?.parts,
              savedMessage: !!failedRun?.requestMessageId,
              occurredAt: failedRun?.finishedAt ?? item.createdAt,
            }}
            onAction={(action) => (actions.recover ? actions.recover(item, action) : actions.open(item))}
          />
        ) : (
          body.toLowerCase() !== t(KIND_KEY[item.kind]).toLowerCase() && <p className="notification-body">{body}</p>
        )}
        {approval?.command && <pre className="notification-command">{approval.command}</pre>}
        {approval?.technical && (
          <details className="notification-technical">
            <summary>{t("Detalhes técnicos")}</summary>
            <pre>{approval.technical}</pre>
          </details>
        )}
        {!resolved && item.kind === "approval" && item.requestId && !teamProposal && (
          <div className="notification-buttons">
            <button
              type="button"
              disabled={busy}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.preventDefault()
              }}
              onClick={() => void run(() => actions.respond({ notification: item, behavior: "allow" }))}
            >
              Aprovar
            </button>
            <button
              type="button"
              disabled={busy}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.preventDefault()
              }}
              onClick={() => void run(() => actions.respond({ notification: item, behavior: "deny" }))}
            >
              Negar
            </button>
          </div>
        )}
        {!resolved && hasReplyBox(item) && (
          <form
            className="notification-reply"
            onSubmit={(event) => {
              event.preventDefault()
              if (!text.trim()) return
              void run(async () => {
                await submitReply()
                setText("")
              })
            }}
          >
            <input
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={t("Reply")}
              aria-label={t("Reply")}
            />
            <button type="submit" disabled={busy || !text.trim()}>
              {t("Send")}
            </button>
          </form>
        )}
        <div className="notification-links">
          {item.threadId && (
            <button
              type="button"
              onClick={() => {
                if (teamProposal && item.requestId && item.threadId && onReviewApproval) {
                  onReviewApproval({ threadId: item.threadId, approvalId: item.requestId })
                  return
                }
                actions.open(item)
              }}
            >
              {t(teamProposal ? "Review pending approval" : item.kind === "approval" ? "Revisar" : "Open")}
            </button>
          )}
          {!resolved && (
            <button type="button" disabled={busy} onClick={() => void run(() => actions.dismiss(item.id))}>
              Marcar como lida
            </button>
          )}
        </div>
        {error !== null && (
          <div role="alert">
            <ErrorNotice error={error} />
          </div>
        )}
      </div>
    </li>
  )
}

export const NotificationBell = ({
  notifications,
  messages = [],
  runs = [],
  actions,
  now = Date.now(),
  focusNotification = null,
  onOpenChange,
  onReviewApproval,
}: {
  notifications: Array<NotificationRecord>
  messages?: Array<Message>
  runs?: Array<Run>
  actions: NotificationActions
  now?: number
  focusNotification?: { id: number; request: number } | null
  onOpenChange?: (open: boolean) => void
  onReviewApproval?: ((target: ApprovalTarget) => void) | undefined
}) => {
  const [open, setOpen] = useState(false)
  const inserted = useInsertedIds(notifications.map((item) => String(item.id)))
  // Native mode changes restart the workspace. Retain this destination for late dismiss responses.
  const [clearedStorageKey] = useState(() => scopedStorageKey(CLEARED_KEY))
  const [clearedIds, setClearedIds] = useState(() => readCleared(clearedStorageKey))
  const [clearing, setClearing] = useState(false)
  const [clearError, setClearError] = useState(false)
  const [skippedCount, setSkippedCount] = useState(0)
  useEffect(() => {
    onOpenChange?.(open)
    return () => onOpenChange?.(false)
  }, [open, onOpenChange])
  useEffect(() => {
    if (focusNotification) setOpen(true)
  }, [focusNotification])
  const navigationActions = {
    ...actions,
    recover: async (item: NotificationRecord, action: RecoveryAction) => {
      setOpen(false)
      if (actions.recover) await actions.recover(item, action)
      else actions.open(item)
    },
    open: (item: NotificationRecord) => {
      setOpen(false)
      actions.open(item)
    },
  }
  const container = useRef<HTMLDivElement | null>(null)
  const popover = useRef<HTMLElement | null>(null)
  const [position, setPosition] = useState({ left: 12, bottom: 52 })
  const visible = uniqueApprovalNotifications(reconcileApprovalNotifications(notifications, messages)).filter(
    (item) => !clearedIds.has(notificationKey(item)),
  )
  const pending = pendingNotifications(visible, messages)
  const missingApprovals = pendingApprovalTargets(reconcileApprovalMessages(messages, notifications)).filter(
    (target) =>
      !pending.some(
        (item) => item.kind === "approval" && item.threadId === target.threadId && item.requestId === target.approvalId,
      ),
  )
  const attentionCount = pending.length + missingApprovals.length
  const recent = visible
    .filter((item) => !pending.includes(item))
    .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)
    .slice(0, RECENT_LIMIT)
  const ordered = [...pending, ...recent].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)
  const today = new Date(now).toDateString()
  const groups = [
    { title: "Hoje", items: ordered.filter((item) => new Date(item.createdAt).toDateString() === today) },
    { title: "Anteriores", items: ordered.filter((item) => new Date(item.createdAt).toDateString() !== today) },
  ]
  const clear = async () => {
    if (clearing) return
    setClearing(true)
    setClearError(false)
    try {
      const result = await actions.dismissAll()
      setSkippedCount(result?.skipped ?? 0)
      if (result?.skipped && !result.skippedIds) return

      const protectedIds = new Set(result?.skippedIds ?? [])
      const ids = visible.filter((item) => !protectedIds.has(item.id)).map(notificationKey)
      const protectedKeys = new Set(notifications.filter((item) => protectedIds.has(item.id)).map(notificationKey))
      const next = new Set([...clearedIds, ...ids].filter((key) => !protectedKeys.has(key)).slice(-1000))
      setClearedIds(next)
      try {
        localStorage.setItem(clearedStorageKey, JSON.stringify([...next]))
      } catch {
        /* Keep clearing usable when storage is unavailable. */
      }
    } catch {
      setClearError(true)
    } finally {
      setClearing(false)
    }
  }
  useEffect(() => {
    if (!open) return
    const reposition = () => {
      const rect = container.current?.getBoundingClientRect()
      if (rect)
        setPosition({
          left: Math.max(12, Math.min(rect.left, window.innerWidth - 432)),
          bottom: Math.max(12, window.innerHeight - rect.top + 8),
        })
    }
    reposition()
    const close = (event: MouseEvent): void => {
      if (
        container.current &&
        !container.current.contains(event.target as Node) &&
        !popover.current?.contains(event.target as Node)
      )
        setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false)
    }
    window.addEventListener("mousedown", close)
    window.addEventListener("keydown", closeOnEscape)
    window.addEventListener("resize", reposition)
    return () => {
      window.removeEventListener("mousedown", close)
      window.removeEventListener("keydown", closeOnEscape)
      window.removeEventListener("resize", reposition)
    }
  }, [open])
  useEffect(() => {
    if (!open || !focusNotification) return
    const row = document.querySelector<HTMLElement>(`[data-notification-id="${focusNotification.id}"]`)
    row?.scrollIntoView?.({ block: "center", behavior: "instant" })
    row?.focus({ preventScroll: true })
  }, [focusNotification, open])
  return (
    <div className="notification-center" ref={container}>
      <button
        type="button"
        className="settings-button notification-bell"
        aria-label={getNotificationBellLabel(attentionCount)}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 9a6 6 0 1 1 12 0c0 6 2 7 2 7H4s2-1 2-7" />
          <path d="M10 20a2 2 0 0 0 4 0" />
        </svg>
        {attentionCount > 0 && <span className="notification-badge">{attentionCount > 9 ? "9+" : attentionCount}</span>}
      </button>
      {/* r8 motion: retain only the inert popover during its exit. */}
      {createPortal(
        <MotionPresence show={open} kind="popover">
          <section
            ref={popover}
            style={position}
            className="notification-popover r8-notifications"
            aria-label={t("Notification center")}
          >
            <header>
              <strong>{t("Notifications")}</strong>
              <div className="notification-header-actions">
                {ordered.length > 0 && (
                  <button type="button" disabled={clearing} onClick={() => void clear()}>
                    {clearing ? "Limpando…" : "Limpar"}
                  </button>
                )}
                <button type="button" aria-label="Fechar notificações" onClick={() => setOpen(false)}>
                  ×
                </button>
              </div>
            </header>
            {actions.openRecovery && (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setOpen(false)
                  actions.openRecovery?.()
                }}
              >
                {t("Interrupted tasks")}
              </button>
            )}
            {skippedCount > 0 && (
              <p role="status">
                {t("Notificações que precisam de revisão em Tarefas interrompidas: {count}.", {
                  count: skippedCount,
                })}
              </p>
            )}
            {clearError && (
              <p className="screen-inline-error" role="alert">
                Não foi possível limpar as notificações. Tente novamente.
              </p>
            )}
            {ordered.length === 0 && missingApprovals.length === 0 && (
              <p className="notification-empty">{t("Nothing needs you right now.")}</p>
            )}
            {missingApprovals.map((target) => (
              <button
                key={target.approvalId}
                type="button"
                className="text-button"
                onClick={() => {
                  setOpen(false)
                  onReviewApproval?.(target)
                }}
              >
                {t("Review pending approval")}
              </button>
            ))}
            {groups
              .filter((group) => group.items.length > 0)
              .map((group) => (
                <div className="notification-group" key={group.title}>
                  <h2>{group.title}</h2>
                  <ul>
                    {group.items.map((item) => (
                      <NotificationRow
                        key={item.id}
                        item={item}
                        now={now}
                        actions={navigationActions}
                        inserted={inserted.has(String(item.id))}
                        messages={messages}
                        runs={runs}
                        onReviewApproval={
                          onReviewApproval
                            ? (target) => {
                                setOpen(false)
                                onReviewApproval(target)
                              }
                            : undefined
                        }
                      />
                    ))}
                  </ul>
                </div>
              ))}
          </section>
        </MotionPresence>,
        container.current?.closest("dialog") ?? document.body,
      )}
    </div>
  )
}
