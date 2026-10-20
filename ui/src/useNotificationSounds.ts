import type { Message, NotificationPreferences, NotificationRecord } from "@touri/contracts"
import { useEffect, useMemo, useRef } from "react"
import type { TauriInvoke } from "./api/client"
import { createBellAudioSink } from "./notificationAudio"
import { createNotificationSoundController, type NotificationSoundKind } from "./notificationSound"
import { isAttention, isInformationalNotice } from "./sidebarAttention"

type SoundSnapshot = {
  ready: boolean
  notifications: ReadonlyArray<NotificationRecord>
  messages: ReadonlyArray<Message>
  preferences?: NotificationPreferences | undefined
  activeThreadId: string | null
}

export const useNotificationSounds = (snapshot: SoundSnapshot, invoke: TauriInvoke): void => {
  const audio = useMemo(createBellAudioSink, [])
  const controller = useMemo(() => createNotificationSoundController({ sink: audio.play }), [audio])
  const latest = useRef(snapshot)
  latest.current = snapshot
  const seen = useRef<{ notificationIds: Set<number>; messageIds: Set<string> } | null>(null)

  useEffect(() => {
    const unlock = (): void => audio.unlock()
    window.addEventListener("pointerdown", unlock, { once: true })
    window.addEventListener("keydown", unlock, { once: true })
    return () => {
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

    freshNotifications
      .filter((item) => item.resolvedAt === null && isAttention(item) && !isInformationalNotice(item))
      .forEach((item) => void play("attention", item.threadId))
    freshReplies.forEach((message) => void play("reply", message.threadId))

    async function play(kind: NotificationSoundKind, threadId: string | null): Promise<void> {
      let systemQuiet = false
      if ("__TAURI_INTERNALS__" in window) {
        try {
          systemQuiet = (await invoke("notification_system_quiet", {})) === true
        } catch {
          systemQuiet = false
        }
      }

      const current = latest.current
      controller.play({
        kind,
        threadId,
        preferences: current.preferences,
        activeThreadId: current.activeThreadId,
        visible: document.visibilityState === "visible",
        focused: document.hasFocus(),
        systemQuiet,
      })
    }
  }, [controller, invoke, snapshot.messages, snapshot.notifications, snapshot.ready])
}

const getSeen = (
  notifications: ReadonlyArray<NotificationRecord>,
  messages: ReadonlyArray<Message>,
  previous?: { notificationIds: Set<number>; messageIds: Set<string> },
) => ({
  notificationIds: new Set(
    [...Array.from(previous?.notificationIds ?? []), ...notifications.map((item) => item.id)].slice(-2048),
  ),
  messageIds: new Set(
    [
      ...Array.from(previous?.messageIds ?? []),
      ...messages
        .filter((message) => message.role === "assistant" && message.status === "complete")
        .map((message) => message.id),
    ].slice(-2048),
  ),
})
