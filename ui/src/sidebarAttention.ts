import type { Message, NotificationRecord, Run } from "@touri/contracts"
import { isResolvedNotification, reconcileApprovalNotifications } from "./approvalState"

const ATTENTION_KINDS: ReadonlyArray<NotificationRecord["kind"]> = [
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
export const isAttention = (item: NotificationRecord): boolean => ATTENTION_KINDS.includes(item.kind)
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

export const relativeThreadDate = (timestamp: number, now = Date.now()): string => {
  const date = new Date(timestamp)
  const today = new Date(now)
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return "hoje"
  if (date.toDateString() === yesterday.toDateString()) return "ontem"
  return date.toLocaleDateString("pt-BR", {
    day: "numeric",
    month: "short",
    ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}),
  })
}
