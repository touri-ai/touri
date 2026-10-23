import type { Message, MessagePart, Run } from "@touri/contracts"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import type { ApiRequest } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"
import replies from "../fixtures/provider-replies.json"
import "../../src/styles.css"

const scenario = new URLSearchParams(location.search).get("scenario")
const snapshot = Object.entries(replies).find(([key]) => key === scenario)?.[1] ?? replies.recovered
const api = createMockApi()
const state = api.getState()
const bot = state.bots.find((row) => row.id === "bot-mark")
const thread = state.threads.find((row) => row.botId === bot?.id)
const template = state.messages.at(0)
if (!bot || !thread || !template) throw new Error("Missing synthetic conversation")
// The mock API owns these mutable seed objects, including its demonstration model label.
Object.assign(bot, {
  mainThreadId: thread.id,
  machine: "local",
  paused: false,
  roleLine: "Organização de notas",
  provider: "opencode",
  model: "touri-api-demo/Demo",
})
const now = Date.now()
const request: Message = Object.assign({}, template, {
  id: "synthetic-request",
  threadId: thread.id,
  parentId: null,
  role: "user" as const,
  status: "complete" as const,
  runId: null,
  text: "Responda à mensagem sintética.",
  parts: [{ type: "text" as const, text: "Responda à mensagem sintética." }],
  delivery: null,
  sender: null,
  createdAt: now,
  updatedAt: now,
})
const run: Run = {
  id: "synthetic-run",
  threadId: thread.id,
  botId: bot.id,
  provider: bot.provider,
  trigger: "user",
  requestMessageId: request.id,
  replyMessageId: "synthetic-reply",
  externalTurnId: null,
  status: snapshot.runStatus as Run["status"],
  errorClass: snapshot.errorClass,
  errorMessage: snapshot.errorMessage,
  usage: null,
  routineRunId: null,
  queuedAt: now,
  startedAt: now,
  finishedAt: now,
}
const reply: Message = Object.assign({}, request, {
  id: "synthetic-reply",
  parentId: request.id,
  role: "assistant" as const,
  status: snapshot.replyStatus as Message["status"],
  runId: run.id,
  text: snapshot.text,
  parts: snapshot.parts as MessagePart[],
})
Object.assign(thread, { activeLeafId: reply.id, title: "Conversa sintética" })
state.messages.splice(0, state.messages.length, request, reply)
localStorage.setItem("touri.workspace.v1", JSON.stringify({ botId: bot.id, threadId: thread.id }))
const originalRequest = api.request
const requestApi: ApiRequest = async (route, input, path) => {
  if (route === "GET /health") return { ok: true, version: "test", schemaVersion: 19 } as never
  if (route === "GET /threads/:id/runs") return { runs: path?.id === thread.id ? [run] : [] } as never
  if (route === "GET /runs") return { runs: [] } as never

  return originalRequest(route, input, path)
}
api.request = requestApi
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
