import type { BotGroup, Message, Run } from "@touri/contracts"
import { createMockApi } from "../../src/api/mock"

export const getGroupProgressFixture = (threadId = "progress-thread") => {
  const api = createMockApi()
  const bots = api
    .getState()
    .bots.slice(0, 2)
    .map((bot) => ({ ...bot, paused: false }))
  const bot = bots[0]
  const originalThread = api.getState().threads[0]
  if (!bot || !originalThread) throw new Error("Missing synthetic fixture")
  const group: BotGroup = {
    id: "progress-channel",
    name: "Equipe de exemplo",
    memberIds: bots.map((member) => member.id),
    coordinatorBotId: bot.id,
    color: bot.color ?? "#dc2626",
    avatarShape: bot.avatarShape ?? "classic-none",
    avatarSeed: "example",
    createdAt: 1,
    updatedAt: 1,
  }
  const thread = { ...originalThread, id: threadId, groupId: group.id, activeLeafId: "progress-request" }
  const since = Date.now() - 40_000
  const coordination: Run = {
    kind: "coordination",
    id: "progress-coordination",
    threadId,
    botId: bot.id,
    provider: bot.provider,
    trigger: "user",
    status: "running",
    requestMessageId: "progress-request",
    replyMessageId: null,
    externalTurnId: null,
    errorClass: null,
    errorMessage: null,
    usage: null,
    routineRunId: null,
    queuedAt: since,
    startedAt: since,
    finishedAt: null,
  }
  const execution: Run = {
    ...coordination,
    kind: "execution",
    id: "progress-execution",
    groupTurnId: coordination.id,
    replyMessageId: "progress-reply",
    providerStartedAt: since,
  }
  const request: Message = {
    id: "progress-request",
    threadId,
    parentId: null,
    role: "user",
    kind: "text",
    status: "complete",
    runId: null,
    text: "@mark Aguarde 60 segundos de verdade e depois responda.",
    parts: [{ type: "text", text: "@mark Aguarde 60 segundos de verdade e depois responda." }],
    sender: { id: "example-person", name: "Pessoa de exemplo", kind: "person" },
    source: "local",
    createdAt: since,
    updatedAt: since,
  }
  const reply: Message = {
    ...request,
    id: "progress-reply",
    parentId: request.id,
    role: "assistant",
    status: "streaming",
    runId: execution.id,
    text: "",
    parts: [],
    sender: { id: bot.id, name: bot.name },
  }

  return { api, bots, bot, group, thread, coordination, execution, request, reply }
}
