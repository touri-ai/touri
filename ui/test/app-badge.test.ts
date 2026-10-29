import type { ChannelReadState, NotificationRecord } from "@touri/contracts"
import { expect, it } from "vitest"
import { getAppBadgeCount } from "../src/appBadge"

const note = (kind: NotificationRecord["kind"], botId: string | null): NotificationRecord =>
  ({ id: Math.random(), kind, botId }) as NotificationRecord
const read = (threadId: string, unread: number, mentions: number): ChannelReadState => ({
  threadId,
  readAt: 1,
  unread,
  mentions,
})

it("counts what needs the person and channel mentions, without counting a bot's mention twice", () => {
  const pending = [note("approval", "lia"), note("mention", "lia"), note("mention", null)]
  const reads = new Map([
    ["avisos", read("avisos", 3, 2)],
    ["mapas", read("mapas", 4, 0)],
  ])

  // Approval + a person's @mention + two channel mentions; the bot's @mention is one of those two.
  expect(getAppBadgeCount(pending, reads)).toBe(4)
  expect(getAppBadgeCount([], new Map())).toBe(0)
  expect(getAppBadgeCount([], new Map([["avisos", read("avisos", 20_000, 20_000)]]))).toBe(9999)
})
