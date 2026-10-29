import type { ChannelReadState, NotificationRecord } from "@touri/contracts"
import { expect, it } from "vitest"
import { getAppBadgeCount } from "../src/appBadge"

const note = (kind: NotificationRecord["kind"], botId: string | null, threadId: string | null = null) =>
  ({ id: Math.random(), kind, botId, threadId }) as NotificationRecord
const read = (threadId: string, unread: number, mentions: number): ChannelReadState => ({
  threadId,
  readAt: 1,
  unread,
  mentions,
})

it("counts what needs the person and channel mentions, without counting a bot's mention twice", () => {
  // An approval, a bot's @mention in #avisos, a person's @mention and a coordinator's @mention in #mapas.
  const pending = [
    note("approval", "lia"),
    note("mention", "lia", "avisos"),
    note("mention", null, "avisos"),
    note("mention", "coordenador", "mapas"),
  ]
  const reads = new Map([
    ["avisos", read("avisos", 3, 2)],
    ["mapas", read("mapas", 4, 0)],
  ])

  // Four pending items plus the #avisos mention that has no notification of its own.
  expect(getAppBadgeCount(pending, reads)).toBe(5)
  // The conversation on screen is being read.
  expect(getAppBadgeCount(pending, reads, "avisos")).toBe(4)
  expect(getAppBadgeCount([], null)).toBe(0)
  expect(getAppBadgeCount([], new Map([["avisos", read("avisos", 20_000, 20_000)]]))).toBe(9999)
})
