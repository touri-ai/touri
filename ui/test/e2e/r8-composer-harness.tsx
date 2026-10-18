import type { ApiRoutes, HostKind, Message, Run } from "@touri/contracts"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import type { ApiRequest } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"
import "../../src/styles.css"

const api = createMockApi()
const state = api.getState()
const bot = state.bots.find((item) => item.id === "bot-mark")
const thread = state.threads.find((item) => item.id === "thread-mark")
if (!bot || !thread) throw new Error("Conversa de QA ausente")
bot.name = "mark"
bot.title = "Planejamento"
bot.roleLine = "Planejamento e pesquisa"
bot.provider = "codex"
bot.model = "gpt-6.1-sol"
thread.title = "Planejar a próxima semana"
state.messages.splice(0, state.messages.length)
const view = new URLSearchParams(location.search).get("view")
const requestedHost = new URLSearchParams(location.search).get("host")
const host: HostKind = requestedHost === "mac" || requestedHost === "computer" ? requestedHost : "server"
const notice =
  view === "auth"
    ? "cli_auth: Entre no provedor para continuar."
    : view === "machine"
      ? "machine_service_unavailable: O serviço de máquinas está indisponível."
      : null
if (view === "machine") bot.machine = "vm"
const message: Message = {
  id: "composer-reply",
  threadId: thread.id,
  parentId: null,
  role: "assistant",
  kind: "text",
  status: notice ? "failed" : "complete",
  runId: null,
  text: notice
    ? ""
    : "Podemos organizar a semana por prioridades. Envie suas ideias e eu preparo um plano com os próximos passos.",
  parts: notice ? [{ type: "notice", level: "error", code: "run_failed", text: notice }] : [],
  sender: null,
  source: "local",
  createdAt: new Date("2026-10-13T14:30:00Z").getTime(),
  updatedAt: new Date("2026-10-13T14:30:00Z").getTime(),
}
if (!notice) message.parts = [{ type: "text", text: message.text }]
state.messages.push(message)
thread.activeLeafId = message.id
const fixtureRun: Run | null = ["running", "queued"].includes(view ?? "")
  ? {
      id: "composer-active-run",
      botId: bot.id,
      threadId: thread.id,
      provider: "codex",
      trigger: "user",
      requestMessageId: null,
      replyMessageId: null,
      externalTurnId: null,
      status: view === "queued" ? "queued" : "running",
      errorClass: null,
      errorMessage: null,
      usage: null,
      routineRunId: null,
      queuedAt: message.createdAt + 1000,
      startedAt: null,
      finishedAt: null,
    }
  : null
const request = api.request
const fixtureRequest: ApiRequest = async (route, input, pathValues) => {
  if (route === "GET /health")
    return { ok: true, version: "test", schemaVersion: 1, host } as ApiRoutes[typeof route]["res"]
  if (route === "GET /routines") {
    const response = await request(route, input, pathValues)

    return { ...response, host } as ApiRoutes[typeof route]["res"]
  }
  if (route === "GET /threads/:id/runs" && pathValues?.id === thread.id && fixtureRun)
    return { runs: [fixtureRun] } as ApiRoutes[typeof route]["res"]
  return request(route, input, pathValues)
}
api.request = fixtureRequest
Object.assign(window, { r8ComposerApi: api })
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
