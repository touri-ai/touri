import type { Id, Message, Run } from "@touri/contracts"
import { resolvedApprovalLabel } from "./approvalState"
import { localizeNotice, t } from "./i18n"
import { markdownSummary } from "./markdownSummary"
import { getRoutineReplyRun, isRoutineEmptyResult } from "./routineConversation"
import { runErrorFor } from "./runError"

const PREVIEW_LIMIT = 90

/** Latest readable message across the given threads, newest first; empty string when none has any text. */
export const latestPreview = ({
  threadIds,
  messages,
  runs = [],
}: {
  threadIds: ReadonlyArray<Id>
  messages: ReadonlyArray<Message>
  runs?: ReadonlyArray<Run>
}): string => {
  const candidates = [...messages]
    .filter((message) => threadIds.includes(message.threadId))
    .sort((left, right) => right.createdAt - left.createdAt)
  const latest = candidates.find((message) => textOf(message, runs, messages).length > 0)
  return latest ? compact(textOf(latest, runs, messages)) : ""
}

const textOf = (message: Message, runs: ReadonlyArray<Run>, messages: ReadonlyArray<Message>): string => {
  if (message.status === "canceled") return t("Cancelado por você")
  const error = runErrorFor(message)
  if (error) return error.title
  if (message.role === "system") return localizeNotice(message.text)
  const routineResult = getRoutineEmptyResultPreview(message, runs, messages)
  if (routineResult) return routineResult
  if (message.text.trim()) return message.text
  const text = message.parts.find((part) => part.type === "text" && part.text.trim())
  if (text?.type === "text") return text.text
  const approval = [...message.parts].reverse().find((part) => part.type === "approval")
  if (approval?.type === "approval") {
    if (approval.decision === "pending") return "Aguardando sua aprovação"
    const label = resolvedApprovalLabel(approval.decision)
    return approval.resolvedAt === undefined
      ? label
      : `${label} · ${new Date(approval.resolvedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`
  }
  const notice = message.parts.find((part) => part.type === "notice" && part.text.trim())
  return notice?.type === "notice" ? localizeNotice(notice.text) : ""
}

const getRoutineEmptyResultPreview = (
  message: Message,
  runs: ReadonlyArray<Run>,
  messages: ReadonlyArray<Message>,
): string | undefined => {
  if (message.role !== "assistant" || message.status !== "complete") return undefined
  if (!getRoutineReplyRun(message, runs, messages)) return undefined

  if (!isRoutineEmptyResult(getFinalAssistantText(message))) return undefined

  return t("Sem novidades nesta execução")
}

const getFinalAssistantText = (message: Message): string => {
  const textParts = message.parts.filter((part) => part.type === "text")
  if (!textParts.length) return message.text
  if (textParts.length === 1) return message.text.trim() || (textParts[0]?.type === "text" ? textParts[0].text : "")

  let finalText = ""
  let finalTextParts = 0
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index]
    if (!part) continue
    if (part.type !== "text") {
      if (finalTextParts) break
      continue
    }

    finalText = finalTextParts ? `${part.text}\n\n${finalText}` : part.text
    finalTextParts += 1
  }
  return finalText
}

const compact = (value: string): string => {
  const flat = markdownSummary(value)
  return flat.length > PREVIEW_LIMIT ? `${flat.slice(0, PREVIEW_LIMIT - 1)}…` : flat
}
