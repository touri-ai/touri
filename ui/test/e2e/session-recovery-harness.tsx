import type { Message, Run } from "@touri/contracts"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import type { ApiRequest } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"
import "../../src/styles.css"

const mock = createMockApi()
const state = mock.getState()
const bot = state.bots.find((candidate) => candidate.id === "bot-mark")
const thread = state.threads.find((candidate) => candidate.id === "thread-mark")
if (!bot || !thread) throw new Error("Missing synthetic conversation")

const now = Date.now()
const diagnosticText =
  "A sessão anterior não pôde ser retomada. Vou continuar com o histórico salvo em uma nova sessão."
const getMessage = (overrides: Partial<Message>): Message =>
  Object.assign(
    {
      id: "request",
      threadId: thread.id,
      parentId: null,
      role: "user",
      kind: "text",
      status: "complete",
      runId: null,
      text: "Confira os totais do relatório de exemplo e conclua a revisão.",
      parts: [{ type: "text", text: "Confira os totais do relatório de exemplo e conclua a revisão." }],
      sender: null,
      source: "local",
      createdAt: now - 90_000,
      updatedAt: now,
    },
    overrides,
  )
const messages = [
  getMessage({}),
  getMessage({
    id: "marker",
    parentId: "request",
    role: "system",
    kind: "notice",
    runId: "session-run",
    text: diagnosticText,
    parts: [{ type: "notice", code: "run_resumed", level: "info", text: diagnosticText }],
    createdAt: now - 85_000,
  }),
  getMessage({
    id: "reply",
    parentId: "marker",
    role: "assistant",
    runId: "session-run",
    text: "Relatório revisado. Os totais conferem e todas as etapas foram concluídas.",
    parts: [
      { type: "reasoning", text: "Conferindo os totais do relatório de exemplo." },
      { type: "notice", code: "run_resumed", level: "info", text: diagnosticText },
      {
        type: "command",
        callId: "check-totals",
        command: "printf 'Totais conferidos'",
        cwd: "/workspace/example",
        output: "Totais conferidos",
        exitCode: 0,
      },
      { type: "text", text: "Relatório revisado. Os totais conferem e todas as etapas foram concluídas." },
    ],
    createdAt: now - 80_000,
  }),
]
const run: Run = {
  id: "session-run",
  threadId: thread.id,
  botId: bot.id,
  provider: bot.provider,
  trigger: "user",
  requestMessageId: "request",
  replyMessageId: "reply",
  externalTurnId: null,
  status: "succeeded",
  errorClass: null,
  errorMessage: null,
  usage: null,
  routineRunId: null,
  queuedAt: now - 90_000,
  startedAt: now - 90_000,
  finishedAt: now,
}
const threads = state.threads.map((candidate) =>
  candidate.id === thread.id
    ? Object.assign({}, candidate, { title: "Revisão do relatório", activeLeafId: "reply" })
    : candidate,
)
const bots = state.bots.map((candidate) =>
  candidate.id === bot.id
    ? Object.assign({}, candidate, { name: "Relatórios", roleLine: "Conferência de documentos" })
    : candidate,
)
const request: ApiRequest = async (route, input, path) => {
  if (route === "GET /bots") return { bots } as never
  if (route === "GET /bots/:id/threads" && path?.id === bot.id)
    return { threads: threads.filter((candidate) => candidate.botId === bot.id) } as never
  if (route === "GET /threads/:id/messages" && path?.id === thread.id)
    return { messages, activeLeafId: "reply" } as never
  if (route === "GET /threads/:id/runs" && path?.id === thread.id) return { runs: [run] } as never

  return mock.request(route, input, path)
}
const api = Object.assign({}, mock, { request })
localStorage.setItem("touri.workspace.v1", JSON.stringify({ botId: bot.id, threadId: thread.id }))
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
