import type { FlowSnapshot } from "./scripted-bot"

export type MemberId = "carla" | "ana" | "hugo"

export const MEMBER_NAMES: Record<MemberId, string> = { carla: "Carla", ana: "Ana", hugo: "Hugo" }
export const NEEDS_YOU_ESCALATION_MS = 5 * 60_000

export type ChannelState = {
  snapshot: FlowSnapshot
  requester: MemberId
  botOwner: MemberId
  controller: MemberId | null
  needsYouSince: number | null
  queue: MemberId[]
}

export type ChannelAction = "takeover" | "handback" | "stop"

export const getInitialChannel = (requester: MemberId, botOwner: MemberId): ChannelState => ({
  snapshot: { parts: [], running: true },
  requester,
  botOwner,
  controller: null,
  needsYouSince: null,
  queue: [],
})

// Only the requester and the bot owner steer the browser; everyone else just watches.
export const canControl = (state: ChannelState, viewer: MemberId): boolean =>
  viewer === state.requester || viewer === state.botOwner

export const getNeedsYouTarget = (state: ChannelState, now: number): MemberId | null => {
  if (state.needsYouSince === null) return null

  return now - state.needsYouSince >= NEEDS_YOU_ESCALATION_MS ? state.botOwner : state.requester
}

// While someone holds the tab, the channel never sees the page they are typing into.
export const getVisibleSnapshot = (state: ChannelState): FlowSnapshot =>
  state.controller ? { ...state.snapshot, preview: undefined } : state.snapshot

export const applyAction = (state: ChannelState, viewer: MemberId, action: ChannelAction): ChannelState => {
  if (!canControl(state, viewer)) return state
  if (action === "stop")
    return { ...state, controller: null, needsYouSince: null, snapshot: { ...state.snapshot, running: false } }
  if (action === "takeover") return state.controller ? state : { ...state, controller: viewer, needsYouSince: null }

  return { ...state, controller: null }
}

export const publishSnapshot = (state: ChannelState, snapshot: FlowSnapshot): ChannelState => ({ ...state, snapshot })

export const requestNeedsYou = (state: ChannelState, now: number): ChannelState => ({ ...state, needsYouSince: now })

export const enqueueRequest = (state: ChannelState, member: MemberId): ChannelState =>
  state.queue.includes(member) ? state : { ...state, queue: [...state.queue, member] }

const getArticle = (member: MemberId): string => (member === "ana" ? "da" : "do")

export const getHeaderChip = (state: ChannelState, botName: string): string =>
  `${botName} no navegador · pedido ${getArticle(state.requester)} ${MEMBER_NAMES[state.requester]}`

export const getControlNotice = (state: ChannelState, viewer: MemberId): string | null => {
  if (!state.controller) return null
  if (state.controller === viewer) return "Você está no controle"

  return `${MEMBER_NAMES[state.controller]} está no controle`
}
