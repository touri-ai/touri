import type { Message, Run } from "@touri/contracts"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import { createMockApi } from "../../src/api/mock"
import "../../src/styles.css"

const api = createMockApi()
const { bots, threads, messages } = api.getState()
const bot = bots[0]
const thread = threads.find((item) => item.botId === bot?.id)
if (!bot || !thread) throw new Error("Missing error fixture")
bot.machine = "vm"
bot.name = "Planejamento"
thread.title = "Organizar as notas"
const scenario = new URLSearchParams(window.location.search).get("scenario")
const modelIsAtCapacity = scenario === "capacity"
const diagnostic = getDiagnostic(scenario)
const run: Run = {
  id: "interrupted",
  threadId: thread.id,
  botId: bot.id,
  provider: bot.provider,
  trigger: "user",
  requestMessageId: "request",
  replyMessageId: "failure",
  externalTurnId: null,
  status: "failed",
  errorClass: modelIsAtCapacity ? "rate_limit" : "cli_crash",
  errorMessage: diagnostic,
  usage: null,
  routineRunId: null,
  queuedAt: Date.now() - 2000,
  startedAt: Date.now() - 1000,
  finishedAt: Date.now(),
}
const message: Message = {
  id: "failure",
  threadId: thread.id,
  parentId: null,
  role: "assistant",
  kind: "text",
  status: "failed",
  runId: run.id,
  text: "",
  parts: [{ type: "notice", level: "error", code: "run_failed", text: diagnostic }],
  sender: null,
  source: "local",
  createdAt: run.queuedAt,
  updatedAt: Date.now(),
}
messages.splice(0, messages.length, message)
thread.activeLeafId = message.id
api.notify({ kind: "turn-failed", botId: bot.id, threadId: thread.id, title: "Turn failed", body: diagnostic })
const original = api.request.bind(api)
api.request = ((route, input, path) => {
  if (route === "GET /threads/:id/runs" || route === "GET /workspace/activity")
    return Promise.resolve({ runs: [run], messages: [message] })
  if (route === "GET /machines")
    return Promise.resolve({
      capability: { available: true, reason: null, provider: "apple-container" },
      machines: [
        {
          botId: bot.id,
          status: "error",
          progress: null,
          error: diagnostic,
          memoryMb: 2048,
          createdMs: null,
          startMs: null,
        },
      ],
    })
  return original(route, input, path)
}) as typeof api.request
setTimeout(() => api.emit({ type: "notify", title: "Turn failed", body: diagnostic, threadId: thread.id }), 700)
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)

function getDiagnostic(scenario: string | null): string {
  if (scenario === "invalid-model") return "The saved model name is invalid. Choose another model in the bot settings."
  if (scenario === "capacity") return "Selected model is at capacity. Please try a different model."

  return 'network error: ECONNRESET {"status":503} at provider.connect (transport.ts:42)'
}
