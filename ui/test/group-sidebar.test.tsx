import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import type { BotGroup, Message, Thread } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import { createMockApi } from "../src/api/mock"
import { GroupSidebar } from "../src/components/Groups"

afterEach(cleanup)

it("keeps channel rows to their names without scanning every message once per channel", () => {
  const state = createMockApi().getState()
  const bot = state.bots[0]
  const baseThread = state.threads[0]
  const baseMessage = state.messages[0]
  if (!bot || !baseThread || !baseMessage) throw new Error("Missing channel fixture")
  const groups: BotGroup[] = Array.from({ length: 100 }, (_, index) => ({
    id: `channel-${index}`,
    name: `Canal ${index}`,
    memberIds: [bot.id],
    coordinatorBotId: bot.id,
    color: "#dc2626",
    avatarShape: "classic-none",
    avatarSeed: `channel-${index}`,
    createdAt: 1,
    updatedAt: 1,
  }))
  const threads = groups.map((group) =>
    Object.assign({}, baseThread, { id: `thread-${group.id}`, groupId: group.id, groupThreadId: null, unread: 0 }),
  )
  const getMessageThreadId = vi.fn((index: number) => `thread-channel-${index}`)
  const messages: Message[] = groups.map((_, index) => ({
    id: `message-${index}`,
    get threadId() {
      return getMessageThreadId(index)
    },
    parentId: null,
    role: "user",
    kind: "text",
    status: "complete",
    runId: null,
    text: `Mensagem do canal ${index}`,
    parts: [],
    sender: null,
    source: baseMessage.source,
    createdAt: 1,
    updatedAt: 1,
  }))

  render(
    <GroupSidebar
      groups={groups}
      threads={threads}
      messages={messages}
      selectedThreadId={null}
      onSelect={() => undefined}
      onCreate={() => undefined}
      onEdit={() => undefined}
      onNewThread={() => undefined}
    />,
  )

  expect(screen.getByRole("button", { name: "Canal 0" })).toBeVisible()
  expect(screen.getByRole("button", { name: "Canal 99" })).toBeVisible()
  expect(screen.queryByText("Mensagem do canal 0")).toBeNull()
  expect(getMessageThreadId.mock.calls.length).toBeLessThanOrEqual(messages.length * 3)
})

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

it("marks channels with unread bot replies in bold and mentions with a red count, except the open conversation", () => {
  const state = createMockApi().getState()
  const bot = state.bots[0]
  const baseThread = state.threads[0]
  if (!bot || !baseThread) throw new Error("Missing channel fixture")
  const channel = (id: string, name: string): BotGroup => ({
    id,
    name,
    memberIds: [bot.id],
    coordinatorBotId: bot.id,
    color: "#dc2626",
    avatarShape: "classic-none",
    avatarSeed: id,
    createdAt: 1,
    updatedAt: 1,
  })
  const groups = [channel("avisos", "avisos"), channel("mapas", "mapas"), channel("calmo", "calmo")]
  const threads = groups.map((group) => ({ ...baseThread, id: `${group.id}-thread`, groupId: group.id, unread: 0 }))
  const reads = new Map([
    ["avisos-thread", { threadId: "avisos-thread", readAt: 1, unread: 3, mentions: 2 }],
    ["mapas-thread", { threadId: "mapas-thread", readAt: 1, unread: 1, mentions: 0 }],
  ])
  const props = {
    groups,
    threads,
    channelReads: reads,
    onSelect: () => undefined,
    onCreate: () => undefined,
    onEdit: () => undefined,
    onNewThread: () => undefined,
  }
  const view = render(<GroupSidebar {...props} selectedThreadId={null} />)

  const avisos = screen.getByRole("button", { name: "avisos, 2 menções, 3 mensagens não lidas" })
  const mention = within(avisos).getByRole("img", { name: "2 menções" })
  expect(mention).toHaveAttribute("data-tone", "mention")
  expect(mention).toHaveTextContent("2")
  expect(avisos.closest(".sidebar-row")).toHaveClass("has-unread")
  const mapas = screen.getByRole("button", { name: "mapas, 1 mensagem não lida" })
  expect(within(mapas).getByRole("img", { name: "1 mensagem não lida" })).toHaveAttribute("data-tone", "unread")
  expect(mapas.closest(".sidebar-row")).toHaveClass("has-unread")
  expect(screen.getByRole("button", { name: "calmo" }).closest(".sidebar-row")).not.toHaveClass("has-unread")

  view.rerender(<GroupSidebar {...props} selectedThreadId="avisos-thread" />)

  const open = screen.getByRole("button", { name: "avisos" })
  expect(open.querySelector(".sidebar-unread")).toBeNull()
  expect(open.closest(".sidebar-row")).not.toHaveClass("has-unread")
})

it("confirms deleting a channel subthread without offering deletion for the main", async () => {
  const state = createMockApi().getState()
  const base = state.threads[0]
  const bot = state.bots[0]
  if (!base || !bot) throw new Error("Missing fixture")
  const group: BotGroup = {
    id: "channel-delete",
    name: "Publicações",
    memberIds: [bot.id],
    coordinatorBotId: bot.id,
    color: "#2563eb",
    avatarShape: "classic-none",
    avatarSeed: "synthetic",
    createdAt: 1,
    updatedAt: 1,
  }
  const main = {
    ...base,
    id: "channel-main",
    title: "Publicações",
    groupId: group.id,
    groupThreadId: null,
    createdAt: 1,
  }
  const secondary = { ...main, id: "channel-secondary", title: "Publicação diária", createdAt: 2 }
  const onDeleteThread = vi.fn(async () => undefined)

  render(
    <GroupSidebar
      groups={[group]}
      threads={[main, secondary]}
      selectedThreadId={secondary.id}
      onSelect={() => undefined}
      onCreate={() => undefined}
      onEdit={() => undefined}
      onNewThread={() => undefined}
      onDeleteThread={onDeleteThread}
    />,
  )
  screen.getByRole("button", { name: "Ações da conversa Publicação diária" }).click()
  await screen.findByRole("menuitem", { name: "Apagar conversa…" }).then((button) => button.click())
  const dialog = await screen.findByRole("alertdialog")

  expect(within(dialog).queryByText("Você pode desfazer por 5 segundos.")).toBeNull()
  expect(onDeleteThread).not.toHaveBeenCalled()
  expect(screen.queryByRole("button", { name: "Ações da conversa Publicações" })).toBeNull()
  within(dialog).getByRole("button", { name: "Apagar", exact: true }).click()
  await waitFor(() => expect(onDeleteThread).toHaveBeenCalledWith(secondary.id, secondary.botId))
})
