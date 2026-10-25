import type { ApiRoutes } from "@touri/contracts"
import { afterEach, expect, test, vi } from "vitest"
import { routeGroupMessage } from "../../sidecar/src/groups/store"
import { createMockApi } from "../src/api/mock"

afterEach(() => vi.useRealTimers())

const getFixture = async () => {
  vi.useFakeTimers()
  const api = createMockApi()
  const { group, thread } = await api.request("POST /groups", {
    name: "Equipe sintética",
    memberIds: ["bot-mark", "bot-onb"],
    coordinatorBotId: "bot-mark",
  })
  const send = (text: string) =>
    api.request(
      "POST /threads/:id/messages",
      { threadId: thread.id, text, parentId: null, attachmentIds: [], clientNonce: crypto.randomUUID() },
      { id: thread.id },
    )

  return { api, group, thread, send }
}

test.each([
  "Plano salvo para a equipe.",
  "Contato: teste@mark.example",
  "@desconhecido confira o plano.",
  "@onb confira o plano.",
  "@onb e @mark, confiram; @onb também recebe uma vez.",
  '@"mark" e @ONB, confiram o plano.',
])("mock channel routing matches production for %s", async (text) => {
  const { api, group, thread, send } = await getFixture()
  const recipients = routeGroupMessage(group, api.getState().bots, text)

  const result = await send(text)
  await vi.runAllTimersAsync()
  const { runs } = await api.request("GET /threads/:id/runs", {}, { id: thread.id })
  const { messages, activeLeafId } = await api.request("GET /threads/:id/messages", {}, { id: thread.id })

  expect(activeLeafId).toBe(messages.at(-1)?.id)
  expect(messages.slice(1).map((message) => message.parentId)).toEqual(
    messages.slice(0, -1).map((message) => message.id),
  )
  expect(runs.map((run) => run.botId)).toEqual(recipients)
  expect(messages.filter((message) => message.role === "user")).toEqual([result.message])
  expect(messages.filter((message) => message.role === "assistant")).toHaveLength(recipients.length)
  expect(messages.filter((message) => message.role === "assistant").map((message) => message.sender)).toEqual(
    recipients.map((id) => ({ id, name: api.getState().bots.find((bot) => bot.id === id)?.name })),
  )
  expect(result.run?.botId ?? null).toBe(recipients[0] ?? null)
  expect(runs.every((run) => run.status === "succeeded")).toBe(true)
})

test("a mention of a bot outside the channel does not start a run", async () => {
  const { api, group, thread, send } = await getFixture()
  await api.request("PATCH /groups/:id", { ...group, memberIds: ["bot-mark"] }, { id: group.id })

  const result = await send("@onb confira o plano.")
  const { runs } = await api.request("GET /threads/:id/runs", {}, { id: thread.id })

  expect(result.run).toBeNull()
  expect(runs).toEqual([])
})

test("direct messages still start the recipient bot without a mention", async () => {
  const { api } = await getFixture()

  const result = await api.request(
    "POST /threads/:id/messages",
    { threadId: "thread-onb", text: "Confira o plano.", parentId: null, attachmentIds: [] },
    { id: "thread-onb" },
  )
  await vi.runAllTimersAsync()
  const { messages } = await api.request("GET /threads/:id/messages", {}, { id: "thread-onb" })

  expect(result.run).toMatchObject({ botId: "bot-onb" })
  expect(messages.find((message) => message.id === result.run?.replyMessageId)?.sender).toBeNull()
})

test.each([
  { groupAction: "ask_all", recipients: ["bot-mark", "bot-onb"] },
  { groupAction: "summarize", recipients: ["bot-mark"] },
] as const)(
  "explicit $groupAction actions preserve their production recipients",
  async ({ groupAction, recipients }) => {
    const { api, thread } = await getFixture()
    const input: ApiRoutes["POST /threads/:id/messages"]["req"] = {
      threadId: thread.id,
      text: "Confira o plano.",
      parentId: null,
      attachmentIds: [],
      groupAction,
    }

    await api.request("POST /threads/:id/messages", input, { id: thread.id })
    await vi.runAllTimersAsync()
    const { runs } = await api.request("GET /threads/:id/runs", {}, { id: thread.id })
    const { messages } = await api.request("GET /threads/:id/messages", {}, { id: thread.id })

    expect(runs.map((run) => run.botId)).toEqual(recipients)
    expect(messages.filter((message) => message.role === "assistant").map((message) => message.sender?.id)).toEqual(
      recipients,
    )
  },
)
