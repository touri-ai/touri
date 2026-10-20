import { cleanup, render, screen, within } from "@testing-library/react"
import type { BotGroup, Thread } from "@touri/contracts"
import { afterEach, expect, it } from "vitest"
import { createMockApi } from "../src/api/mock"
import { GroupSidebar } from "../src/components/Groups"

afterEach(cleanup)

it("shows channel avatars, unread totals and an attention badge", () => {
  const state = createMockApi().getState()
  const bot = state.bots[0]
  const baseThread = state.threads[0]
  if (!bot || !baseThread) throw new Error("Missing channel fixture")

  const group: BotGroup = {
    id: "channel-qa",
    name: "Equipe QA",
    memberIds: [bot.id],
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
    bots: [bot],
    threads: [thread],
    selectedThreadId: null,
    onSelect: () => {},
    onCreate: () => {},
    onEdit: () => {},
    onNewThread: () => {},
  }
  const view = render(<GroupSidebar {...props} attentionThreadIds={new Set()} />)
  const channel = screen.getByRole("button", { name: "Equipe QA" })

  expect(within(channel).getByRole("img", { name: /mark/ })).toBeVisible()
  expect(within(channel).getByRole("img", { name: "3 mensagens não lidas" })).toBeVisible()

  view.rerender(<GroupSidebar {...props} attentionThreadIds={new Set([thread.id])} />)

  expect(within(channel).getByRole("img", { name: "1 precisa de você" })).toBeVisible()
  expect(within(channel).queryByRole("img", { name: /mensagens não lidas/ })).toBeNull()
})
