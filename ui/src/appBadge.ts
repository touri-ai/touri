import type { ChannelReadState, NotificationRecord } from "@touri/contracts"

/**
 * The app icon's count: what needs the person plus channel mentions. A bot's @mention is both a
 * pending notification and an unread channel mention, so each channel adds only the mentions its
 * pending bot notifications do not already count. The conversation on screen is being read.
 */
export const getAppBadgeCount = (
  pending: ReadonlyArray<NotificationRecord>,
  channelReads: ReadonlyMap<string, ChannelReadState> | null,
  openThreadId: string | null = null,
): number => {
  const notifiedMentions = new Map<string, number>()
  for (const item of pending)
    if (item.kind === "mention" && item.botId !== null && item.threadId)
      notifiedMentions.set(item.threadId, (notifiedMentions.get(item.threadId) ?? 0) + 1)
  const mentions = Array.from(channelReads?.values() ?? []).reduce(
    (total, read) =>
      read.threadId === openThreadId
        ? total
        : total + Math.max(0, read.mentions - (notifiedMentions.get(read.threadId) ?? 0)),
    0,
  )

  return Math.min(9999, pending.length + mentions)
}
