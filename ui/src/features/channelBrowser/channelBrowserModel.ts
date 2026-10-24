import type { Bot, BrowserChannelRun, BrowserChannelRunStatus, Message, Thread } from "@touri/contracts"
import { type Locale, t } from "../../i18n"

export type ChannelBrowserQueueEntry = {
  requesterId: string
  requesterName: string
}

// Field names follow the channel permission contract (requesterId, controllerId, queue).
export type ChannelBrowserState = {
  runId?: string
  status?: BrowserChannelRunStatus
  botId: string
  botName: string
  requesterId: string
  requesterName: string
  controllerId: string | null
  controllerName: string | null
  ownerId: string
  queue: ChannelBrowserQueueEntry[]
}

export type ChannelBrowserView = {
  canControl: boolean
  controlName: string
  previewHidden: boolean
}

export const getChannelWorking = (
  threads: readonly Pick<Thread, "id" | "groupId">[],
  messages: readonly Pick<Message, "threadId" | "status" | "sender" | "parts">[],
): Record<string, string[]> => {
  const groupByThread = new Map(threads.flatMap((thread) => (thread.groupId ? [[thread.id, thread.groupId]] : [])))
  const active = messages.flatMap((message) => {
    if (message.status !== "streaming" || !message.sender?.name) return []

    const groupId = groupByThread.get(message.threadId)
    if (!groupId) return []

    const hasRunningBrowserAction = message.parts.some(
      (part) =>
        part.type === "tool_call" &&
        part.ok == null &&
        (part.tool.split("__").at(-1) ?? part.tool).startsWith("browser_"),
    )
    if (!hasRunningBrowserAction) return []

    return [{ groupId, botName: message.sender.name }]
  })

  const groupIds = [...new Set(active.map(({ groupId }) => groupId))]

  return Object.fromEntries(
    groupIds.map((groupId) => [
      groupId,
      [...new Set(active.filter((item) => item.groupId === groupId).map((item) => item.botName))],
    ]),
  )
}

export const getChannelBrowserView = (state: ChannelBrowserState, viewerId: string): ChannelBrowserView => {
  const eligible = Boolean(viewerId) && (viewerId === state.requesterId || viewerId === state.ownerId)
  const canControl = eligible && (!state.controllerId || state.controllerId === viewerId)
  const tookOver = state.controllerId !== null

  return {
    canControl,
    controlName: tookOver ? (state.controllerName ?? state.requesterName) : state.requesterName,
    previewHidden: tookOver,
  }
}

export const getChannelQueueLabel = (queue: readonly ChannelBrowserQueueEntry[], locale: Locale): string => {
  const [next] = queue
  if (!next) return ""

  const label = t("Queued: request from {person}", { person: next.requesterName }, locale)
  if (queue.length === 1) return label

  return `${label} · ${t("{count} more", { count: queue.length - 1 }, locale)}`
}

export const getChannelWorkingTitle = (names: readonly string[], locale: Locale): string =>
  t("{names} working here", { names: names.join(", ") }, locale)

export const getChannelBrowserValue = ({
  runs,
  bots,
  threadId,
  viewerId,
  runId,
}: {
  runs: readonly BrowserChannelRun[]
  bots: readonly Bot[]
  threadId: string
  viewerId: string
  runId?: string | null
}): { state: ChannelBrowserState; viewerId: string } | null => {
  const run = runs.find(
    (candidate) =>
      candidate.threadId === threadId &&
      candidate.groupId &&
      (runId
        ? (candidate.runIds ?? [candidate.runId, candidate.activeRunId]).includes(runId)
        : ["running", "needs_you", "taken_over"].includes(candidate.status)),
  )
  if (!run) return null
  const bot = bots.find((candidate) => candidate.id === run.botId)
  if (!bot) return null
  const queue = runs
    .filter((candidate) => candidate.botId === run.botId && candidate.status === "queued")
    // Sort only the new filtered array; shared activity stays unchanged.
    .sort((first, second) => first.queuedAt - second.queuedAt || first.runId.localeCompare(second.runId))
    .map((candidate) => ({
      requesterId: candidate.requesterPersonId ?? "",
      requesterName: candidate.requesterName ?? "",
    }))

  return {
    viewerId,
    state: {
      runId: run.runId,
      status: run.status,
      botId: run.botId,
      botName: bot.name,
      requesterId: run.requesterPersonId ?? "",
      requesterName: run.requesterName ?? "",
      controllerId: run.controllerPersonId,
      controllerName: run.controllerName,
      ownerId: run.responsiblePersonId ?? "",
      queue,
    },
  }
}
