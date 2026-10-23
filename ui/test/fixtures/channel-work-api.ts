import type { ApiRoutes, Run } from "@touri/contracts"
import type { UiApi } from "../../src/api/client"
import { createWorkApi } from "./work-api"

export const createChannelWorkApi = () => {
  const base = createWorkApi()
  const active = base.getRuns()[0]
  if (!active) throw new Error("Missing active work fixture")
  const waiting: Run = {
    ...active,
    id: "channel-waiting",
    kind: "coordination",
    status: "queued",
    startedAt: null,
    providerStartedAt: null,
    queuePosition: 1,
    queueTotal: 1,
  }
  let runs = [active, waiting]
  const request: UiApi["request"] = async (route, input, path = {}) => {
    if (route === "GET /runs")
      return { runs: runs.filter((run) => run.status !== "succeeded") } as ApiRoutes[typeof route]["res"]
    if (route === "GET /workspace/activity") return { messages: [], runs } as ApiRoutes[typeof route]["res"]
    if (route === "GET /threads/:id/runs")
      return { runs: runs.filter((run) => run.threadId === path.id) } as ApiRoutes[typeof route]["res"]

    return base.request(route, input, path)
  }
  const finishFirst = () => {
    runs = [
      { ...active, status: "succeeded", finishedAt: Date.now() },
      { ...waiting, status: "running", queuePosition: null, queueTotal: null },
      { ...active, id: "channel-execution", kind: "execution", groupTurnId: waiting.id },
    ]
    runs.forEach((run) => {
      base.emit({ type: "run.updated", run })
    })
  }

  return { ...base, request, finishFirst }
}
