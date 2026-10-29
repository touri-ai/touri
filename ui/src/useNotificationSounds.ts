import type {
  Bot,
  ChannelReadState,
  Message,
  NotificationPreferences,
  NotificationRecord,
  Thread,
} from "@touri/contracts"
import { useCallback, useEffect, useMemo, useRef } from "react"
import type { TauriInvoke } from "./api/client"
import {
  createNotificationSoundController,
  type NotificationSoundEvent,
  type NotificationSoundKind,
  shouldPlayNotificationSound,
} from "./notificationSound"
import { isAttention, isInformationalNotice } from "./sidebarAttention"

type SoundSnapshot = {
  ready: boolean
  notifications: ReadonlyArray<NotificationRecord>
  messages: ReadonlyArray<Message>
  bots: ReadonlyArray<Bot>
  threads: ReadonlyArray<Thread>
  preferences?: NotificationPreferences | undefined
  activeThreadId: string | null
  /** Unread bot replies per channel conversation (null until loaded); a growing count is a finished channel task. */
  channelReads?: ReadonlyMap<string, ChannelReadState> | null
}

type SoundIntent = {
  kind: NotificationSoundKind
  threadId: string | null
  botId: string | null
  notificationKind?: NotificationRecord["kind"]
}

export const useNotificationSounds = (snapshot: SoundSnapshot, invoke: TauriInvoke): void => {
  const mounted = useRef(false)
  const audio = useMemo(() => {
    // Keep synthesis outside the initial payload; a gesture unlocks the loaded context.
    const sink = import("./notificationAudio")
      .then(({ createBellAudioSink }) => createBellAudioSink())
      .catch(() => null)
    return {
      unlock: () => void sink.then((audio) => mounted.current && audio?.unlock()),
      play: (volume: number, kind?: NotificationSoundKind) =>
        void sink.then((audio) => {
          if (!mounted.current) return

          if (kind) audio?.play(volume, kind)
          else audio?.play(volume)
        }),
    }
  }, [])
  const controller = useMemo(() => createNotificationSoundController({ sink: audio.play }), [audio])
  const latest = useRef(snapshot)
  latest.current = snapshot
  const seen = useRef<{ notificationIds: Set<number>; messageIds: Set<string> } | null>(null)
  const play = useCallback(
    async (intent: SoundIntent): Promise<void> => {
      // Only Windows reports its focus or do-not-disturb state; elsewhere the app's own settings apply.
      let systemQuiet = false
      if ("__TAURI_INTERNALS__" in window) {
        try {
          systemQuiet = (await invoke("notification_system_quiet", {})) === true
        } catch {
          systemQuiet = false
        }
      }

      if (!mounted.current) return

      controller.play(getSoundEvent(intent, latest.current, systemQuiet))
    },
    [controller, invoke],
  )

  useEffect(() => {
    mounted.current = true
    const unlock = (): void => audio.unlock()
    window.addEventListener("pointerdown", unlock, { once: true })
    window.addEventListener("keydown", unlock, { once: true })
    return () => {
      mounted.current = false
      window.removeEventListener("pointerdown", unlock)
      window.removeEventListener("keydown", unlock)
    }
  }, [audio])

  useEffect(() => {
    if (!snapshot.ready) return
    const previous = seen.current
    if (!previous) {
      seen.current = getSeen(snapshot.notifications, snapshot.messages)
      return
    }

    const freshNotifications = snapshot.notifications.filter((item) => !previous.notificationIds.has(item.id))
    const freshReplies = snapshot.messages.filter(
      (message) =>
        !previous.messageIds.has(message.id) &&
        message.role === "assistant" &&
        message.status === "complete" &&
        message.threadId !== null,
    )
    seen.current = getSeen(snapshot.notifications, snapshot.messages, previous)

    const intents: SoundIntent[] = [
      ...freshNotifications
        .filter(
          (item) =>
            item.resolvedAt === null &&
            ((isAttention(item) && !isInformationalNotice(item)) || item.kind === "task-started"),
        )
        .map((item) => ({
          kind: item.kind === "task-started" ? ("task" as const) : ("attention" as const),
          threadId: item.threadId,
          botId: item.botId,
          notificationKind: item.kind,
        })),
      ...freshReplies.map((message) => ({
        kind: "reply" as const,
        threadId: message.threadId,
        botId: latest.current.threads.find((thread) => thread.id === message.threadId)?.botId ?? null,
      })),
    ]
    const intent = intents.find((item) => shouldPlayNotificationSound(getSoundEvent(item, latest.current, false)))
    if (intent) void play(intent)
  }, [play, snapshot.messages, snapshot.notifications, snapshot.ready])

  const seenChannels = useRef<ReadonlyMap<string, number> | null>(null)
  useEffect(() => {
    if (!snapshot.ready || !snapshot.channelReads) {
      seenChannels.current = null
      return
    }
    const previous = seenChannels.current
    seenChannels.current = new Map(Array.from(snapshot.channelReads.values(), (read) => [read.threadId, read.unread]))
    // The first snapshot is history, not news.
    if (!previous) return

    const finished = Array.from(snapshot.channelReads.values()).find(
      (read) => read.unread > (previous.get(read.threadId) ?? 0),
    )
    if (finished) void play({ kind: "channel", threadId: finished.threadId, botId: null })
  }, [play, snapshot.channelReads, snapshot.ready])
}

const getSoundEvent = (intent: SoundIntent, snapshot: SoundSnapshot, systemQuiet: boolean): NotificationSoundEvent => ({
  ...intent,
  botPreference: snapshot.bots.find((bot) => bot.id === intent.botId)?.notifications ?? null,
  preferences: snapshot.preferences,
  activeThreadId: snapshot.activeThreadId,
  visible: document.visibilityState === "visible",
  focused: document.hasFocus(),
  systemQuiet,
  now: new Date(),
})

/** Retain every current record so a large snapshot cannot replay old sounds. */
const getSeen = (
  notifications: ReadonlyArray<NotificationRecord>,
  messages: ReadonlyArray<Message>,
  previous?: { notificationIds: Set<number>; messageIds: Set<string> },
) => ({
  notificationIds: new Set([
    ...Array.from(previous?.notificationIds ?? []).slice(-2048),
    ...notifications.map((item) => item.id),
  ]),
  messageIds: new Set([
    ...Array.from(previous?.messageIds ?? []).slice(-2048),
    ...messages
      .filter((message) => message.role === "assistant" && message.status === "complete")
      .map((message) => message.id),
  ]),
})
