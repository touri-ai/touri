import type { Message, NotificationRecord, Run, UiEvent } from "@touri/contracts"

type StreamEvent = Extract<UiEvent, { type: "message.delta" | "message.parts" }>

/** A slow history request must not turn its overlap/replay buffer into another transcript. */
export class TranscriptBuffer {
  events: StreamEvent[] = []
  overflow = false
  private bytes = 0
  push(event: StreamEvent): void {
    if (this.overflow) return
    const bytes = JSON.stringify(event).length * 2
    if (this.events.length >= 512 || this.bytes + bytes > 2 * 1024 * 1024) {
      this.events = []
      this.bytes = 0
      this.overflow = true
      return
    }
    this.bytes += bytes
    this.events.push(event)
  }
}

/** Match the bounded activity projection: previews and attention, never tool output or history. */
export const activitySummary = (message: Message): Message => ({
  ...message,
  text: message.text.slice(0, 512),
  parts: message.parts.filter((part) => part.type === "approval" || part.type === "notice"),
})

export const retainActivity = (messages: Message[], notifications: NotificationRecord[]): Message[] => {
  const threads = new Map<string, Message[]>()
  const requests = new Set(notifications.filter((item) => item.resolvedAt === null).map((item) => item.requestId))
  for (const message of messages) {
    const rows = threads.get(message.threadId) ?? []
    rows.push(message)
    threads.set(message.threadId, rows)
  }
  return [...threads.values()].flatMap((rows) => {
    const keep = new Set<Message>()
    const newest = (candidates: Message[], updated = false) => {
      const latest = candidates.reduce<Message | undefined>((previous, row) => {
        const at = updated ? row.updatedAt : row.createdAt
        const before = previous ? (updated ? previous.updatedAt : previous.createdAt) : -Infinity
        return at >= before ? row : previous
      }, undefined)
      if (latest) keep.add(latest)
    }
    newest(
      rows.filter((row) => row.text.trim() || row.status === "failed" || row.status === "canceled" || row.parts.length),
    )
    const assistants = rows.filter((row) => row.role === "assistant")
    newest(assistants)
    newest(assistants, true)
    newest(
      assistants.filter((row) => row.status !== "streaming"),
      true,
    )
    newest(
      assistants.filter((row) => row.status === "complete"),
      true,
    )
    for (const row of rows)
      if (
        row.parts.some(
          (part) => part.type === "approval" && (part.decision === "pending" || requests.has(part.approvalId)),
        )
      )
        keep.add(row)
    return [...keep]
  })
}

export const retainRuns = (runs: Run[], selectedThreadId: string | null): Run[] => {
  const latest = new Map<string, Run>()
  for (const run of runs) {
    const previous = latest.get(run.threadId)
    if (!previous || run.queuedAt >= previous.queuedAt) latest.set(run.threadId, run)
  }
  return runs.filter(
    (run) =>
      run.threadId === selectedThreadId ||
      ["queued", "starting", "running"].includes(run.status) ||
      latest.get(run.threadId) === run,
  )
}

/** Background deltas update only the preview and attention; positional transcript parts stay on the server. */
export const updateActivityStream = (
  messages: Message[],
  event: Extract<UiEvent, { type: "message.delta" | "message.parts" }>,
): Message[] =>
  messages.map((message) => {
    if (message.id !== event.messageId || message.threadId !== event.threadId || message.status !== "streaming")
      return message
    if (event.updatedSeq !== undefined && event.updatedSeq <= (message.updatedSeq ?? 0)) return message
    if (event.generation !== undefined && event.generation < (message.generation ?? 0)) return message
    let text = message.text
    let parts = message.parts
    if (event.type === "message.delta" && event.partType !== "reasoning") {
      // Revisions already reject replay; offsets address individual parts, not the combined preview.
      const suffix =
        event.updatedSeq !== undefined || event.offset === undefined
          ? event.delta
          : event.delta.slice(Math.max(0, text.length - event.offset))
      text = (text + suffix).slice(0, 512)
    }
    if (event.type === "message.parts") {
      for (const { part } of event.parts) {
        if (part.type !== "approval" && part.type !== "notice") continue
        parts = [
          ...parts.filter((old) =>
            part.type === "approval"
              ? !(old.type === "approval" && old.approvalId === part.approvalId)
              : !(old.type === "notice" && old.code === part.code),
          ),
          part.type === "approval" && part.decision === "pending"
            ? (parts.find(
                (old) => old.type === "approval" && old.approvalId === part.approvalId && old.decision !== "pending",
              ) ?? part)
            : part,
        ]
      }
    }
    return {
      ...message,
      text,
      parts,
      updatedAt: event.updatedAt ?? message.updatedAt,
      ...(event.updatedSeq !== undefined ? { updatedSeq: event.updatedSeq } : {}),
      ...(event.generation !== undefined ? { generation: event.generation } : {}),
    }
  })
