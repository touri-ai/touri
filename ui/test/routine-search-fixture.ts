import { createMockApi } from "../src/api/mock"

export const getRoutineSearchFixture = () => {
  const state = createMockApi().getState()
  const bot = state.bots[0]
  const original = state.threads.find((thread) => thread.botId === bot?.id)
  const message = state.messages[0]
  if (!bot || !original || !message) throw new Error("Missing synthetic search fixture")

  const thread = {
    ...original,
    id: "qa-routine-thread",
    kind: "chat" as const,
    title: "Checagem de QA no canal · 10/23/26, 2:00 AM",
    createdAt: Date.UTC(2026, 9, 23, 8),
    routineTitle: {
      sourceTitle: "Checagem de QA no canal · 10/23/26, 2:00 AM",
      name: "Checagem de QA no canal",
      scheduledFor: Date.UTC(2026, 9, 23, 5),
      timezone: "America/Sao_Paulo",
    },
  }

  return { bot, thread, message: { ...message, threadId: thread.id, text: "relatório sintético" } }
}
