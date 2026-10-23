import type { Message, MessagePart, Run, SendMessageInput } from "@touri/contracts"
import { RUN_START_TIMEOUT_MESSAGE, safeRunFailure } from "@touri/contracts/run-failure"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import type { ApiRequest } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"
import { createSendJournal } from "../../src/api/sendJournal"
import { localResponseTimings } from "../../src/localResponseTimings"
import "../../src/styles.css"

const api = createMockApi()
const state = api.getState()
const bot = state.bots.find((row) => row.id === "bot-mark")
const thread = state.threads.find((row) => row.botId === bot?.id)
if (!bot || !thread) throw new Error("Missing conversation")
const conversation = new URLSearchParams(location.search).get("conversation")
if (conversation) {
  thread.id = `feedback-${conversation}`
  bot.mainThreadId = thread.id
}
localStorage.setItem("touri.workspace.v1", JSON.stringify({ botId: bot.id, threadId: thread.id }))
bot.machine = "local"
bot.paused = false
bot.roleLine = "Organização de notas"
thread.title = "Minhas notas"
state.messages.splice(0)
thread.activeLeafId = null
let run: Run | null = null
let reply: Message | null = null
let sends = 0
let acceptedAt = 0
const originalRequest = api.request
const request: ApiRequest = async (route, input, path) => {
  if (route === "GET /health") return { ok: true, version: "test", schemaVersion: 19 } as never
  if (route === "GET /runs")
    return { runs: run && ["queued", "starting", "running"].includes(run.status) ? [run] : [] } as never
  if (route === "POST /threads/:id/messages") {
    sends++
    const sent = input as SendMessageInput
    await new Promise((resolve) => setTimeout(resolve, 200))
    acceptedAt = performance.now()
    const now = Date.now()
    const message: Message = {
      id: `send:${sent.clientNonce}`,
      threadId: thread.id,
      parentId: sent.parentId,
      role: "user",
      kind: "text",
      status: "complete",
      runId: null,
      text: sent.text,
      parts: [{ type: "text", text: sent.text }],
      sender: null,
      source: "local",
      createdAt: now,
      updatedAt: now,
      delivery: {
        clientNonce: sent.clientNonce ?? "test-nonce",
        deadline: sent.deadline ?? now + 60_000,
        status: "acked",
      },
    }
    run = {
      id: `run-${thread.id}-${sends}`,
      threadId: thread.id,
      botId: bot.id,
      provider: bot.provider,
      trigger: "user",
      origin: "message",
      requestMessageId: message.id,
      replyMessageId: null,
      externalTurnId: null,
      status: "starting",
      errorClass: null,
      errorMessage: null,
      usage: null,
      routineRunId: null,
      queuedAt: now,
      startedAt: now,
      finishedAt: null,
    }
    state.messages.push(message)
    thread.activeLeafId = message.id
    api.emit({ type: "thread.updated", thread: { ...thread } })
    return { message, run } as never
  }
  if (route === "POST /runs/:id/cancel") {
    if (run) {
      run = { ...run, status: "canceled", finishedAt: Date.now() }
      api.emit({ type: "run.updated", run })
    }
    return { run } as never
  }
  return originalRequest(route, input, path)
}
api.request = request
sessionStorage.removeItem("touri.send-journal.v1")
const journal = createSendJournal({ request, emit: api.emit, storage: sessionStorage })
api.sendMessage = journal.enqueue
Object.assign(window, {
  feedback: {
    sends: () => sends,
    acceptedAt: () => acceptedAt,
    timings: () => localResponseTimings().read(),
    provider: () => {
      if (!run) throw new Error("Missing run")
      run = { ...run, providerStartedAt: Date.now() }
      api.emit({ type: "run.updated", run })
    },
    parts: (parts: MessagePart[]) => {
      if (!run) throw new Error("Missing run")
      run = { ...run, status: "running" }
      api.emit({ type: "run.updated", run })
      reply = {
        id: `reply-${sends}`,
        threadId: thread.id,
        parentId: run.requestMessageId,
        role: "assistant",
        kind: "text",
        status: "streaming",
        runId: run.id,
        text: "",
        parts,
        sender: null,
        source: "local",
        createdAt: reply?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      }
      state.messages.splice(0, state.messages.length, ...state.messages.filter((row) => row.id !== reply?.id), reply)
      thread.activeLeafId = reply.id
      api.emit({ type: "message.updated", message: reply })
      api.emit({ type: "thread.updated", thread: { ...thread } })
    },
    timeout: () => {
      if (!run) throw new Error("Missing run")
      const failure = safeRunFailure("timeout", RUN_START_TIMEOUT_MESSAGE)
      const message: Message = {
        id: `startup-failure-${sends}`,
        threadId: thread.id,
        parentId: run.requestMessageId,
        role: "assistant",
        kind: "text",
        status: "failed",
        runId: run.id,
        text: "",
        parts: [{ type: "notice", level: "error", code: "run_failed", text: RUN_START_TIMEOUT_MESSAGE, failure }],
        sender: null,
        source: "local",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      run = Object.assign({}, run, {
        status: "failed" as const,
        errorClass: "timeout" as const,
        errorMessage: RUN_START_TIMEOUT_MESSAGE,
        replyMessageId: message.id,
        finishedAt: Date.now(),
      })
      // Mock routes share these collections, so update their exposed state in place.
      state.messages.push(message)
      thread.activeLeafId = message.id
      api.emit({ type: "message.updated", message })
      api.emit({ type: "run.updated", run })
      api.emit({ type: "thread.updated", thread: Object.assign({}, thread) })
    },
    finish: () => {
      if (!run) throw new Error("Missing run")
      run = { ...run, status: "succeeded", finishedAt: Date.now() }
      api.emit({ type: "run.updated", run })
    },
  },
})
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
