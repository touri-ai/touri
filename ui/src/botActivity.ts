import type { Bot, Id, Message, NotificationRecord, Run, Thread } from "@touri/contracts"
import { pendingApprovalTargets } from "./approvalNavigation"
import { t } from "./i18n"
import { isFailureNotice, isInformationalNotice } from "./sidebarAttention"

/** Sidebar priority: 1) needs you, 2) working now, 3) unread results, then the user's own order. */
export type BotActivityKind = "needs-you" | "working" | "new"

export type BotActivity = {
  kind: BotActivityKind | null
  /** Most recent activity of any kind; orders bots inside the same tier. */
  lastActivityAt: number
  /** Most recent result the user has not necessarily seen (assistant reply, completion, failure). */
  lastResultAt: number
}

export const BOT_ACTIVITY_LABELS: Record<BotActivityKind, string> = {
  "needs-you": t("Needs you"),
  working: t("Working"),
  new: t("News"),
}

const RANK: Record<BotActivityKind, number> = { "needs-you": 0, working: 1, new: 2 }
const ACTIVE_RUNS: ReadonlyArray<Run["status"]> = ["queued", "starting", "running"]

type ActivityInput = {
  bots: ReadonlyArray<Bot>
  threads: ReadonlyArray<Thread>
  messages: ReadonlyArray<Message>
  runs: ReadonlyArray<Run>
  /** Pending attention items (see pendingNotifications). */
  attention: ReadonlyArray<NotificationRecord>
  notifications: ReadonlyArray<NotificationRecord>
  lastViewed: Readonly<Record<Id, number>>
  /** The bot whose conversation is on screen is being viewed, so it never counts as unread. */
  viewingBotId: Id | null
}

const max = (values: Iterable<number>): number => {
  let result = 0
  for (const value of values) if (value > result) result = value
  return result
}

export const computeBotActivity = (input: ActivityInput): Map<Id, BotActivity> => {
  const botOfThread = new Map(input.threads.map((thread) => [thread.id, thread.botId]))
  const messagesByBot = new Map<Id, Array<Message>>()
  for (const message of input.messages) {
    const botId = botOfThread.get(message.threadId)
    if (!botId) continue
    const list = messagesByBot.get(botId) ?? []
    list.push(message)
    messagesByBot.set(botId, list)
  }
  return new Map(
    input.bots.map((bot) => {
      const messages = messagesByBot.get(bot.id) ?? []
      const threads = input.threads.filter((thread) => thread.botId === bot.id && !thread.groupId)
      const attention = input.attention.filter((item) => item.botId === bot.id)
      const actionable = attention.filter((item) => !isInformationalNotice(item))
      const runs = input.runs.filter((run) => run.botId === bot.id)
      const results = [
        ...messages
          .filter((message) => message.role === "assistant" && message.status !== "streaming")
          .map((message) => message.updatedAt),
        ...input.notifications
          .filter((item) => item.botId === bot.id && (item.kind === "done" || isFailureNotice(item)))
          .map((item) => item.createdAt),
      ]
      const lastResultAt = max(results)
      const lastActivityAt = max([
        lastResultAt,
        ...threads.map((thread) => thread.updatedAt),
        ...messages.map((message) => message.updatedAt),
        ...attention.map((item) => item.createdAt),
        ...runs.map((run) => run.startedAt ?? run.queuedAt),
      ])
      const needsYou = pendingApprovalTargets(messages).length > 0 || actionable.length > 0
      const working =
        runs.some((run) => ACTIVE_RUNS.includes(run.status)) ||
        messages.some((message) => message.status === "streaming")
      const viewed = input.lastViewed[bot.id] ?? 0
      const unread =
        bot.id !== input.viewingBotId &&
        (threads.some((thread) => thread.unread > 0) ||
          lastResultAt > viewed ||
          actionable.some((item) => isFailureNotice(item)))
      const kind: BotActivityKind | null = needsYou ? "needs-you" : working ? "working" : unread ? "new" : null
      return [bot.id, { kind, lastActivityAt, lastResultAt }]
    }),
  )
}

/** Stable: bots without news keep the incoming (manual or alphabetical) order. */
export const orderBotsByActivity = ({
  botIds,
  activity,
}: {
  botIds: ReadonlyArray<Id>
  activity: ReadonlyMap<Id, BotActivity>
}): Array<Id> =>
  botIds
    .map((id, index) => ({ id, index, entry: activity.get(id) }))
    .sort((a, b) => {
      const rankA = a.entry?.kind ? RANK[a.entry.kind] : 3
      const rankB = b.entry?.kind ? RANK[b.entry.kind] : 3
      if (rankA !== rankB) return rankA - rankB
      if (rankA < 3) {
        const recency = (b.entry?.lastActivityAt ?? 0) - (a.entry?.lastActivityAt ?? 0)
        if (recency !== 0) return recency
      }
      return a.index - b.index
    })
    .map((entry) => entry.id)

/**
 * Keep held bots (hovered, keyboard-focused, or being typed in) at the slot they occupy now,
 * and flow every other bot around them in the desired order.
 */
export const holdBotPositions = ({
  desired,
  previous,
  held,
}: {
  desired: ReadonlyArray<Id>
  previous: ReadonlyArray<Id>
  held: ReadonlySet<Id>
}): Array<Id> => {
  const present = new Set(desired)
  const anchors = new Map<number, Id>()
  previous.forEach((id, index) => {
    const slot = Math.min(index, desired.length - 1)
    if (held.has(id) && present.has(id) && !anchors.has(slot)) anchors.set(slot, id)
  })
  if (anchors.size === 0) return [...desired]
  const anchored = new Set(anchors.values())
  const rest = desired.filter((id) => !anchored.has(id))
  return desired.map((_, index) => anchors.get(index) ?? rest.shift() ?? "").filter(Boolean)
}
