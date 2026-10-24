import type { Message, NotificationRecord, Run, Thread } from "@touri/contracts"
import { isResolvedNotification, reconcileApprovalNotifications } from "./approvalState"

const ATTENTION_KINDS: ReadonlyArray<NotificationRecord["kind"]> = [
  "mention",
  "approval",
  "question",
  "takeover",
  "routine-deferred",
  "routine-failed",
  "turn-failed",
  "incident",
]
const FAILURE_KINDS: ReadonlyArray<NotificationRecord["kind"]> = ["routine-deferred", "routine-failed", "turn-failed"]

/** Notices that inform without asking for anything: they never put a bot under "needs you". */
export const isInformationalNotice = (item: NotificationRecord): boolean => item.kind === "routine-deferred"
// The channel notice route persists this marker; titles and message text are not review state.
export const isReadyReviewNotice = (item: NotificationRecord): boolean =>
  item.kind === "notice" && Boolean(item.threadId) && item.requestId?.startsWith("pr-ready:") === true
export const isAttention = (item: NotificationRecord): boolean =>
  ATTENTION_KINDS.includes(item.kind) || isReadyReviewNotice(item)
export const isFailureNotice = (item: NotificationRecord): boolean => FAILURE_KINDS.includes(item.kind)

/** A new run handles the previous failure, even before its resolution arrives over the event stream. */
export const reconcileFailureNotifications = (
  items: ReadonlyArray<NotificationRecord>,
  runs: ReadonlyArray<Run>,
): Array<NotificationRecord> =>
  items.map((item) => {
    if (isResolvedNotification(item) || !isFailureNotice(item) || item.threadId === null) return item
    if (item.requestId?.startsWith("recovery:")) return item
    const later = runs.find(
      (run) =>
        run.botId === item.botId &&
        run.threadId === item.threadId &&
        (run.status === "succeeded"
          ? (run.finishedAt ?? run.startedAt ?? run.queuedAt)
          : (run.startedAt ?? run.queuedAt)) > item.createdAt,
    )
    const completed = items.find(
      (next) =>
        next.kind === "done" &&
        next.botId === item.botId &&
        next.threadId === item.threadId &&
        next.createdAt > item.createdAt,
    )
    const resolvedAt = later
      ? later.status === "succeeded"
        ? (later.finishedAt ?? later.startedAt ?? later.queuedAt)
        : (later.startedAt ?? later.queuedAt)
      : completed?.createdAt
    return resolvedAt ? { ...item, resolvedAt, resolution: "expired" } : item
  })

/** A later run or completion in the same conversation makes a failure historical. */
export const pendingNotifications = (
  items: ReadonlyArray<NotificationRecord>,
  messages: ReadonlyArray<Message> = [],
  runs: ReadonlyArray<Run> = [],
): Array<NotificationRecord> =>
  reconcileFailureNotifications(reconcileApprovalNotifications([...items], [...messages]), runs)
    .filter((item) => {
      if (isResolvedNotification(item) || !isAttention(item)) return false
      if (!isFailureNotice(item) || item.requestId?.startsWith("recovery:")) return true
      const completedLater = items.some(
        (next) =>
          next.kind === "done" &&
          next.botId === item.botId &&
          next.threadId === item.threadId &&
          next.createdAt > item.createdAt,
      )
      const replyLater =
        item.kind === "turn-failed" &&
        item.threadId !== null &&
        messages.some(
          (message) =>
            message.threadId === item.threadId &&
            message.role === "assistant" &&
            message.status === "complete" &&
            message.updatedAt > item.createdAt,
        )
      return !completedLater && !replyLater
    })
    .sort((left, right) => right.createdAt - left.createdAt || right.id - left.id)

export const countAttention = (items: Array<NotificationRecord>): number => pendingNotifications(items).length

// Built once: every sidebar row formats its time on each workspace update.
const sidebarClock = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" })
const sidebarDate = new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "short" })
const sidebarDateWithYear = new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "short", year: "numeric" })

/** Sidebar row time: the clock for today, then "ontem" or a short date. */
export const getSidebarRowTime = (timestamp: number, now = Date.now()): string => {
  if (!timestamp) return ""

  const date = new Date(timestamp)
  if (date.toDateString() !== new Date(now).toDateString()) return relativeThreadDate(timestamp, now)

  return sidebarClock.format(date)
}

/** The newest update among a bot's or channel's conversations; 0 when there is none. */
export const getLastActivityAt = (threads: ReadonlyArray<Thread>): number =>
  threads.reduce((latest, thread) => Math.max(latest, thread.updatedAt), 0)

export const relativeThreadDate = (timestamp: number, now = Date.now()): string => {
  const date = new Date(timestamp)
  // A shared formatter throws on an invalid date where toLocaleDateString returned text.
  if (Number.isNaN(date.getTime())) return ""
  const today = new Date(now)
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return "hoje"
  if (date.toDateString() === yesterday.toDateString()) return "ontem"
  return (date.getFullYear() !== today.getFullYear() ? sidebarDateWithYear : sidebarDate).format(date)
}
