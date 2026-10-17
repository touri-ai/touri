import type { Id, Message } from "@touri/contracts"

export type ApprovalTarget = { threadId: Id; approvalId: Id }
export type ApprovalFocus = { approvalId: Id; request: number }

export const pendingApprovalTargets = (messages: Array<Message>): Array<ApprovalTarget> => {
  const requests = new Map<string, ApprovalTarget>()
  for (const message of messages)
    for (const part of message.parts)
      if (part.type === "approval" && part.decision === "pending")
        requests.set(JSON.stringify([message.threadId, part.approvalId]), {
          threadId: message.threadId,
          approvalId: part.approvalId,
        })
  return [...requests.values()]
}
