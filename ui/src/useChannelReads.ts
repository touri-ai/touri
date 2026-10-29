import type { ChannelReadState, Thread, UiEvent } from "@touri/contracts"
import { useEffect, useMemo, useRef, useState } from "react"
import type { UiApi } from "./api/client"

/** Bursts of settled replies (several bots answering) share one refresh. */
const REFRESH_DELAY_MS = 250

const isChannelThread = (thread: Thread | undefined): boolean =>
  Boolean(thread?.groupId && !thread.groupThreadId && thread.archivedAt === null)

const isOnScreen = (): boolean => document.visibilityState === "visible" && document.hasFocus()

/** Whether an event can change a channel's unread replies: a reply settled, or this person read a channel. */
const isReadChange = (event: UiEvent, threads: ReadonlyMap<string, Thread>): boolean => {
  if (event.type === "channel.read") return true
  if (event.type !== "message.created" && event.type !== "message.updated") return false

  return (
    event.message.role === "assistant" &&
    event.message.status === "complete" &&
    isChannelThread(threads.get(event.message.threadId))
  )
}

/**
 * The person's unread bot replies per channel conversation, or null until the first load. The
 * conversation on screen is read as soon as a reply settles in it; a hidden or unfocused window
 * leaves it unread until the person returns.
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
}): ReadonlyMap<string, ChannelReadState> | null => {
  const [reads, setReads] = useState<ReadonlyMap<string, ChannelReadState> | null>(null)
  const [onScreen, setOnScreen] = useState(isOnScreen)
  const threadsById = useRef(new Map<string, Thread>())
  threadsById.current = useMemo(() => new Map(threads.map((thread) => [thread.id, thread])), [threads])
  const reading = useRef(new Set<string>())
  // Bumped by each applied read, so a list requested before it cannot restore replies already read.
  const readVersion = useRef(0)

  useEffect(() => {
    if (!enabled || !api) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const load = () => {
      const version = readVersion.current
      void api
        .request("GET /channel-reads", {})
        .then(({ channels }) => {
          if (active && version === readVersion.current)
            setReads(new Map(channels.map((channel) => [channel.threadId, channel])))
        })
        .catch(() => undefined)
    }
    const refresh = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(load, REFRESH_DELAY_MS)
    }
    load()
    const unsubscribe = api.subscribe(({ event }) => {
      if (isReadChange(event, threadsById.current)) refresh()
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

  const openUnread = openThreadId ? (reads?.get(openThreadId)?.unread ?? 0) : 0
  useEffect(() => {
    if (!api || !enabled || !openThreadId || !onScreen || openUnread === 0 || reading.current.has(openThreadId)) return
    if (!isChannelThread(threadsById.current.get(openThreadId))) return

    const threadId = openThreadId
    reading.current.add(threadId)
    void api
      .request("POST /threads/:id/read", {}, { id: threadId })
      .then(({ channel }) => {
        readVersion.current += 1
        setReads((current) => new Map(current ?? []).set(threadId, channel))
      })
      .catch(() => undefined)
      .finally(() => reading.current.delete(threadId))
  }, [api, enabled, onScreen, openThreadId, openUnread])

  return reads
}
