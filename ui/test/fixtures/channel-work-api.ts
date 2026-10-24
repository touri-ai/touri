import type { ApiRoutes, BotGroup, Run } from "@touri/contracts"
import type { UiApi } from "../../src/api/client"
import { createWorkApi } from "./work-api"

export const createChannelWorkApi = () => {
  const base = createWorkApi()
  const template = base.getRuns()[0]
  const thread = base.threads[0]
  if (!template || !thread) throw new Error("Missing active work fixture")
  const group: BotGroup = {
    id: "channel-team",
    name: "Equipe de demonstração",
    color: "#dc2626",
    avatarShape: "classic-none",
    avatarSeed: "channel-team",
    memberIds: [template.botId],
    coordinatorBotId: null,
    createdAt: 1,
    updatedAt: 1,
  }
  const channel = { ...thread, id: "channel-thread", title: group.name, groupId: group.id }
  const active: Run = { ...template, kind: "execution", groupThreadId: channel.id, groupTurnId: "channel-first" }
  const waiting: Run = {
    ...active,
    id: "channel-waiting",
    threadId: channel.id,
    groupThreadId: null,
    groupTurnId: undefined,
    kind: "coordination",
    status: "queued",
    startedAt: null,
    providerStartedAt: null,
    queuePosition: 1,
    queueTotal: 1,
  }
  let runs = [active, waiting]
  const request: UiApi["request"] = async (route, input, path = {}) => {
    if (route === "GET /groups") return { groups: [group] } as ApiRoutes[typeof route]["res"]
    if (route === "GET /groups/:id/threads") return { threads: [channel] } as ApiRoutes[typeof route]["res"]
    if (route === "GET /runs")
      return { runs: runs.filter((run) => run.status !== "succeeded") } as ApiRoutes[typeof route]["res"]
    if (route === "GET /workspace/activity") return { messages: [], runs } as ApiRoutes[typeof route]["res"]
    if (route === "POST /runs/:id/cancel") {
      const selected = runs.find((run) => run.id === path.id)
      if (!selected) throw new Error("Missing synthetic task")
      if ((input as ApiRoutes["POST /runs/:id/cancel"]["req"]).scope !== "turn")
        throw new Error("Expected single-turn cancellation")

      const canceled = Object.assign({}, selected, { status: "canceled" as const, finishedAt: Date.now() })
      runs = runs.map((run) => (run.id === canceled.id ? canceled : run))
      base.emit({ type: "run.updated", run: canceled })
      if (selected.id === active.id) finishFirst("canceled")

      return { run: canceled } as ApiRoutes[typeof route]["res"]
    }
    if (route === "GET /threads/:id/runs")
      return {
        runs: runs
          .filter((run) => run.threadId === path.id || run.groupThreadId === path.id)
          .map((run) => ({ ...run, threadId: path.id ?? run.threadId })),
      } as ApiRoutes[typeof route]["res"]

    return base.request(route, input, path)
  }
  const finishFirst = (status: "succeeded" | "canceled" = "succeeded") => {
    runs = [
      Object.assign({}, active, { status, finishedAt: Date.now() }),
      { ...waiting, status: "running", queuePosition: null, queueTotal: null },
      { ...active, id: "channel-execution", kind: "execution", groupTurnId: waiting.id },
    ]
    runs.forEach((run) => {
      base.emit({ type: "run.updated", run })
    })
  }

  return { ...base, request, finishFirst }
}
