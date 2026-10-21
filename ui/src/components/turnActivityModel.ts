import type { ApprovalPart, Message, MessagePart, Run } from "@touri/contracts"
import { type Locale, type TranslationKey, t } from "../i18n"
import { messageMarkdown } from "../messageMarkdown"
import { approvalMatchesTool, type ToolPart, toolIdentity, toolLeaf } from "./toolPresentation"

export const isActivityTool = (part: MessagePart): part is ToolPart =>
  part.type === "tool_call" || part.type === "command" || part.type === "file_change"

export type ActivityGroupKind = "reads" | "commands" | "searches" | "edits" | "other"
export const activityGroupLabels: Record<ActivityGroupKind, TranslationKey> = {
  reads: "Arquivos lidos",
  commands: "Comandos",
  searches: "Buscas",
  edits: "Edições",
  other: "Outras ações",
}

const groupKind = (tool: ToolPart): ActivityGroupKind => {
  if (tool.type === "command") return "commands"
  if (tool.type === "file_change") return "edits"
  const name = toolLeaf(tool.tool)
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
  if (/(?:^|_)(?:edit|write|patch|apply_patch|multi_edit|multiedit|file_change)(?:_|$)/.test(name)) return "edits"
  if (/(?:^|_)(?:search|grep|glob|find)(?:_|$)/.test(name)) return "searches"
  if (/(?:^|_)(?:read|list|open_file|view_file|read_file)(?:_|$)/.test(name)) return "reads"
  if (/^(?:bash|powershell|shell|terminal|exec|exec_command|run_command|command)$/.test(name)) return "commands"
  return "other"
}

/** One entry per call; later snapshots update its result without inflating the action count. */
export const activityTools = (parts: readonly MessagePart[]): ToolPart[] => [
  ...new Map(parts.filter(isActivityTool).map((part) => [part.callId, part])).values(),
]

export const activityGroups = (tools: readonly ToolPart[]) =>
  (Object.keys(activityGroupLabels) as ActivityGroupKind[]).flatMap((kind) => {
    const entries = tools.filter((tool) => groupKind(tool) === kind)
    return entries.length ? [{ kind, tools: entries }] : []
  })

/** Approval decisions stay on their own visible cards, including after resolution. */
export const approvalTools = (parts: readonly MessagePart[]): Map<string, ToolPart> => {
  const available = activityTools(parts)
  const matched = new Set<string>()
  const result = new Map<string, ToolPart>()
  for (const part of parts) {
    if (part.type !== "approval") continue
    const tool = available.find((candidate) => !matched.has(candidate.callId) && approvalMatchesTool(part, candidate))
    if (tool) {
      matched.add(tool.callId)
      result.set(part.approvalId, tool)
    }
  }
  return result
}

export const activitySummary = (
  message: Pick<Message, "createdAt" | "updatedAt" | "parts">,
  run?: Run,
  locale: Locale = "pt-BR",
): string => {
  const count = activityTools(message.parts).length
  const start = run?.providerStartedAt ?? run?.startedAt ?? message.createdAt
  const seconds = Math.max(0, Math.floor(((run?.finishedAt ?? message.updatedAt) - start) / 1000))
  const duration =
    seconds >= 3600
      ? t("{count} h", { count: Math.floor(seconds / 3600) }, locale)
      : seconds >= 60
        ? t("{count} min", { count: Math.floor(seconds / 60) }, locale)
        : t("{count} s", { count: seconds }, locale)
  const label = seconds > 0 ? t("Trabalhou por {duration}", { duration }, locale) : t("Atividade", {}, locale)
  return count ? `${label} · ${t(count === 1 ? "{count} ação" : "{count} ações", { count }, locale)}` : label
}

export type AssistantSegment =
  | { type: "activity"; key: string }
  | { type: "text"; key: string; text: string }
  | { type: "browser-steps"; key: string; count: number }
  | { type: "approval"; key: string; part: ApprovalPart }
  | { type: "attachments"; key: string; parts: Extract<MessagePart, { type: "image" | "file" }>[] }

/** A display projection only: prose and approval positions never change in persisted history. */
export const assistantSegments = (message: Message): AssistantSegment[] => {
  const segments: AssistantSegment[] = []
  let activity = false
  let textParts: MessagePart[] = []
  let textStart = 0
  let browserCalls = new Set<string>()
  let stepCount = 0
  const hasText = message.parts.some((part) => part.type === "text" && part.text.trim())
  const flushSteps = (key: number) => {
    if (stepCount) segments.push({ type: "browser-steps", key: `steps-${key}`, count: stepCount })
    stepCount = 0
  }
  const flushText = () => {
    if (!textParts.length) return
    flushSteps(textStart)
    const text = messageMarkdown({ role: "assistant", text: "", parts: textParts })
    if (text.trim()) segments.push({ type: "text", key: `text-${textStart}`, text })
    textParts = []
  }
  for (const [index, part] of message.parts.entries()) {
    if (part.type === "text") {
      if (!textParts.length) textStart = index
      textParts.push(part)
      continue
    }
    // Reasoning and tool boundaries must not flatten separate answer paragraphs.
    flushText()
    if (part.type === "tool_call" && toolIdentity(part.tool).kind === "browser" && !browserCalls.has(part.callId)) {
      browserCalls = new Set([...browserCalls, part.callId])
      stepCount += 1
    }
    if (part.type === "approval") segments.push({ type: "approval", key: part.approvalId, part })
    else if (part.type === "image" || part.type === "file")
      segments.push({ type: "attachments", key: `attachment-${index}`, parts: [part] })
    else if (!activity && (isActivityTool(part) || (part.type === "reasoning" && part.text.trim()))) {
      segments.push({ type: "activity", key: "activity" })
      activity = true
    }
  }
  flushText()
  flushSteps(message.parts.length)
  if (message.parts.filter((part) => part.type === "text").length === 1 && hasText && message.text.trim()) {
    const saved = segments.find((segment) => segment.type === "text")
    if (saved?.type === "text") saved.text = messageMarkdown(message)
  }
  // Older transcripts sometimes keep the final answer only in the cached text field.
  if (!hasText && message.text.trim())
    segments.push({ type: "text", key: "saved-answer", text: messageMarkdown(message) })
  if (!activity && message.status === "streaming") segments.push({ type: "activity", key: "activity" })
  return segments
}
