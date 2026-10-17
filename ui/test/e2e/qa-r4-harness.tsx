import type { Run } from "@touri/contracts"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import type { ApiRequest } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"
import "../../src/styles.css"

const api = createMockApi()
const scenario = new URLSearchParams(location.search).get("scenario")
const bot = api.getState().bots.find((item) => item.id === "bot-mark")
if (!bot) throw new Error("Missing QA bot")
bot.machine = "vm"
bot.browserEnabled = scenario !== "disabled"
bot.computerUse = scenario !== "disabled"
bot.projectId = null
const request = api.request
let session = 0
let humanControl = false
const failure =
  scenario === "attention"
    ? api.notify({
        kind: "turn-failed",
        botId: bot.id,
        threadId: "thread-mark",
        title: "Resposta interrompida",
        body: "Revise a tarefa interrompida.",
        createdAt: Date.now() - 1_000,
      })
    : null
const completed: Run | null = failure
  ? {
      id: "qa-success",
      botId: bot.id,
      threadId: "thread-mark",
      provider: bot.provider,
      trigger: "user",
      status: "succeeded",
      queuedAt: failure.createdAt - 100,
      startedAt: failure.createdAt - 50,
      finishedAt: failure.createdAt + 500,
      requestMessageId: null,
      replyMessageId: null,
      externalTurnId: null,
      routineRunId: null,
      errorClass: null,
      errorMessage: null,
      usage: null,
    }
  : null
api.isMock = false
api.websocketUrl = () => "ws://localhost/qa-screen"
api.request = (async (route, input, path) => {
  if (route === "GET /machines" || route === "POST /bots/:id/machine/intent") {
    const machine = {
      botId: bot.id,
      status: "running",
      progress: null,
      error: null,
      memoryMb: 2048,
      createdMs: null,
      startMs: null,
    }
    return route === "GET /machines"
      ? { capability: { available: true, reason: null, provider: "mock" }, machines: [machine] }
      : { machine }
  }
  if (scenario === "login" && route === "GET /bots/:id/provider-login/flow")
    return { provider: bot.provider, state: "waiting", deviceCode: "QA" }
  if (completed && route === "GET /workspace/activity") return { runs: [completed], messages: api.getState().messages }
  if (completed && route === "GET /threads/:id/runs") return { runs: [completed] }
  if (route === "POST /bots/:id/desktop") {
    session += 1
    if (scenario === "request-timeout" && session > 1) return new Promise(() => {})
    const control = (input as { control?: boolean }).control ?? false
    if (control) humanControl = true
    return { sessionId: `qa-${session}`, path: "/qa-screen", control, humanControl }
  }
  if (route === "POST /bots/:id/desktop/return") {
    humanControl = false
    return {}
  }
  if (route === "DELETE /desktop/:id") return {}
  return request(route, input, path)
}) as ApiRequest
Object.assign(window, { qaR4Api: api, qaVmFrame: "empty" })
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
