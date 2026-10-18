import type { Message, RoutineRun, Thread } from "@touri/contracts"
import { createMockApi } from "../src/api/mock"

export const getRoutineSidebarFixture = async () => {
  const api = createMockApi()
  const state = api.getState()
  const baseThread = state.threads.find((thread) => thread.id === "thread-mark")
  const baseMessage = state.messages[0]
  const { routines } = await api.request("GET /routines", {})
  const baseRoutine = routines[0]
  if (!baseThread || !baseMessage || !baseRoutine) throw new Error("Missing routine fixture")

  const routine = { ...baseRoutine, name: "Resumo diário", cron: "*/15 * * * *", continuity: "new-thread" as const }
  const routineRuns: RoutineRun[] = Array.from({ length: 28 }, (_, index) => {
    const scheduledFor = new Date(2026, 9, 18, 8, index * 15).getTime()

    return {
      id: `sidebar-run-${index}`,
      routineId: routine.id,
      scheduledFor,
      status: "succeeded",
      threadId: `sidebar-thread-${index}`,
      runId: null,
      triggerSource: "cron",
      summary: "Resumo pronto para conferir.",
      startedAt: scheduledFor,
      finishedAt: scheduledFor + 30_000,
    }
  })
  const threads: Thread[] = [
    { ...baseThread, title: "Planejamento da semana", updatedAt: new Date(2026, 9, 18, 7).getTime() },
    ...routineRuns.map((run) => ({
      ...baseThread,
      id: run.threadId ?? run.id,
      kind: "routine" as const,
      title: `${routine.name} · ${new Date(run.scheduledFor).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" })}`,
      routineRunId: run.id,
      createdAt: run.scheduledFor,
      updatedAt: run.finishedAt ?? run.scheduledFor,
      unread: 0,
      activeLeafId: `sidebar-message-${run.id}`,
    })),
  ]
  const messages: Message[] = routineRuns.map((run) => ({
    ...baseMessage,
    id: `sidebar-message-${run.id}`,
    threadId: run.threadId ?? run.id,
    parentId: null,
    role: "assistant",
    text: "Resumo pronto para conferir.",
    parts: [{ type: "text", text: "Resumo pronto para conferir." }],
    status: "complete",
    createdAt: run.scheduledFor,
    updatedAt: run.finishedAt ?? run.scheduledFor,
  }))
  const request: typeof api.request = async (route, input, path) => {
    if (route === "GET /routines") return { routines: [routine], host: "mac" } as never
    if (route === "GET /routine-runs") return { routineRuns } as never
    if (route === "GET /bots/:id/threads" && path?.id === baseThread.botId) return { threads } as never
    if (route === "GET /threads/:id/messages" && threads.some((thread) => thread.id === path?.id))
      return {
        messages: messages.filter((message) => message.threadId === path?.id),
        activeLeafId: threads.find((thread) => thread.id === path?.id)?.activeLeafId ?? null,
      } as never

    return api.request(route, input, path)
  }

  return { api: { ...api, request }, threads, routineRuns }
}
