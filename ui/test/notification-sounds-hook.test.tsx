import { act, renderHook, waitFor } from "@testing-library/react"
import type { NotificationPreferences } from "@touri/contracts"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { TauriInvoke } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { useChannelReads } from "../src/useChannelReads"
import { useNotificationSounds } from "../src/useNotificationSounds"

const audio = vi.hoisted(() => ({ play: vi.fn(), unlock: vi.fn() }))
vi.mock("../src/notificationAudio", () => ({ createBellAudioSink: () => audio }))

const setFocusedNativeWindow = () => {
  const original = Object.getOwnPropertyDescriptor(window, "__TAURI_INTERNALS__")
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true })
  vi.spyOn(document, "hasFocus").mockReturnValue(true)
  return () => {
    if (original) Object.defineProperty(window, "__TAURI_INTERNALS__", original)
    else Reflect.deleteProperty(window, "__TAURI_INTERNALS__")
  }
}

let restoreWindow: () => void = () => undefined
beforeEach(() => {
  vi.clearAllMocks()
  restoreWindow = setFocusedNativeWindow()
})
afterEach(() => {
  restoreWindow()
  vi.restoreAllMocks()
})

const getFixture = (preferences?: NotificationPreferences) => {
  const api = createMockApi()
  const { bots, threads, messages } = api.getState()
  const baseMessage = messages[0]
  if (!baseMessage) throw new Error("Missing reply fixture")
  const notification = api.notify({
    kind: "turn-failed",
    title: "Revisar tarefa",
    body: "Tente novamente.",
    botId: "bot-onb",
    threadId: "thread-onb",
  })
  const snapshot: Parameters<typeof useNotificationSounds>[0] = {
    ready: true,
    notifications: [],
    messages: [],
    bots,
    threads,
    preferences,
    activeThreadId: "thread-mark",
  }
  return { notification, snapshot, baseMessage }
}

it.each<NotificationPreferences>([
  { enabled: false },
  { bots: { "bot-onb": { enabled: false } } },
  { types: { "turn-failed": false } },
  { sound: { attention: false } },
])("does not query the host or play for muted delivery: %j", async (preferences) => {
  const { notification, snapshot } = getFixture(preferences)
  const invoke = vi.fn(async () => false) as TauriInvoke
  const view = renderHook((current) => useNotificationSounds(current, invoke), { initialProps: snapshot })

  await act(async () => view.rerender({ ...snapshot, notifications: [notification] }))

  expect(invoke).not.toHaveBeenCalled()
  expect(audio.play).not.toHaveBeenCalled()
})

it("coalesces a burst before the host query and respects the returned system quiet state", async () => {
  const { notification, snapshot } = getFixture()
  const invoke = vi.fn(async () => true) as TauriInvoke
  const view = renderHook((current) => useNotificationSounds(current, invoke), { initialProps: snapshot })
  const notifications = Array.from({ length: 20 }, (_, index) => ({ ...notification, id: index + 1 }))

  await act(async () => view.rerender({ ...snapshot, notifications }))

  expect(invoke).toHaveBeenCalledExactlyOnceWith("notification_system_quiet", {})
  expect(audio.play).not.toHaveBeenCalled()
})

it("ignores snapshot history and plays only for a new notification outside the active conversation", async () => {
  const { notification, snapshot } = getFixture()
  const invoke = vi.fn(async () => false) as TauriInvoke
  const initial = { ...snapshot, notifications: [notification] }
  const view = renderHook((current) => useNotificationSounds(current, invoke), { initialProps: initial })
  expect(audio.play).not.toHaveBeenCalled()

  await act(async () =>
    view.rerender({
      ...snapshot,
      notifications: [notification, { ...notification, id: 2, threadId: snapshot.activeThreadId }],
    }),
  )
  expect(invoke).not.toHaveBeenCalled()

  await act(async () => view.rerender({ ...snapshot, notifications: [notification, { ...notification, id: 3 }] }))

  expect(audio.play).toHaveBeenCalledExactlyOnceWith(0.45)
})

it("does not play a delayed host result after the workspace unmounts", async () => {
  const { notification, snapshot } = getFixture()
  let resolveQuiet: (quiet: boolean) => void = () => undefined
  const quiet = new Promise<boolean>((resolve) => {
    resolveQuiet = resolve
  })
  const invoke = vi.fn(() => quiet) as TauriInvoke
  const view = renderHook((current) => useNotificationSounds(current, invoke), { initialProps: snapshot })
  view.rerender({ ...snapshot, notifications: [notification] })
  view.unmount()

  await act(async () => resolveQuiet(false))

  expect(audio.play).not.toHaveBeenCalled()
})

it("sounds once when a streamed reply completes and reply sounds are enabled", async () => {
  const { snapshot, baseMessage } = getFixture({ sound: { replies: true } })
  const invoke = vi.fn(async () => false) as TauriInvoke
  const message = { ...baseMessage, id: "reply-sound", threadId: "thread-onb", role: "assistant" as const }
  const initial = { ...snapshot, messages: [{ ...message, status: "streaming" as const }] }
  const view = renderHook((current) => useNotificationSounds(current, invoke), { initialProps: snapshot })

  await act(async () => view.rerender(initial))
  expect(audio.play).not.toHaveBeenCalled()
  await act(async () => view.rerender({ ...snapshot, messages: [{ ...message, status: "complete" }] }))
  await act(async () => view.rerender({ ...snapshot, messages: [{ ...message, status: "complete" }] }))

  expect(audio.play).toHaveBeenCalledExactlyOnceWith(0.45)
})

it("does not replay replies when the activity snapshot exceeds the remembered history limit", async () => {
  const { snapshot, baseMessage } = getFixture({ sound: { replies: true } })
  const invoke = vi.fn(async () => false) as TauriInvoke
  const messages = Array.from({ length: 2100 }, (_, index) => ({
    ...baseMessage,
    id: `history-${index}`,
    threadId: "thread-onb",
    role: "assistant" as const,
    status: "complete" as const,
  }))
  const initial = { ...snapshot, messages }
  const view = renderHook((current) => useNotificationSounds(current, invoke), { initialProps: initial })

  await act(async () => view.rerender({ ...snapshot, messages: [...messages] }))

  expect(invoke).not.toHaveBeenCalled()
  expect(audio.play).not.toHaveBeenCalled()
})

it("plays a new task notification through the softer sink without marking it as attention", async () => {
  const { notification, snapshot } = getFixture()
  const invoke = vi.fn(async () => false) as TauriInvoke
  const view = renderHook((current) => useNotificationSounds(current, invoke), { initialProps: snapshot })

  await act(async () => view.rerender({ ...snapshot, notifications: [{ ...notification, kind: "task-started" }] }))

  expect(audio.play).toHaveBeenCalledExactlyOnceWith(0.45, "task")
})

it("plays the channel tone once when a channel's unread replies grow while the window is in the background", async () => {
  const { snapshot } = getFixture()
  vi.mocked(document.hasFocus).mockReturnValue(false)
  const invoke = vi.fn(async () => false) as TauriInvoke
  const reads = (unread: number) =>
    new Map([["avisos-thread", { threadId: "avisos-thread", readAt: 1, unread, mentions: 0 }]])
  // Until the first load the app has no counts; the loaded replies that were already waiting stay silent.
  const view = renderHook((current) => useNotificationSounds(current, invoke), {
    initialProps: { ...snapshot, channelReads: null } as Parameters<typeof useNotificationSounds>[0],
  })
  await act(async () => view.rerender({ ...snapshot, channelReads: reads(2) }))
  expect(audio.play).not.toHaveBeenCalled()

  await act(async () => view.rerender({ ...snapshot, channelReads: reads(3) }))
  await vi.waitFor(() => expect(audio.play).toHaveBeenCalledExactlyOnceWith(0.45, "channel"))

  // Reading the channel lowers the count; that is not news.
  await act(async () => view.rerender({ ...snapshot, channelReads: reads(0) }))
  expect(audio.play).toHaveBeenCalledOnce()
})

it("keeps asynchronously loaded channel history silent", async () => {
  const { snapshot } = getFixture()
  vi.mocked(document.hasFocus).mockReturnValue(false)
  const invoke = vi.fn(async () => false) as TauriInvoke
  const base = createMockApi()
  const api = {
    ...base,
    request: vi.fn(base.request).mockResolvedValue({
      channels: [{ threadId: "avisos-thread", readAt: 1, unread: 2, mentions: 0 }],
    }),
  }
  const view = renderHook(() => {
    const channelReads = useChannelReads({ api, threads: [], openThreadId: null, enabled: true })
    useNotificationSounds({ ...snapshot, channelReads }, invoke)
    return channelReads
  })

  await waitFor(() => expect(view.result.current?.get("avisos-thread")?.unread).toBe(2))

  expect(invoke).not.toHaveBeenCalled()
  expect(audio.play).not.toHaveBeenCalled()
})
