import type { Message, NotificationRecord, RespondBehavior } from "@touri/contracts"
import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { type ApprovalTarget, pendingApprovalTargets } from "../approvalNavigation"
import { approvalNotificationSummary } from "../approvalNotice"
import {
  isResolvedNotification,
  reconcileApprovalMessages,
  reconcileApprovalNotifications,
  resolvedApprovalLabel,
} from "../approvalState"
import { userFacingError } from "../errors"
import { dictionaries, localizeNotice, type TranslationKey, t } from "../i18n"
import { markdownSummary } from "../markdownSummary"
// r8-sidebar: shared attention projection; resolved and superseded failures stay in history.
import { pendingNotifications } from "../sidebarAttention"
import { useAvatarBot } from "./AvatarRuntime"
import { BotAvatar } from "./BotAvatar"
import { MotionPresence, useInsertedIds } from "./Motion"
import "./screens.css"

export { countAttention, isAttention } from "../sidebarAttention"

const RECENT_LIMIT = 16
const CLEARED_KEY = "touri.notifications.cleared.v1"
const notificationKey = (item: NotificationRecord): string => `${item.id}:${item.createdAt}`
const readCleared = (): Set<string> => {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(CLEARED_KEY) ?? "[]")
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
  "delegation-settled": "Delegation",
}

// Only a real question from the bot gets a reply box; a finished turn that ends in "?" is a reply.
const hasReplyBox = (item: NotificationRecord): boolean => item.kind === "question"

const age = (createdAt: number, now: number): string => {
  const minutes = Math.max(0, Math.round((now - createdAt) / 60_000))
  if (minutes < 1) return t("now")
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

export type NotificationActions = {
  open: (item: NotificationRecord) => void
  dismiss: (id: number) => Promise<void>
  dismissAll: () => Promise<void>
  respond: (args: { notification: NotificationRecord; behavior: RespondBehavior; message?: string }) => Promise<void>
  reply: (args: { notification: NotificationRecord; text: string }) => Promise<void>
}

const NotificationRow = ({
  item,
  now,
  actions,
  inserted,
  messages,
}: {
  item: NotificationRecord
  now: number
  actions: NotificationActions
  inserted: boolean
  messages: Message[]
}) => {
  const bot = useAvatarBot(item.botId)
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const resolved = isResolvedNotification(item)
  const approval = item.kind === "approval" ? approvalNotificationSummary(item, messages) : null
  const title =
    resolved && item.kind === "approval"
      ? item.resolution === "dismissed"
        ? "Solicitação dispensada"
        : resolvedApprovalLabel(
            item.resolution === "allow" ? "approved" : item.resolution === "expired" ? "expired" : "denied",
          )
      : (approval?.title ?? markdownSummary(localizeNotice(item.title)))
  const body = approval?.body ?? markdownSummary(localizeNotice(item.body))
  const run = async (task: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await task()
    } catch (error) {
      setError(userFacingError(error))
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
      data-kind={item.kind}
      data-testid="notification-row"
      data-avatar-hover
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
          <time
            dateTime={new Date(item.createdAt).toISOString()}
            title={new Date(item.createdAt).toLocaleString("pt-BR")}
          >
            {age(item.createdAt, now)}
          </time>
        </div>
        {![t(KIND_KEY[item.kind]), dictionaries.en[KIND_KEY[item.kind]], item.kind].some(
          (label) => label.toLowerCase() === title.toLowerCase(),
        ) && <p className="notification-title">{title}</p>}
        {item.resolvedAt !== null && item.kind === "approval" && (
          <time dateTime={new Date(item.resolvedAt).toISOString()}>
            {new Date(item.resolvedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
          </time>
        )}
        {body.toLowerCase() !== t(KIND_KEY[item.kind]).toLowerCase() && <p className="notification-body">{body}</p>}
        {approval?.command && <pre className="notification-command">{approval.command}</pre>}
        {approval?.technical && (
          <details className="notification-technical">
            <summary>{t("Detalhes técnicos")}</summary>
            <pre>{approval.technical}</pre>
          </details>
        )}
        {!resolved && item.kind === "approval" && item.requestId && (
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
            <button type="button" onClick={() => actions.open(item)}>
              {t(item.kind === "approval" ? "Revisar" : "Open")}
            </button>
          )}
          {!resolved && (
            <button type="button" disabled={busy} onClick={() => void run(() => actions.dismiss(item.id))}>
              Marcar como lida
            </button>
          )}
        </div>
        {error && <p role="alert">{error}</p>}
      </div>
    </li>
  )
}

export const NotificationBell = ({
  notifications,
  messages = [],
  actions,
  now = Date.now(),
  onOpenChange,
  onReviewApproval,
}: {
  notifications: Array<NotificationRecord>
  messages?: Array<Message>
  actions: NotificationActions
  now?: number
  onOpenChange?: (open: boolean) => void
  onReviewApproval?: ((target: ApprovalTarget) => void) | undefined
}) => {
  const [open, setOpen] = useState(false)
  const inserted = useInsertedIds(notifications.map((item) => String(item.id)))
  const [clearedIds, setClearedIds] = useState(readCleared)
  const [clearing, setClearing] = useState(false)
  const [clearError, setClearError] = useState(false)
  useEffect(() => {
    onOpenChange?.(open)
    return () => onOpenChange?.(false)
  }, [open, onOpenChange])
  const navigationActions = {
    ...actions,
    open: (item: NotificationRecord) => {
      setOpen(false)
      actions.open(item)
    },
  }
  const container = useRef<HTMLDivElement | null>(null)
  const popover = useRef<HTMLElement | null>(null)
  const [position, setPosition] = useState({ left: 12, bottom: 52 })
  const visible = reconcileApprovalNotifications(notifications, messages).filter(
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
    const ids = visible.map(notificationKey)
    setClearing(true)
    setClearError(false)
    try {
      await actions.dismissAll()
      const next = new Set([...clearedIds, ...ids].slice(-1000))
      setClearedIds(next)
      try {
        localStorage.setItem(CLEARED_KEY, JSON.stringify([...next]))
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
  return (
    <div className="notification-center" ref={container}>
      <button
        type="button"
        className="settings-button notification-bell"
        aria-label={attentionCount ? t("Notifications need attention", { count: attentionCount }) : t("Notifications")}
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
