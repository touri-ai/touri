import { cleanup, render, screen, within } from "@testing-library/react"
import type { BotGroup, Thread } from "@touri/contracts"
import { afterEach, expect, it } from "vitest"
import { createMockApi } from "../src/api/mock"
import { GroupSidebar } from "../src/components/Groups"

afterEach(cleanup)

it("shows channel avatars, unread totals and an attention badge", () => {
  const state = createMockApi().getState()
  const bots = state.bots.slice(0, 3)
  const bot = bots[0]
  const baseThread = state.threads[0]
  if (!bot || !baseThread || bots.length !== 3) throw new Error("Missing channel fixture")

  const group: BotGroup = {
    id: "channel-qa",
    name: "Equipe QA",
    memberIds: bots.map(({ id }) => id),
    coordinatorBotId: bot.id,
    color: "#dc2626",
    avatarShape: "classic-none",
    avatarSeed: "channel-qa",
    createdAt: 1,
    updatedAt: 1,
  }
  const thread: Thread = { ...baseThread, id: "channel-thread", groupId: group.id, unread: 3 }
  const props = {
    groups: [group],
    bots,
    threads: [thread],
    selectedThreadId: null,
    onSelect: () => {},
    onCreate: () => {},
    onEdit: () => {},
    onNewThread: () => {},
  }
  const view = render(<GroupSidebar {...props} attentionThreadIds={new Set()} />)
  const channel = screen.getByRole("button", { name: "Equipe QA, 3 mensagens não lidas" })

  expect(within(channel).getByRole("img", { name: /3 membros/ })).toBeVisible()
  expect(within(channel).getByText("+1")).toBeVisible()
  expect(within(channel).getByRole("img", { name: "3 mensagens não lidas" })).toBeVisible()
  expect(channel).toHaveAccessibleName("Equipe QA, 3 mensagens não lidas")

  view.rerender(<GroupSidebar {...props} attentionThreadIds={new Set([thread.id])} />)

  expect(within(channel).getByRole("img", { name: "1 item precisa de você" })).toBeVisible()
  expect(within(channel).queryByRole("img", { name: /mensagens não lidas/ })).toBeNull()
  expect(channel).toHaveAccessibleName("Equipe QA, 1 item precisa de você")
})
