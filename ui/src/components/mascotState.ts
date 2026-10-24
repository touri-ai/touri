import type { MachineState, Message, NotificationRecord, Run } from "@touri/contracts"
import type { AvatarMood } from "@touri/contracts/avatar"
import { isResolvedNotification } from "../approvalState"
import { type Locale, type TranslationKey, t } from "../i18n"

export type MascotState =
  | "idle"
  | "listening"
  | "typing"
  | "thinking"
  | "working-tool"
  | "waiting-approval"
  | "error"
  | "done"
  | "sleeping"
  | "parked"

/** Seven product states; composer and tool details retain their existing choreography. */
export type MascotPhase = "idle" | "thinking" | "working" | "waiting" | "done" | "failed" | "asleep"
export const mascotPhaseFor = (state: MascotState): MascotPhase => {
  switch (state) {
    case "thinking":
    case "done":
      return state
    case "typing":
    case "working-tool":
      return "working"
    case "waiting-approval":
      return "waiting"
    case "error":
      return "failed"
    case "sleeping":
    case "parked":
      return "asleep"
    default:
      return "idle"
  }
}

export type MascotSnapshot = { state: MascotState; phase: MascotPhase; since: number; revision: number }
export type MascotSignal = { state: MascotState; completion: string | null; holdDone?: boolean }
export type MascotEvent =
  | { type: "runtime"; signal: MascotSignal }
  | { type: "composer"; focused: boolean; typing: boolean }
  | { type: "park"; parked: boolean }
  | { type: "tick" }

export const MASCOT_DONE_MS = 2400
const active = (run: Run): boolean => ["queued", "starting", "running"].includes(run.status)
export const mascotIsBusy = (state: MascotState): boolean => ["thinking", "working-tool", "typing"].includes(state)

/** Project the existing runtime protocol, without storing new database state. */
export const mascotSignalFor = ({
  botId,
  paused = false,
  runs = [],
  messages = [],
  notifications = [],
  recentReply = false,
  waiting = false,
  machine,
}: {
  botId: string
  paused?: boolean
  runs?: readonly Run[]
  messages?: readonly Message[]
  notifications?: readonly NotificationRecord[]
  recentReply?: boolean
  waiting?: boolean
  machine?: MachineState | undefined
}): MascotSignal => {
  const botRuns = runs.filter((run) => run.botId === botId)
  // Runs are looked up per message on every streaming update; index them once instead of scanning per message.
  const runsById = new Map(botRuns.map((run) => [run.id, run]))
  const latest = [...botRuns].sort((a, b) => b.queuedAt - a.queuedAt)[0]
  const activeRuns = botRuns.filter(active)
  const liveMessages = messages.filter((message) => {
    const run = message.runId === null ? undefined : runsById.get(message.runId)
    return run ? active(run) : message.status === "streaming"
  })
  const successful = [...botRuns]
    .filter((run) => run.status === "succeeded" && run.replyMessageId)
    .sort((a, b) => (b.finishedAt ?? b.queuedAt) - (a.finishedAt ?? a.queuedAt))[0]
  const reply = [...messages]
    .filter((message) => message.role === "assistant" && message.status === "complete" && !message.runId)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
  const completion = successful
    ? `${successful.id}:${successful.finishedAt ?? successful.queuedAt}`
    : reply
      ? `${reply.id}:${reply.updatedAt}`
      : null
  const signal = (state: MascotState): MascotSignal => ({ state, completion, holdDone: recentReply })
  const latestAssistant = [...messages]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .find((message) => message.role === "assistant")
  const untrackedFailure =
    latestAssistant?.status === "failed" &&
    !(latestAssistant.runId !== null && runsById.has(latestAssistant.runId)) &&
    latestAssistant.updatedAt >= (latest?.finishedAt ?? latest?.queuedAt ?? 0)
  if (paused) return signal("sleeping")
  const attention = notifications.filter((item) => item.botId === botId && !isResolvedNotification(item))
  if (
    waiting ||
    attention.some((item) => ["approval", "question", "takeover"].includes(item.kind)) ||
    liveMessages.some((message) =>
      message.parts.some((part) => part.type === "approval" && part.decision === "pending"),
    )
  )
    return signal("waiting-approval")
  if (activeRuns.length || liveMessages.some((message) => message.role === "assistant")) {
    if (
      liveMessages.some((message) =>
        message.parts.some(
          (part) =>
            (part.type === "tool_call" || part.type === "command" || part.type === "file_change") &&
            (!part.resolution || part.resolution === "running") &&
            ((part.type === "tool_call" && part.ok === null) ||
              (part.type === "command" && part.exitCode === null) ||
              (part.type === "file_change" && part.resolution === "running")),
        ),
      )
    )
      return signal("working-tool")
    const streaming = liveMessages.filter((message) => message.role === "assistant")
    const last = streaming.sort((a, b) => b.updatedAt - a.updatedAt)[0]
    const lastPart = last?.parts.filter((part) => part.type === "text" || part.type === "reasoning").at(-1)
    return signal(lastPart?.type === "text" || (last?.text && !lastPart) ? "typing" : "thinking")
  }
  if (
    latest?.status === "failed" ||
    untrackedFailure ||
    attention.some(
      (item) => ["turn-failed", "routine-failed"].includes(item.kind) && item.createdAt >= (latest?.queuedAt ?? 0),
    )
  )
    return signal("error")
  return signal(machine?.status === "stopped" && machine.pauseReason === "inactivity" ? "parked" : "idle")
}

/** An injected monotonic clock makes every transition and timeout replayable. */
export class MascotMachine {
  private signal: MascotSignal
  private focused = false
  private typing = false
  private parked = false
  private doneUntil = -Infinity
  private now: number
  snapshot: MascotSnapshot

  constructor(signal: MascotSignal = { state: "idle", completion: null }, now = 0) {
    this.signal = signal
    this.now = now
    this.snapshot = {
      state: signal.holdDone && signal.state === "idle" ? "done" : signal.state,
      phase: signal.holdDone && signal.state === "idle" ? "done" : mascotPhaseFor(signal.state),
      since: now,
      revision: 0,
    }
  }

  send(event: MascotEvent, at: number): MascotSnapshot {
    this.now = Math.max(this.now, at)
    if (event.type === "runtime") {
      if (event.signal.completion && event.signal.completion !== this.signal.completion)
        this.doneUntil = this.now + MASCOT_DONE_MS
      // Clearing the held background reply acknowledges it immediately.
      if (this.signal.holdDone && !event.signal.holdDone) this.doneUntil = -Infinity
      this.signal = event.signal
      if (this.signal.state !== "idle") this.doneUntil = -Infinity
    } else if (event.type === "composer") {
      this.focused = event.focused
      this.typing = event.typing
    } else if (event.type === "park") this.parked = event.parked
    const state =
      this.signal.state !== "idle"
        ? this.signal.state
        : this.parked
          ? "parked"
          : this.signal.holdDone || this.now < this.doneUntil
            ? "done"
            : this.focused
              ? this.typing
                ? "typing"
                : "listening"
              : "idle"
    if (state !== this.snapshot.state)
      this.snapshot = { state, phase: mascotPhaseFor(state), since: this.now, revision: this.snapshot.revision + 1 }
    return this.snapshot
  }

  get deadline(): number | null {
    return this.doneUntil > this.now && !this.signal.holdDone ? this.doneUntil : null
  }
}

export const mascotMoodFor = (state: MascotState): AvatarMood => {
  if (state === "listening") return "waiting"
  switch (mascotPhaseFor(state)) {
    case "thinking":
    case "working":
      return "working"
    case "waiting":
      return "waiting"
    case "failed":
      return "failed"
    case "done":
      return "responded"
    case "asleep":
      return "asleep"
    default:
      return "idle"
  }
}

const mascotLabelKeys: Record<MascotState, TranslationKey> = {
  idle: "Mascot ready",
  listening: "Mascot listening",
  typing: "Activity working",
  thinking: "Activity thinking",
  "working-tool": "Activity working",
  "waiting-approval": "Activity waiting",
  error: "Mascot failed",
  done: "Concluído",
  sleeping: "Pausado",
  parked: "Machine resting",
}
export const mascotLabelFor = (state: MascotState, locale: Locale = "pt-BR"): string =>
  t(mascotLabelKeys[state], {}, locale)
export const mascotLabel = Object.fromEntries(
  Object.keys(mascotLabelKeys).map((state) => [state, mascotLabelFor(state as MascotState)]),
) as Record<MascotState, string>
