import type { Page } from "@playwright/test"
import {
  applyAction,
  type ChannelAction,
  type ChannelState,
  enqueueRequest,
  getInitialChannel,
  type MemberId,
  publishSnapshot,
  requestNeedsYou,
} from "./channel-state"
import type { FlowSnapshot } from "./scripted-bot"

export type ChannelWindow = Window & {
  cuChannel?: { apply: (payload: { state: ChannelState; now: number }) => void }
  cuChannelAct?: (action: ChannelAction) => Promise<void>
  cuChannelSend?: (text: string) => Promise<void>
}

type Hub = {
  attach: (viewer: MemberId, page: Page) => Promise<void>
  publish: (snapshot: FlowSnapshot) => Promise<void>
  /** Re-renders every page as if `offsetMs` had passed since the wall appeared. */
  skipTime: (offsetMs: number) => Promise<void>
  isHeld: () => boolean
  /** Counts hand backs, so a quick take-over cannot slip between two polls. */
  getHandbacks: () => number
  getState: () => ChannelState
  getSent: () => string[]
}

const isLoginWall = (snapshot: FlowSnapshot): boolean =>
  snapshot.parts.some((part) => part.type === "text" && part.text.startsWith("O site pediu login"))

// The real product syncs members through the sidecar; the spec stands in for it with one in-process source of truth.
export const createChannelHub = (requester: MemberId, botOwner: MemberId): Hub => {
  const pages = new Map<MemberId, Page>()
  const sent: string[] = []
  const holder = { state: getInitialChannel(requester, botOwner), clockOffset: 0, handbacks: 0 }

  const render = (page: Page) =>
    page.evaluate((payload) => (window as ChannelWindow).cuChannel?.apply(payload), {
      state: holder.state,
      now: Date.now() + holder.clockOffset,
    })
  const broadcast = () => Promise.all([...pages.values()].map(render)).then(() => undefined)
  const update = (next: ChannelState) => {
    holder.handbacks += holder.state.controller !== null && next.controller === null ? 1 : 0
    holder.state = next
    return broadcast()
  }

  return {
    attach: async (viewer, page) => {
      pages.set(viewer, page)
      await page.exposeFunction("cuChannelAct", (action: ChannelAction) =>
        update(applyAction(holder.state, viewer, action)),
      )
      await page.exposeFunction("cuChannelSend", async (text: string) => {
        sent.push(text)
        await update(enqueueRequest(holder.state, viewer))
      })
    },
    publish: async (snapshot) => {
      await update(publishSnapshot(holder.state, snapshot))
      if (isLoginWall(snapshot) && holder.state.needsYouSince === null)
        await update(requestNeedsYou(holder.state, Date.now()))
    },
    skipTime: (offsetMs) => {
      holder.clockOffset = offsetMs

      return broadcast()
    },
    isHeld: () => holder.state.controller !== null,
    getHandbacks: () => holder.handbacks,
    getState: () => holder.state,
    getSent: () => sent,
  }
}
