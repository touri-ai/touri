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
    threads: [thread],
    selectedThreadId: null,
    onSelect: () => {},
    onCreate: () => {},
    onEdit: () => {},
    onNewThread: () => {},
  }
  const view = render(<GroupSidebar {...props} attentionThreadIds={new Set()} />)
  const channel = screen.getByRole("button", { name: "Equipe QA, 3 mensagens não lidas" })

  expect(within(channel).queryByRole("img", { name: /membros/ })).toBeNull()
  expect(within(channel).getByRole("img", { name: "3 mensagens não lidas" })).toBeVisible()
  expect(channel).toHaveAccessibleName("Equipe QA, 3 mensagens não lidas")

  view.rerender(<GroupSidebar {...props} attentionThreadIds={new Set([thread.id])} />)

  expect(within(channel).getByRole("img", { name: "1 item precisa de você" })).toBeVisible()
  expect(within(channel).queryByRole("img", { name: /mensagens não lidas/ })).toBeNull()
  expect(channel).toHaveAccessibleName("Equipe QA, 1 item precisa de você, 3 mensagens não lidas")
})

it("hides an unread badge for the selected channel conversation", () => {
  const state = createMockApi().getState()
  const bot = state.bots[0]
  const baseThread = state.threads[0]
  if (!bot || !baseThread) throw new Error("Missing channel fixture")
  const group: BotGroup = {
    id: "channel-selected",
    name: "Produto",
    memberIds: [bot.id],
    coordinatorBotId: bot.id,
    color: "#dc2626",
    avatarShape: "classic-none",
    avatarSeed: "channel-selected",
    createdAt: 1,
    updatedAt: 1,
  }
  const thread: Thread = { ...baseThread, id: "channel-selected-thread", groupId: group.id, unread: 4 }

  render(
    <GroupSidebar
      groups={[group]}
      threads={[thread]}
      selectedThreadId={thread.id}
      onSelect={() => undefined}
      onCreate={() => undefined}
      onEdit={() => undefined}
      onNewThread={() => undefined}
    />,
  )

  const channel = screen.getByRole("button", { name: "Produto" })
  expect(channel.querySelector(".sidebar-unread")).toBeNull()
})
