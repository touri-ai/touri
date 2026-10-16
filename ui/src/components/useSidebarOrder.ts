import type { Bot, Id, Message, NotificationRecord, Run, Thread } from "@touri/contracts"
import { type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { type BotActivity, computeBotActivity, holdBotPositions, orderBotsByActivity } from "../botActivity"
import { isMotionReduced } from "../design/motionPreference"
import { useBotLastViewed } from "../useBotLastViewed"

const ENTRY_SELECTOR = "[data-bot-entry]"
const FLIP_CLEANUP_MS = 600

type SidebarOrderInput = {
  bots: Array<Bot>
  threads: Array<Thread>
  messages: Array<Message>
  runs?: Array<Run> | undefined
  notifications: Array<NotificationRecord>
  attention: Array<NotificationRecord>
  selectedBotId: Id | null
  selectedThreadId: Id | null
  section: "advanced" | "bots"
  floatUpdates?: boolean | undefined
}

export type HoldReason = "hover" | "focus"

export type SidebarOrder = {
  bots: Array<Bot>
  activity: ReadonlyMap<Id, BotActivity>
  listRef: RefObject<HTMLDivElement | null>
  hold: (botId: Id, reason: HoldReason, active: boolean) => void
}

/** True while focus is in a chat composer, i.e. the user is typing to the selected bot. */
const useComposerFocus = (): boolean => {
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    const update = (): void => setFocused(Boolean(document.activeElement?.closest(".composer")))
    update()
    document.addEventListener("focusin", update)
    document.addEventListener("focusout", update)
    return () => {
      document.removeEventListener("focusin", update)
      document.removeEventListener("focusout", update)
    }
  }, [])
  return focused
}

const measure = (list: HTMLElement): Map<string, number> =>
  new Map(
    Array.from(list.querySelectorAll<HTMLElement>(ENTRY_SELECTOR)).map((element) => [
      element.dataset.botEntry ?? "",
      element.getBoundingClientRect().top,
    ]),
  )

/** FLIP: start each moved row at its old offset, then let it glide to its new slot. */
const playReorder = (list: HTMLElement, first: ReadonlyMap<string, number>): void => {
  for (const element of Array.from(list.querySelectorAll<HTMLElement>(ENTRY_SELECTOR))) {
    const before = first.get(element.dataset.botEntry ?? "")
    if (before === undefined) continue
    const delta = before - element.getBoundingClientRect().top
    if (Math.abs(delta) < 1) continue
    element.style.transition = "none"
    element.style.transform = `translateY(${delta}px)`
    element.dataset.reordering = "true"
    window.requestAnimationFrame(() => {
      element.style.transition = "transform var(--duration-surface) var(--ease-surface)"
      element.style.transform = ""
      window.setTimeout(() => {
        element.style.transition = ""
        delete element.dataset.reordering
      }, FLIP_CLEANUP_MS)
    })
  }
}

export const useSidebarOrder = (input: SidebarOrderInput): SidebarOrder => {
  const { bots, threads, messages, notifications, attention, selectedBotId, selectedThreadId, section } = input
  const runs = input.runs
  const floatUpdates = input.floatUpdates ?? true
  const viewingBotId =
    section === "bots" && !threads.find((thread) => thread.id === selectedThreadId)?.groupId ? selectedBotId : null
  const baseIds = useMemo(() => bots.map((bot) => bot.id), [bots])
  const { lastViewed, markViewed } = useBotLastViewed(baseIds)
  const activity = useMemo(
    () =>
      computeBotActivity({
        bots,
        threads,
        messages,
        runs: runs ?? [],
        attention,
        notifications,
        lastViewed,
        viewingBotId,
      }),
    [bots, threads, messages, runs, attention, notifications, lastViewed, viewingBotId],
  )
  const viewingResultAt = viewingBotId ? (activity.get(viewingBotId)?.lastResultAt ?? 0) : 0
  useEffect(() => {
    if (viewingBotId) markViewed(viewingBotId, Math.max(Date.now(), viewingResultAt))
  }, [viewingBotId, viewingResultAt, markViewed])

  const [hovered, setHovered] = useState<Id | null>(null)
  const [focused, setFocused] = useState<Id | null>(null)
  const typing = useComposerFocus()
  const hold = useCallback((botId: Id, reason: HoldReason, active: boolean): void => {
    const update = reason === "hover" ? setHovered : setFocused
    update((current) => (active ? botId : current === botId ? null : current))
  }, [])
  const held = new Set([hovered, focused, typing ? selectedBotId : null].filter((id): id is Id => Boolean(id)))
  const desired = floatUpdates ? orderBotsByActivity({ botIds: baseIds, activity }) : baseIds
  const previous = useRef<Array<Id>>(baseIds)
  const group = (id: Id): string => {
    const kind = activity.get(id)?.kind
    return kind === "needs-you" || kind === "working" ? kind : "idle"
  }
  const ids = ["needs-you", "working", "idle"].flatMap((kind) =>
    holdBotPositions({
      desired: desired.filter((id) => group(id) === kind),
      previous: previous.current.filter((id) => group(id) === kind),
      held,
    }),
  )
  const listRef = useRef<HTMLDivElement>(null)
  const firstRects = useRef<Map<string, number> | null>(null)
  if (ids.join("\n") !== previous.current.join("\n") && !firstRects.current && listRef.current)
    firstRects.current = measure(listRef.current)
  useLayoutEffect(() => {
    previous.current = ids
    const first = firstRects.current
    firstRects.current = null
    if (!first || !listRef.current || isMotionReduced()) return
    playReorder(listRef.current, first)
  })
  const byId = new Map(bots.map((bot) => [bot.id, bot]))
  return {
    bots: ids.flatMap((id) => {
      const bot = byId.get(id)
      return bot ? [bot] : []
    }),
    activity,
    listRef,
    hold,
  }
}
