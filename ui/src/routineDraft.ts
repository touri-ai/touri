import type { ApiRoutes, Bot, Message, Routine, Thread } from "@touri/contracts"
import { getJobTemplates } from "./features/jobs/catalog"
import { t } from "./i18n"
import { messageMarkdown } from "./messageMarkdown"

export type RoutineDraft = ApiRoutes["POST /routines"]["req"]

export const newRoutineDraft = (botId: string): RoutineDraft => ({
  botId,
  name: t("Nova rotina"),
  prompt: "",
  cron: "0 9 * * 1-5",
  timezone: "America/Sao_Paulo",
  enabled: false,
  continuity: "main-thread",
  resultsThreadId: null,
  timeoutMinutes: 30,
  overlap: "skip",
  catchUpMinutes: 30,
})

/** Reuse the conversation and the bot's existing access; never grant new access. */
export const repeatTaskDraft = (bot: Bot, thread: Thread, messages: Message[]): RoutineDraft | null => {
  const reply = [...messages]
    .reverse()
    .find((message) => message.role === "assistant" && message.status === "complete" && messageMarkdown(message).trim())
  const replyIndex = reply ? messages.indexOf(reply) : -1
  if (replyIndex < 0) return null
  const request = messages
    .slice(0, replyIndex)
    .reverse()
    .find((message) => message.role === "user")
  if (!request) return null
  const prompt = messageMarkdown(request).trim()
  if (!prompt || prompt.length > 8000) return null
  return {
    ...newRoutineDraft(bot.id),
    name: (thread.title || prompt).slice(0, 80),
    prompt,
    continuity: "results-thread",
    resultsThreadId: thread.id,
  }
}

export const draftFromRoutine = (routine: Routine): RoutineDraft => {
  const { id: _id, nextRunAt: _next, source: _source, createdAt: _created, updatedAt: _updated, ...draft } = routine
  return draft
}

/** A template suggests a schedule only; choosing a job never persists a routine. */
export const suggestedRoutineDraft = (bot: Bot): RoutineDraft | null => {
  const template = getJobTemplates().find(
    (job) => job.suggestedCron && job.roleLine === bot.roleLine && job.instructions === bot.instructions,
  )
  return template?.suggestedCron
    ? { ...newRoutineDraft(bot.id), name: template.name, prompt: template.instructions, cron: template.suggestedCron }
    : null
}
