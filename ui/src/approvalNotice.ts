import type { ApprovalPart, Message, NotificationRecord } from "@touri/contracts"
import { approvalSummary, isApprovalNoticeTitle } from "@touri/contracts/approval-summary"
import { redactToolText } from "@touri/contracts/redaction"

export const approvalNotificationSummary = (item: NotificationRecord, messages: Message[]) => {
  const message = messages.find((message) =>
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
  return { ...summary, technical: redactToolText(part?.detail ?? (legacy ? item.body : "")) }
}
