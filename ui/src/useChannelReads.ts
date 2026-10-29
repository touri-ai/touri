import type { ChannelReadState, Thread, UiEvent } from "@touri/contracts"
import { useEffect, useRef, useState } from "react"
import type { UiApi } from "./api/client"

const EMPTY_READS: ReadonlyMap<string, ChannelReadState> = new Map()
/** Bursts of settled replies (several bots answering) share one refresh. */
const REFRESH_DELAY_MS = 250

const isChannelThread = (thread: Thread | undefined): boolean =>
  Boolean(thread?.groupId && !thread.groupThreadId && thread.archivedAt === null)

const isOnScreen = (): boolean => document.visibilityState === "visible" && document.hasFocus()

/** Whether an event can change a channel's unread replies: a reply settled, or this person read a channel. */
const changesReads = (event: UiEvent, threads: ReadonlyMap<string, Thread>): boolean => {
  if (event.type === "channel.read") return true
  if (event.type !== "message.created" && event.type !== "message.updated") return false

  return (
    event.message.role === "assistant" &&
    event.message.status === "complete" &&
    isChannelThread(threads.get(event.message.threadId))
  )
}

/**
 * The person's unread bot replies per channel conversation. The conversation on screen is read as
 * soon as a reply settles in it; a hidden or unfocused window leaves it unread until the person returns.
 */
export const useChannelReads = ({
  api,
  threads,
  openThreadId,
  enabled,
}: {
  api: UiApi | null
  threads: ReadonlyArray<Thread>
  openThreadId: string | null
  enabled: boolean
}): ReadonlyMap<string, ChannelReadState> => {
  const [reads, setReads] = useState(EMPTY_READS)
  const [onScreen, setOnScreen] = useState(isOnScreen)
  const threadsById = useRef(new Map<string, Thread>())
  threadsById.current = new Map(threads.map((thread) => [thread.id, thread]))
  const reading = useRef(new Set<string>())

  useEffect(() => {
    if (!enabled || !api) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const load = () =>
      void api
        .request("GET /channel-reads", {})
        .then(({ channels }) => {
          if (active) setReads(new Map(channels.map((channel) => [channel.threadId, channel])))
        })
        .catch(() => undefined)
    const refresh = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(load, REFRESH_DELAY_MS)
    }
    load()
    const unsubscribe = api.subscribe(({ event }) => {
      if (changesReads(event, threadsById.current)) refresh()
    })
    // Replies that settle while the event stream reconnects are only in a fresh snapshot.
    const unsubscribeConnection = api.subscribeConnection?.((connected) => {
      if (connected) refresh()
    })
    return () => {
      active = false
      if (timer) clearTimeout(timer)
      unsubscribe()
      unsubscribeConnection?.()
    }
  }, [api, enabled])

  useEffect(() => {
    const update = () => setOnScreen(isOnScreen())
    window.addEventListener("focus", update)
    window.addEventListener("blur", update)
    document.addEventListener("visibilitychange", update)
    return () => {
      window.removeEventListener("focus", update)
      window.removeEventListener("blur", update)
      document.removeEventListener("visibilitychange", update)
    }
  }, [])

  const openUnread = openThreadId ? (reads.get(openThreadId)?.unread ?? 0) : 0
  useEffect(() => {
    if (!api || !enabled || !openThreadId || !onScreen || openUnread === 0 || reading.current.has(openThreadId)) return
    if (!isChannelThread(threadsById.current.get(openThreadId))) return

    const threadId = openThreadId
    reading.current.add(threadId)
    void api
      .request("POST /threads/:id/read", {}, { id: threadId })
      .then(({ channel }) => setReads((current) => new Map(current).set(threadId, channel)))
      .catch(() => undefined)
      .finally(() => reading.current.delete(threadId))
  }, [api, enabled, onScreen, openThreadId, openUnread])

  return reads
}
