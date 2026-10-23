import { cleanup, render, screen } from "@testing-library/react"
import type { Message } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import { createMockApi } from "../src/api/mock"
import { ChatPanel } from "../src/components/ChatPanel"

afterEach(cleanup)

it.each([null, "context"])("keeps hydrated channel messages sharing parent %s independent", async (parentId) => {
  const fixture = await getChannelFixture()
  const messages = getMessages(fixture.thread.id, parentId)

  render(getChannelView(fixture, messages))

  await expectChannelHistory(messages)
  expect(fixture.switchBranch).not.toHaveBeenCalled()
  expect(fixture.send).not.toHaveBeenCalled()
})

it.each([null, "context"])("keeps live channel messages sharing parent %s independent", async (parentId) => {
  const fixture = await getChannelFixture()
  const messages = getMessages(fixture.thread.id, parentId)
  const view = render(getChannelView(fixture, messages.slice(0, 1)))
  await screen.findByText(parentId ? "Contexto do canal." : "Vamos conferir os mapas.")

  view.rerender(getChannelView(fixture, messages))

  await expectChannelHistory(messages)
  expect(fixture.switchBranch).not.toHaveBeenCalled()
  expect(fixture.send).not.toHaveBeenCalled()
})

const getChannelFixture = async () => {
  const api = createMockApi()
  const bot = api.getState().bots[0]
  if (!bot) throw new Error("Missing synthetic bot")
  const { group, thread } = await api.request("POST /groups", {
    name: "Equipe de demonstração",
    color: "#16a34a",
    avatarShape: "classic-none",
    memberIds: [bot.id],
    coordinatorBotId: bot.id,
  })

  return { api, bot, group, thread, send: vi.fn(), switchBranch: vi.fn() }
}

const getChannelView = (fixture: Awaited<ReturnType<typeof getChannelFixture>>, messages: Message[]) => (
  <ChatPanel
    api={fixture.api}
    bot={fixture.bot}
    group={fixture.group}
    groupMembers={[fixture.bot]}
    channelMode
    thread={fixture.thread}
    messages={messages}
    runs={[]}
    onSend={fixture.send}
    onSwitchBranch={fixture.switchBranch}
    onRetry={vi.fn()}
    onCancel={vi.fn()}
    computerGrant={null}
    onComputerGrant={vi.fn()}
    onOpenTools={vi.fn()}
  />
)

const getMessages = (threadId: string, parentId: string | null): Message[] =>
  (
    [
      {
        id: "context",
        text: "Contexto do canal.",
        role: "user",
        sender: { id: "owner", name: "Pessoa demo", kind: "person" },
      },
      {
        id: "human",
        text: "Vamos conferir os mapas.",
        role: "user",
        sender: { id: "owner", name: "Pessoa demo", kind: "person" },
      },
      {
        id: "integration",
        text: "Mapas disponíveis para revisão.",
        role: "user",
        sender: { id: "integration-demo", name: "Avisos demo", kind: "integration" },
      },
      {
        id: "reply-one",
        text: "Primeira conferência concluída.",
        role: "assistant",
        sender: { id: "bot-one", name: "Mapas" },
      },
      {
        id: "reply-two",
        text: "Segunda conferência concluída.",
        role: "assistant",
        sender: { id: "bot-two", name: "Roteiro" },
      },
    ] satisfies Array<Pick<Message, "id" | "text" | "role" | "sender">>
  )
    .filter((entry) => entry.id !== "context" || parentId !== null)
    .map((entry, index) => ({
      id: entry.id,
      threadId,
      parentId: entry.id === "context" ? null : parentId,
      role: entry.role,
      kind: "text",
      status: "complete",
      runId: null,
      text: entry.text,
      parts: [{ type: "text", text: entry.text }],
      sender: entry.sender,
      source: "local",
      createdAt: index + 1,
      updatedAt: index + 1,
    }))

const expectChannelHistory = async (messages: Message[]) => {
  await screen.findByText("Mapas disponíveis para revisão.")

  messages.forEach((message) => {
    expect(screen.getByText(message.text)).toBeVisible()
  })
  expect(screen.queryAllByRole("group", { name: "Ramificações da mensagem" })).toHaveLength(0)
  expect(screen.queryAllByRole("button", { name: "Ramificação anterior" })).toHaveLength(0)
  expect(screen.queryAllByRole("button", { name: "Próxima ramificação" })).toHaveLength(0)
  expect(screen.queryByRole("button", { name: "Editar", exact: true })).toBeNull()
}
