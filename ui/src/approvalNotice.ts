import type { ApprovalPart, Message, NotificationRecord } from "@touri/contracts"
import { approvalSummary, isApprovalNoticeTitle } from "@touri/contracts/approval-summary"
import { redactToolText } from "@touri/contracts/redaction"

export const approvalNotificationSummary = (item: NotificationRecord, messages: Message[]) => {
  const message = messages.find(
    (message) =>
      message.threadId === item.threadId &&
      message.parts.some((part) => part.type === "approval" && part.approvalId === item.requestId),
  )
  const part = message?.parts.find(
    (part): part is ApprovalPart => part.type === "approval" && part.approvalId === item.requestId,
  )
  const legacy =
    item.title.includes(":") ||
    /Approve (?:action|command|file change)$/.test(item.title) ||
    /^\s*[{["]|^[\w.-]+:\s/.test(item.body)
  const summary =
    part || legacy || !isApprovalNoticeTitle(item.title)
      ? approvalSummary(
          part ?? {
            request: /command$/.test(item.title)
              ? "command"
              : /file change$/.test(item.title)
                ? "file_change"
                : "permission",
            detail: item.body,
          },
        )
      : { title: item.title, body: item.body }
  const detail = part?.detail ?? (legacy ? item.body : "")
  const isCommand = (part?.request ?? (/command$/.test(item.title) ? "command" : null)) === "command"
  const command = isCommand ? commandText(detail) : null
  const technical = redactToolText(detail)
  return { ...summary, command, technical: technical.trim() === command ? "" : technical }
}

// The bell is where people decide; show the command itself, never only a generic label.
const commandText = (detail: string): string | null => {
  let value: unknown
  try {
    value = JSON.parse(detail)
  } catch {
    // Older notifications carried the plain command as their body.
    return detail.trim() ? redactToolText(detail.trim()) : null
  }
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : null
  const command = record?.command ?? record?.cmd
  const text = Array.isArray(command) ? command.map(String).join(" ") : typeof command === "string" ? command : null
  return text ? redactToolText(text) : null
}
