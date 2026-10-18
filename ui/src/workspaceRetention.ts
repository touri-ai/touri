import type { Message, Run } from "@touri/contracts"
import { reconcileApprovalMessages } from "./approvalState"
import type { WorkspaceData } from "./useWorkspace"

/** Match the workspace activity snapshot; full prose and tool output belong to the open transcript. */
export const activityMessage = (message: Message): Message => ({
  ...message,
  text: message.text.slice(0, 512),
  parts: message.parts.filter((part) => part.type === "approval" || part.type === "notice"),
})

const pending = (message: Message): boolean =>
  message.parts.some((part) => part.type === "approval" && part.decision === "pending") ||
  (message.delivery != null && message.delivery.status !== "acked")

/** Five sidebar slots per thread, plus outstanding requests and streams. Never cap pending approvals. */
const retainActivity = (messages: Message[]): Message[] => {
  const threads = new Map<string, Message[]>()
  for (const message of messages) {
    const rows = threads.get(message.threadId) ?? []
    rows.push(message)
    threads.set(message.threadId, rows)
  }
  const kept = new Set<Message>()
  for (const rows of threads.values()) {
    const created = [...rows].sort((a, b) => b.createdAt - a.createdAt || b.updatedAt - a.updatedAt)
    const updated = [...rows].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
    for (const row of [
      created.find(
        (message) =>
          message.text.trim() || message.parts.length || message.status === "failed" || message.status === "canceled",
      ),
      created.find((message) => message.role === "assistant"),
      updated.find((message) => message.role === "assistant"),
      updated.find((message) => message.role === "assistant" && message.status !== "streaming"),
      updated.find((message) => message.role === "assistant" && message.status === "complete"),
      ...rows.filter((message) => pending(message) || message.status === "streaming"),
    ])
      if (row) kept.add(row)
  }
  return [...kept]
}

export const activeRun = (run: Run): boolean => ["queued", "starting", "running"].includes(run.status)

/** Full runs for the open conversation, live runs everywhere, and the latest run per other thread. */
const retainRuns = (runs: Run[], selectedThreadId: string | null): Run[] => {
  const latest = new Map<string, Run>()
  for (const run of runs) {
    const previous = latest.get(run.threadId)
    if (!previous || run.queuedAt >= previous.queuedAt) latest.set(run.threadId, run)
  }
  return runs.filter((run) => run.threadId === selectedThreadId || activeRun(run) || latest.get(run.threadId) === run)
}

/** Client eviction only. Every conversation is fetched again after leaving it. */
export const retainWorkspace = (data: WorkspaceData): WorkspaceData => {
  const offscreen = data.messages.filter((message) => message.threadId !== data.selectedThreadId)
  const rows = new Map<string, Message>()
  for (const message of [...data.activityMessages, ...offscreen]) {
    const key = JSON.stringify([message.threadId, message.id])
    const previous = rows.get(key)
    if (
      previous &&
      ((previous.updatedSeq ?? 0) > (message.updatedSeq ?? 0) ||
        ((previous.updatedSeq ?? 0) === (message.updatedSeq ?? 0) && previous.updatedAt > message.updatedAt))
    )
      continue
    rows.set(key, activityMessage(message))
  }
  return {
    ...data,
    messages: offscreen.length
      ? data.messages.filter((message) => message.threadId === data.selectedThreadId)
      : data.messages,
    activityMessages: retainActivity(reconcileApprovalMessages([...rows.values()], data.notifications)),
    runs: retainRuns(data.runs, data.selectedThreadId),
  }
}
