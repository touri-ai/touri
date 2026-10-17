import type { MessagePart } from "@touri/contracts"
import { redactToolText } from "@touri/contracts/redaction"
import { type Locale, type TranslationKey, t } from "../i18n"
import { type MascotState, mascotIsBusy, mascotLabelFor } from "./mascotState"
import { approvalMatchesTool, toolLeaf, toolPresentation, toolStatus } from "./toolPresentation"

/** Keep the visible request and activity current while the server acknowledges a local answer. */
export const withApprovalAnswers = (
  parts: MessagePart[],
  answers: Record<string, "approved" | "denied">,
): MessagePart[] => {
  const answered = parts.map((part) =>
    part.type === "approval" && part.decision === "pending" && answers[part.approvalId]
      ? { ...part, decision: answers[part.approvalId] ?? part.decision }
      : part,
  )
  return answered.map((part) =>
    (part.type === "tool_call" || part.type === "command" || part.type === "file_change") &&
    answered.some(
      (approval) =>
        approval.type === "approval" && approval.decision === "denied" && approvalMatchesTool(approval, part),
    ) &&
    toolStatus(part) === "running"
      ? { ...part, resolution: "canceled" }
      : part,
  )
}

export type ActivityKind = "thinking" | "working" | "reading" | "searching" | "sending" | "waiting"
const activityKeys: Record<ActivityKind, TranslationKey> = {
  thinking: "Activity thinking",
  working: "Activity working",
  reading: "Activity reading",
  searching: "Activity searching",
  sending: "Activity sending",
  waiting: "Activity waiting",
}

const activeToolFor = (parts: readonly MessagePart[]) =>
  [...parts]
    .reverse()
    .find(
      (part) =>
        (part.type === "tool_call" || part.type === "command" || part.type === "file_change") &&
        toolStatus(part) === "running" &&
        !parts.some(
          (approval) =>
            approval.type === "approval" &&
            ["denied", "expired"].includes(approval.decision) &&
            approvalMatchesTool(approval, part),
        ),
    )

/** Describe the action, never a provider's internal tool name or arguments. */
export const activityKindFor = (state: MascotState, parts: readonly MessagePart[]): ActivityKind => {
  if (state === "waiting-approval") return "waiting"
  if (state === "thinking") return "thinking"
  if (state !== "working-tool") return "working"
  const tool = activeToolFor(parts)
  if (tool?.type !== "tool_call") return "working"
  const name = toolLeaf(tool.tool)
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
  if (/(?:^|_)(?:send|post|publish|upload)(?:_|$)/.test(name)) return "sending"
  if (/(?:^|_)(?:search|grep|glob|find)(?:_|$)/.test(name)) return "searching"
  if (/(?:^|_)(?:read|list|open|fetch|view|inspect)(?:_|$)/.test(name)) return "reading"
  return "working"
}

export const activityLabelFor = (
  state: MascotState,
  parts: readonly MessagePart[],
  locale: Locale = "pt-BR",
): string => {
  if (!mascotIsBusy(state) && state !== "waiting-approval") return mascotLabelFor(state, locale)
  const label = t(activityKeys[activityKindFor(state, parts)], {}, locale)
  if (state === "waiting-approval" || state === "typing") return label
  const tool = state === "working-tool" ? activeToolFor(parts) : undefined
  // A tool starting after reasoning makes that preview stale; a new reasoning part replaces it.
  const latest = [...parts]
    .reverse()
    .find((part) => ["reasoning", "text", "tool_call", "command", "file_change"].includes(part.type))
  if (latest?.type === "reasoning") {
    const sentence = redactToolText(latest.text)
      .replace(/\s+/g, " ")
      .trim()
      .split(/(?<=[.!?…])\s+/)
      .at(-1)
    if (sentence) return shortLabel(`${t(activityKeys.thinking, {}, locale)}: ${sentence}`)
    if (latest.estimatedTokens !== undefined) {
      const thinking = `${t(activityKeys.thinking, {}, locale)}…`
      return latest.estimatedTokens > 0 ? `${thinking} (~${latest.estimatedTokens} tokens)` : thinking
    }
  }
  if (tool && (tool.type === "tool_call" || tool.type === "command" || tool.type === "file_change")) {
    const path = toolPresentation(tool).filePaths[0]
    const file = path?.split(/[\\/]/).at(-1)
    if (file) return shortLabel(`${label} ${redactToolText(file)}`)
  }
  return label
}

const shortLabel = (label: string): string => {
  const line = label.replace(/\s+/g, " ").trim()
  return line.length > 160 ? `${line.slice(0, 159)}…` : line
}
