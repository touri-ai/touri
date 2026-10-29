import type { ChannelReadState, NotificationRecord } from "@touri/contracts"

/**
 * The app icon's count: what needs the person plus channel mentions. A bot's @mention is both a
 * notification and an unread channel mention, so only the channel mention counts it.
 */
export const getAppBadgeCount = (
  pending: ReadonlyArray<NotificationRecord>,
  channelReads: ReadonlyMap<string, ChannelReadState>,
): number => {
  const attention = pending.filter((item) => item.kind !== "mention" || item.botId === null).length
  const mentions = Array.from(channelReads.values()).reduce((total, read) => total + read.mentions, 0)

  return Math.min(9999, attention + mentions)
}
