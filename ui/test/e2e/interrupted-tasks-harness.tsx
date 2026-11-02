import type { RecoveryTask } from "@touri/contracts"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import type { ApiRequest } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"
import { installMotionTokens } from "../../src/design/spring"
import { initializeTheme } from "../../src/design/theme"
import { getTaskReviewHistory } from "../fixtures/taskReviewHistory"
import "../../src/styles.css"

const mock = createMockApi()
const state = mock.getState()
const bot = state.bots[0]
const thread = state.threads.find((candidate) => candidate.botId === bot?.id)
if (!bot || !thread) throw new Error("Missing synthetic conversation")

const { messages, run } = getTaskReviewHistory({
  threadId: thread.id,
  botId: bot.id,
  now: Date.now(),
  longHistory: true,
})
const notification = mock.notify({
  kind: "turn-failed",
  botId: bot.id,
  threadId: thread.id,
  title: "Tarefas interrompidas",
  body: "app_restart",
  requestId: `recovery:run:${run.id}`,
})
const task: RecoveryTask = {
  id: `run:${run.id}`,
  runId: run.id,
  routineId: null,
  cause: "app_restart",
  occurredAt: run.finishedAt ?? run.queuedAt,
  effects: [{ description: "review-notes.md", uncertain: false, acknowledgeKey: null }],
  notification,
}
const threads = state.threads.map((candidate) =>
  candidate.id === thread.id ? Object.assign({}, candidate, { activeLeafId: messages.at(-1)?.id ?? null }) : candidate,
)
const request: ApiRequest = async (route, input, path) => {
  if (route === "GET /bots/:id/threads" && path?.id === bot.id)
    return { threads: threads.filter((candidate) => candidate.botId === bot.id) } as never
  if (route === "GET /threads/:id/messages" && path?.id === thread.id)
    return { messages, activeLeafId: messages.at(-1)?.id ?? null } as never
  if (route === "GET /threads/:id/runs" && path?.id === thread.id) return { runs: [run] } as never
  if (route === "GET /workspace/activity") return { runs: [run], messages } as never
  if (route === "GET /recovery") return { tasks: [task] } as never

  return mock.request(route, input, path)
}
const api = Object.assign({}, mock, { request })
installMotionTokens(document.documentElement)
initializeTheme()
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
