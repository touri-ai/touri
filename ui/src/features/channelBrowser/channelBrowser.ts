import { type Locale, t } from "../../i18n"

export type ChannelBrowserQueueEntry = {
  requesterId: string
  requesterName: string
}

// Field names follow the channel permission contract (requesterId, controllerId, queue).
export type ChannelBrowserState = {
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

export const getChannelBrowserView = (state: ChannelBrowserState, viewerId: string): ChannelBrowserView => {
  const canControl = viewerId === state.requesterId || viewerId === state.ownerId
  const tookOver = state.controllerId !== null
  const isController = viewerId === state.controllerId

  return {
    canControl,
    controlName: tookOver ? (state.controllerName ?? state.requesterName) : state.requesterName,
    previewHidden: tookOver && !isController,
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
