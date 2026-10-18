import type { Message, Run } from "@touri/contracts"
import type { ApiRequest } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"

export const retentionBotCount = 30
export const retainedStateBudget = 1024 * 1024
const epoch = Date.UTC(2026, 0, 1)

/** Generated history is reconstructed on request, so the fixture itself cannot retain event payloads. */
export const createRetentionWorkload = () => {
  const mock = createMockApi()
  const state = mock.getState()
  const bot = state.bots[0]
  const thread = state.threads[0]
  if (!bot || !thread) throw new Error("Missing workload templates")
  state.bots.splice(
    0,
    state.bots.length,
    ...Array.from({ length: retentionBotCount }, (_, index) => ({
      ...bot,
      id: `retention-bot-${index}`,
      name: `Bot ${index}`,
      mainThreadId: `retention-thread-${index}`,
      projectId: null,
      homeDir: "/workspace/generated",
      instructions: "Review generated samples.",
    })),
  )
  state.threads.splice(
    0,
    state.threads.length,
    ...state.bots.map((bot) => ({
      ...thread,
      id: bot.mainThreadId ?? "",
      botId: bot.id,
      activeLeafId: null,
      unread: 0,
      updatedAt: epoch,
    })),
  )
  state.messages.splice(0)
  const turns = Array.from({ length: retentionBotCount }, () => 1)
  const historyRequests = Array.from({ length: retentionBotCount }, () => 0)
  const message = (bot: number, turn: number): Message => {
    const text = `Generated reply ${bot}.${turn}. ${"Sample text. ".repeat(160)}`
    return {
      id: `retention-message-${bot}-${turn}`,
      threadId: `retention-thread-${bot}`,
      parentId: turn ? `retention-message-${bot}-${turn - 1}` : null,
      role: "assistant",
      kind: "text",
      status: turn % 9 === 7 ? "failed" : turn % 9 === 8 ? "canceled" : "complete",
      runId: `retention-run-${bot}-${turn}`,
      text,
      parts: [
        { type: "reasoning", text: `Generated reasoning ${bot}.${turn}. ${"Step. ".repeat(700)}` },
        {
          type: "tool_call",
          callId: `retention-tool-${bot}-${turn}`,
          tool: "read_file",
          summary: "Read generated sample",
          inputJson: '{"path":"/workspace/generated/sample.txt"}',
          outputJson: JSON.stringify({ sample: `${bot}.${turn}`, output: "Generated output. ".repeat(512) }),
          ok: true,
        },
        { type: "text", text },
      ],
      sender: null,
      source: "local",
      createdAt: epoch + turn * retentionBotCount + bot,
      updatedAt: epoch + turn * retentionBotCount + bot,
      updatedSeq: turn * 10 + 4,
    }
  }
  const run = (bot: number, turn: number): Run => {
    const at = epoch + turn * retentionBotCount + bot
    return {
      id: `retention-run-${bot}-${turn}`,
      botId: `retention-bot-${bot}`,
      threadId: `retention-thread-${bot}`,
      provider: "codex",
      trigger: "user",
      requestMessageId: null,
      replyMessageId: `retention-message-${bot}-${turn}`,
      externalTurnId: null,
      status: turn % 9 === 7 ? "failed" : turn % 9 === 8 ? "canceled" : "succeeded",
      errorClass: null,
      errorMessage: null,
      usage: null,
      routineRunId: null,
      queuedAt: at,
      startedAt: at,
      finishedAt: at,
    }
  }
  const request: ApiRequest = async (route, input, path) => {
    const index = Number(path?.id?.replace("retention-thread-", ""))
    if (route === "GET /threads/:id/messages") {
      historyRequests[index] = (historyRequests[index] ?? 0) + 1
      return { messages: Array.from({ length: turns[index] ?? 0 }, (_, turn) => message(index, turn)) } as never
    }
    if (route === "GET /threads/:id/runs")
      return { runs: Array.from({ length: turns[index] ?? 0 }, (_, turn) => run(index, turn)) } as never
    if (route === "GET /workspace/activity")
      return { messages: [], runs: turns.map((count, bot) => run(bot, count - 1)) } as never
    return mock.request(route, input, path)
  }
  return {
    api: { ...mock, request },
    historyRequests,
    message,
    run,
    /** Leave bot 0's completed conversation on screen while all 29 other bots work. */
    round: () => {
      for (let bot = 1; bot < retentionBotCount; bot++) {
        const turn = turns[bot] ?? 1
        turns[bot] = turn + 1
        const reply = message(bot, turn)
        mock.emit({ type: "run.updated", run: { ...run(bot, turn), status: "running", finishedAt: null } })
        mock.emit({
          type: "message.created",
          message: { ...reply, status: "streaming", text: "", parts: [], updatedSeq: turn * 10 },
        })
        mock.emit({
          type: "message.parts",
          threadId: reply.threadId,
          messageId: reply.id,
          parts: reply.parts.map((part, partIndex) => ({ partIndex, part })),
          updatedSeq: turn * 10 + 1,
        })
        mock.emit({
          type: "message.delta",
          threadId: reply.threadId,
          messageId: reply.id,
          partIndex: 2,
          partType: "text",
          offset: reply.text.length,
          delta: " Generated delta.",
          updatedSeq: turn * 10 + 2,
        })
        mock.emit({ type: "message.updated", message: reply })
        mock.emit({ type: "run.updated", run: run(bot, turn) })
        const thread = state.threads[bot]
        if (thread) {
          thread.unread++
          thread.activeLeafId = reply.id
          thread.updatedAt = reply.updatedAt
          mock.emit({ type: "thread.updated", thread: { ...thread } })
        }
      }
    },
  }
}
