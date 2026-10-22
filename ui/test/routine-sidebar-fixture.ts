import type { Message, RoutineRun, Thread } from "@touri/contracts"
import { createMockApi } from "../src/api/mock"

export const getRoutineSidebarFixture = async (
  runCount = 28,
  { withOtherRoutines = false, unreadRuns = 0, withoutRoutineMetadata = false, todayRuns = false } = {},
) => {
  const api = createMockApi()
  const state = api.getState()
  const baseThread = state.threads.find((thread) => thread.id === "thread-mark")
  const baseMessage = state.messages[0]
  const { routines } = await api.request("GET /routines", {})
  const baseRoutine = routines[0]
  const otherBot = state.bots.find((bot) => bot.id !== baseThread?.botId)
  if (!baseThread || !baseMessage || !baseRoutine || !otherBot) throw new Error("Missing routine fixture")

  const routine = { ...baseRoutine, name: "Resumo diário", cron: "*/15 * * * *", continuity: "new-thread" as const }
  const otherRoutines = withOtherRoutines
    ? [
        { ...routine, id: "another-routine", name: "Outras notícias" },
        { ...routine, id: "other-bot-routine", botId: otherBot.id, name: "Resumo de outro bot" },
      ]
    : []
  const fixtureRoutines = [routine, ...otherRoutines]
  const routineRuns = [
    ...getFixtureRuns(routine.id, runCount, "sidebar", 18, todayRuns ? Date.now() : undefined),
    ...otherRoutines.flatMap((routine) =>
      getFixtureRuns(routine.id, 80, routine.id, 22, todayRuns ? Date.now() : undefined),
    ),
  ]
  const threads: Thread[] = [
    { ...baseThread, title: "Planejamento da semana", updatedAt: new Date(2026, 9, 18, 7).getTime() },
    ...routineRuns.map((run, index) => ({
      ...baseThread,
      botId: fixtureRoutines.find((routine) => routine.id === run.routineId)?.botId ?? baseThread.botId,
      id: run.threadId ?? run.id,
      kind: "routine" as const,
      title: `${fixtureRoutines.find((routine) => routine.id === run.routineId)?.name} · ${new Date(run.scheduledFor).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" })}`,
      routineRunId: run.id,
      createdAt: run.scheduledFor,
      updatedAt: run.finishedAt ?? run.scheduledFor,
      unread: index < unreadRuns ? 1 : 0,
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
    if (route === "GET /routines")
      return { routines: withoutRoutineMetadata ? [] : fixtureRoutines, host: "mac" } as never
    if (route === "GET /routine-runs") return { routineRuns: withoutRoutineMetadata ? [] : routineRuns } as never
    if (route === "GET /bots/:id/threads" && fixtureRoutines.some((routine) => routine.botId === path?.id))
      return { threads: threads.filter((thread) => thread.botId === path?.id) } as never
    if (route === "GET /threads/:id/messages" && threads.some((thread) => thread.id === path?.id))
      return {
        messages: messages.filter((message) => message.threadId === path?.id),
        activeLeafId: threads.find((thread) => thread.id === path?.id)?.activeLeafId ?? null,
      } as never

    return api.request(route, input, path)
  }

  return { api: { ...api, request }, threads, routineRuns, routines: fixtureRoutines }
}

const getFixtureRuns = (
  routineId: string,
  count: number,
  prefix: string,
  day: number,
  todayTimestamp?: number,
): RoutineRun[] =>
  Array.from({ length: count }, (_, index) => {
    const scheduledFor = todayTimestamp
      ? todayTimestamp - (count - index - 1) * 1000
      : new Date(2026, 9, day, 8, index * 15).getTime()

    return {
      id: `${prefix}-run-${index}`,
      routineId,
      scheduledFor,
      status: "succeeded",
      threadId: `${prefix}-thread-${index}`,
      runId: null,
      triggerSource: "cron",
      summary: "Resumo pronto para conferir.",
      startedAt: scheduledFor,
      finishedAt: scheduledFor + 30_000,
    }
  })
