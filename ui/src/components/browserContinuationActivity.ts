import type { Id, Message, Run, ToolCallPart } from "@touri/contracts"
import { getBrowserActivityTools } from "./browserActivityPresentation"

export type BrowserContinuationActivity = {
  parts: ToolCallPart[]
  runId: Id
  finished: boolean
  queuedAt: number
}

type ActivityMessage = Pick<Message, "id" | "role" | "runId" | "parts">
type ActivityRun = Pick<Run, "id" | "status" | "queuedAt" | "browserTakeoverFromRunId">

export const getBrowserContinuationActivities = (
  messages: readonly ActivityMessage[],
  runs: readonly ActivityRun[],
) => {
  // Indexes stay local so streaming updates never copy or sort the growing transcript.
  const activities = new Map<Id, BrowserContinuationActivity>()
  const hidden = new Set<Id>()
  const continuations = runs.filter((run) => run.browserTakeoverFromRunId)
  if (continuations.length === 0) return { activities, hidden }

  const runsById = new Map(runs.map((run) => [run.id, run]))
  const messagesByRun = new Map(
    messages.flatMap((message) =>
      message.role === "assistant" && message.runId ? [[message.runId, message] as const] : [],
    ),
  )
  const roots = new Map(continuations.map((run) => [run.id, getRootRunId(run, runsById)]))
  const rootIds = new Set(roots.values())

  messages.forEach((message) => {
    if (message.role !== "assistant" || !message.runId) return
    const rootRunId = roots.get(message.runId) ?? message.runId
    if (!rootIds.has(rootRunId)) return
    const root = messagesByRun.get(rootRunId)
    if (!root || getBrowserActivityTools(root.parts).length === 0) return

    const previous = activities.get(root.id)
    const parts = getBrowserActivityTools(message.parts).map((part) => ({
      ...part,
      callId: `${message.runId}:${part.callId}`,
    }))
    activities.set(root.id, {
      parts: [...(previous?.parts ?? []), ...parts],
      runId: rootRunId,
      finished: true,
      queuedAt: 0,
    })
    if (message.id !== root.id) hidden.add(message.id)
  })
  continuations.forEach((run) => {
    const rootRunId = roots.get(run.id)
    const root = rootRunId ? messagesByRun.get(rootRunId) : undefined
    if (!root) return
    const previous = activities.get(root.id)
    if (!previous || previous.queuedAt > run.queuedAt) return

    activities.set(root.id, {
      ...previous,
      runId: run.id,
      finished: !["queued", "starting", "running"].includes(run.status),
      queuedAt: run.queuedAt,
    })
  })

  return { activities, hidden }
}

const getRootRunId = (run: ActivityRun, runs: ReadonlyMap<Id, ActivityRun>): Id | null => {
  let current = run.browserTakeoverFromRunId ?? run.id
  // A malformed or cyclic imported chain cannot make rendering unbounded.
  for (let depth = 0; depth < 32; depth += 1) {
    const previous = runs.get(current)?.browserTakeoverFromRunId
    if (!previous) return current
    current = previous
  }

  return null
}
