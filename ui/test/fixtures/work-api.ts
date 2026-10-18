import type { ApiRoutes, Run } from "@touri/contracts"
import type { UiApi } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"

export const createWorkApi = () => {
  const base = createMockApi()
  const bot = base.getState().bots[0]
  const thread = base.getState().threads[0]
  if (!bot || !thread) throw new Error("Missing mock workspace")

  const bots = ["Planejamento", "Pesquisa", "Revisão", "Relatórios", "Organização"].map((name, index) => ({
    ...bot,
    id: `work-bot-${index}`,
    name,
    roleLine: "Equipe de demonstração",
    mainThreadId: `work-thread-${index}`,
    machine: "local" as const,
    computerUse: false,
    hostComputerUse: false,
  }))
  const threads = bots.map((bot, index) => ({
    ...thread,
    id: bot.mainThreadId ?? `work-thread-${index}`,
    botId: bot.id,
    title: `Tarefa de ${bot.name.toLocaleLowerCase("pt-BR")}`,
    activeLeafId: null,
    unread: 0,
  }))
  let runs: Run[] = bots.map((bot, index) => ({
    id: `work-run-${index}`,
    botId: bot.id,
    threadId: threads[index]?.id ?? "",
    provider: bot.provider,
    trigger: index === 1 ? "routine" : "user",
    origin: (["message", "routine", "delegation", "resume", "message"] as const)[index] ?? "message",
    status: index < 3 ? "running" : "queued",
    queuePosition: index < 3 ? null : index - 2,
    queueTotal: index < 3 ? null : 2,
    queuedAt: Date.now() - 120_000 + index * 1000,
    startedAt: index < 3 ? Date.now() - 90_000 : null,
    finishedAt: null,
    providerStartedAt: index < 3 ? Date.now() - 90_000 : null,
    requestMessageId: null,
    replyMessageId: null,
    externalTurnId: null,
    errorClass: null,
    errorMessage: null,
    usage: null,
    routineRunId: null,
  }))
  const request: UiApi["request"] = async (route, input, path = {}) => {
    const getResponse = (): unknown => {
      if (route === "GET /bots") return { bots }
      if (route === "GET /groups") return { groups: [] }
      if (route === "GET /bots/:id/threads") return { threads: threads.filter((thread) => thread.botId === path.id) }
      if (route === "GET /workspace/activity") return { messages: [], runs }
      if (route === "GET /runs") return { runs: runs.filter((run) => run.status !== "succeeded") }
      if (route === "GET /threads/:id/runs") return { runs: runs.filter((run) => run.threadId === path.id) }
      if (route === "GET /threads/:id/messages") return { messages: [] }
      return undefined
    }
    const response = getResponse()
    if (response !== undefined) return response as ApiRoutes[typeof route]["res"]

    return base.request(route, input, path)
  }
  const finishFirst = () => {
    runs = runs.map((run, index) => {
      if (index === 0) return { ...run, status: "succeeded", finishedAt: Date.now() }
      if (index === 3)
        return { ...run, status: "running", startedAt: Date.now(), queuePosition: null, queueTotal: null }
      if (index === 4) return { ...run, queuePosition: 1, queueTotal: 1 }
      return run
    })
    runs.forEach((run) => {
      base.emit({ type: "run.updated", run })
    })
  }

  return { ...base, request, finishFirst, bots, threads, getRuns: () => runs }
}
