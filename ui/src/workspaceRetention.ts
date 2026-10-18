import type { Message, Run } from "@touri/contracts"
import { reconcileApprovalMessages } from "./approvalState"
import type { WorkspaceData } from "./useWorkspace"

/** Client eviction only. Every conversation is fetched again after leaving it. */
export const retainWorkspace = (data: WorkspaceData, previous?: WorkspaceData): WorkspaceData => {
  const switched = data.selectedThreadId !== previous?.selectedThreadId
  if (
    previous &&
    !switched &&
    data.messages.length === previous.messages.length &&
    data.activityMessages === previous.activityMessages &&
    data.runs === previous.runs &&
    data.notifications === previous.notifications
  )
    return data

  const offscreen =
    !switched && data.messages === previous?.messages
      ? []
      : data.messages.filter((message) => message.threadId !== data.selectedThreadId)
  const summaries = offscreen.length ? getActivityRows(data.activityMessages, offscreen) : data.activityMessages
  const reconciled =
    summaries === previous?.activityMessages && data.notifications === previous?.notifications
      ? summaries
      : reconcileApprovalMessages(summaries, data.notifications)
  const runRetentionChanged = hasRunRetentionChanged(data.runs, previous?.runs, data.selectedThreadId)
  const activityMessages =
    hasActivityRetentionChanged(reconciled, previous?.activityMessages) || switched || runRetentionChanged
      ? getRetainedActivity(reconciled, data.runs)
      : reconciled
  const runs = switched || runRetentionChanged ? getRetainedRuns(data.runs, data.selectedThreadId) : data.runs
  const messages = offscreen.length
    ? data.messages.filter((message) => message.threadId === data.selectedThreadId)
    : data.messages
  if (messages === data.messages && activityMessages === data.activityMessages && runs === data.runs) return data

  return { ...data, messages, activityMessages, runs }
}

/** Match the activity snapshot; full prose and tool output belong to the open transcript. */
export const activityMessage = (message: Message): Message => {
  const hasOnlyAttention = message.parts.every((part) => part.type === "approval" || part.type === "notice")
  if (message.text.length <= 512 && hasOnlyAttention) return message

  return {
    ...message,
    text: message.text.slice(0, 512),
    parts: hasOnlyAttention
      ? message.parts
      : message.parts.filter((part) => part.type === "approval" || part.type === "notice"),
  }
}

export const activeRun = (run: Run): boolean => ["queued", "starting", "running"].includes(run.status)

const isPendingActivity = (message: Message): boolean =>
  message.parts.some((part) => part.type === "approval" && part.decision === "pending") ||
  (message.delivery != null && message.delivery.status !== "acked")

const hasActivityRetentionChanged = (messages: Message[], previous?: Message[]): boolean =>
  messages !== previous &&
  (!previous ||
    messages.length !== previous.length ||
    messages.some((message, index) => {
      const before = previous[index]
      return (
        !before ||
        message.id !== before.id ||
        message.threadId !== before.threadId ||
        isPendingActivity(message) !== isPendingActivity(before) ||
        (message.status === "streaming") !== (before.status === "streaming")
      )
    }))

const hasRunRetentionChanged = (runs: Run[], previous: Run[] | undefined, selectedThreadId: string | null): boolean => {
  if (runs === previous) return false
  if (!previous || runs.length !== previous.length) return true

  return runs.some((run, index) => {
    const before = previous[index]
    if (!before || run.id !== before.id || run.threadId !== before.threadId) return true
    if (run.threadId === selectedThreadId) return false

    return activeRun(run) !== activeRun(before)
  })
}

/** Five sidebar slots per thread, plus outstanding requests and streams. */
const getRetainedActivity = (messages: Message[], runs: Run[]): Message[] => {
  // Local buckets avoid repeatedly copying the bounded activity collection during pruning.
  const threads = new Map<string, Message[]>()
  messages.forEach((message) => {
    const rows = threads.get(message.threadId) ?? []
    rows.push(message)
    threads.set(message.threadId, rows)
  })
  if ([...threads.values()].every((rows) => rows.length <= 5)) return messages

  const liveRuns = new Set(runs.filter(activeRun).map((run) => run.id))
  const kept = new Set([...threads.values()].flatMap((rows) => getThreadActivity(rows, liveRuns)))
  const retained = messages.filter((message) => kept.has(message))
  return retained.length === messages.length ? messages : retained
}

const getThreadActivity = (messages: Message[], liveRuns: Set<string>): Message[] => {
  if (messages.length <= 5) return messages

  const assistants = messages.filter((message) => message.role === "assistant")
  return [
    getNewestMessage(
      messages.filter(
        (message) =>
          message.text.trim() || message.parts.length || message.status === "failed" || message.status === "canceled",
      ),
    ),
    getNewestMessage(assistants),
    getNewestMessage(assistants, true),
    getNewestMessage(
      assistants.filter((message) => message.status !== "streaming"),
      true,
    ),
    getNewestMessage(
      assistants.filter((message) => message.status === "complete"),
      true,
    ),
    ...messages.filter(
      (message) =>
        isPendingActivity(message) ||
        (message.status === "streaming" && !!message.runId && liveRuns.has(message.runId)),
    ),
  ].filter((message): message is Message => !!message)
}

const getNewestMessage = (messages: Message[], updated = false): Message | undefined =>
  messages.reduce<Message | undefined>((latest, message) => {
    if (!latest) return message

    const order = updated ? message.updatedAt - latest.updatedAt : message.createdAt - latest.createdAt
    const tie = updated ? message.createdAt - latest.createdAt : message.updatedAt - latest.updatedAt
    return order > 0 || (order === 0 && tie > 0) ? message : latest
  }, undefined)

const getRetainedRuns = (runs: Run[], selectedThreadId: string | null): Run[] => {
  // A local index keeps pruning linear without copying a map for every run.
  const latest = new Map<string, Run>()
  runs.forEach((run) => {
    const previous = latest.get(run.threadId)
    if (!previous || run.queuedAt >= previous.queuedAt) latest.set(run.threadId, run)
  })
  const retained = runs.filter(
    (run) => run.threadId === selectedThreadId || activeRun(run) || latest.get(run.threadId) === run,
  )
  return retained.length === runs.length ? runs : retained
}

const getActivityRows = (messages: Message[], offscreen: Message[]): Message[] => {
  // Merge only on eviction; the local index preserves newer summaries without a quadratic scan.
  const rows = new Map(messages.map((message) => [getMessageKey(message), message]))
  offscreen.forEach((message) => {
    const key = getMessageKey(message)
    const previous = rows.get(key)
    if (
      previous &&
      ((previous.updatedSeq ?? 0) > (message.updatedSeq ?? 0) ||
        ((previous.updatedSeq ?? 0) === (message.updatedSeq ?? 0) && previous.updatedAt > message.updatedAt))
    )
      return

    rows.set(key, activityMessage(message))
  })
  return [...rows.values()]
}

const getMessageKey = (message: Message): string => JSON.stringify([message.threadId, message.id])
