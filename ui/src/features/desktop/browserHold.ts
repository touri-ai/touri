import { useSyncExternalStore } from "react"

/** The tab a person took over for a bot, shared by the transcript card and the composer chip. */
export type BrowserHold = { tabId: string; release: () => void }

type Holds = ReadonlyMap<string, BrowserHold>

const listeners = new Set<() => void>()
let holds: Holds = new Map()

const subscribe = (listener: () => void) => {
  listeners.add(listener)

  return () => {
    listeners.delete(listener)
  }
}

const setHolds = (next: Holds) => {
  holds = next
  for (const listener of listeners) listener()
}

export const setBrowserHold = (botId: string, hold: BrowserHold) => setHolds(new Map([...holds, [botId, hold]]))

export const clearBrowserHold = (botId: string, tabId: string) => {
  if (holds.get(botId)?.tabId !== tabId) return
  setHolds(new Map([...holds].filter(([id]) => id !== botId)))
}

export const useBrowserHold = (botId: string | undefined): BrowserHold | undefined =>
  useSyncExternalStore(subscribe, () => (botId ? holds.get(botId) : undefined))
