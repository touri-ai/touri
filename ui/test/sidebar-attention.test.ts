import type { Run } from "@touri/contracts"
import { expect, it } from "vitest"
import { createMockApi } from "../src/api/mock"
import { pendingNotifications } from "../src/sidebarAttention"

const retry: Run = {
  id: "retry-run",
  botId: "bot-retry",
  threadId: "thread-retry",
  provider: "codex",
  trigger: "retry",
  status: "running",
  routineRunId: null,
  requestMessageId: null,
  replyMessageId: null,
  externalTurnId: null,
  errorClass: null,
  errorMessage: null,
  usage: null,
  queuedAt: 200,
  startedAt: 210,
  finishedAt: null,
}

it.each(["turn-failed", "routine-failed", "routine-deferred"] as const)(
  "only supersedes %s attention when a later run belongs to the same bot and thread",
  (kind) => {
    const api = createMockApi()
    const failure = {
      ...api.notify({ kind, botId: retry.botId, threadId: retry.threadId, title: "Falha", body: "Tente novamente." }),
      createdAt: 100,
    }
    expect(pendingNotifications([failure], [], [])).toEqual([failure])
    expect(pendingNotifications([failure], [], [{ ...retry, threadId: "other-thread" }])).toEqual([failure])
    expect(pendingNotifications([failure], [], [{ ...retry, botId: "other-bot" }])).toEqual([failure])
    expect(pendingNotifications([failure], [], [{ ...retry, queuedAt: 50, startedAt: 60 }])).toEqual([failure])
    expect(
      pendingNotifications([failure], [], [{ ...retry, status: "queued", queuedAt: 50, startedAt: null }]),
    ).toEqual([failure])
    expect(pendingNotifications([failure], [], [{ ...retry, queuedAt: 50 }])).toEqual([])
    expect(pendingNotifications([failure], [], [retry])).toEqual([])
    expect(pendingNotifications([failure], [], [{ ...retry, trigger: "user" }])).toEqual([])
    expect(pendingNotifications([failure], [], [{ ...retry, status: "succeeded" }])).toEqual([])
    const nextFailure = { ...failure, id: failure.id + 1, createdAt: 300 }
    expect(pendingNotifications([failure, nextFailure], [], [{ ...retry, status: "failed" }])).toEqual([nextFailure])
  },
)

it.each(["approval", "question", "takeover", "incident"] as const)(
  "keeps %s attention while a run is active",
  (kind) => {
    const api = createMockApi()
    const notice = {
      ...api.notify({ kind, botId: retry.botId, threadId: retry.threadId, title: "Ajuda", body: "Preciso de você." }),
      createdAt: 100,
    }
    expect(pendingNotifications([notice], [], [retry])).toEqual([notice])
  },
)
