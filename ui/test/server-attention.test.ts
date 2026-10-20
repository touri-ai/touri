import { cleanup, renderHook } from "@testing-library/react"
import type { NotificationPreferences, NotificationRecord, UiEventEnvelope } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import type { TauriInvoke, UiApi } from "../src/api/client"
import { installServerAttention, useServerAttention } from "../src/features/server/serverAttention"
import type { WorkspaceData } from "../src/useWorkspace"

afterEach(cleanup)

const note = (id: number, patch: Partial<NotificationRecord> = {}): NotificationRecord => ({
  id,
  kind: "approval",
  level: "info",
  botId: "bot-remote",
  botName: "Clara",
  botColor: "#ee3344",
  avatarShape: "classic-none",
  threadId: "thread-remote",
  title: "Preciso de aprovação",
  body: "Ação pendente",
  requestId: `request-${id}`,
  createdAt: 100,
  resolvedAt: null,
  resolution: null,
  ...patch,
})

const fixture = (initial: NotificationRecord[] = [], preferences?: NotificationPreferences) => {
  let listener: ((event: UiEventEnvelope) => void) | undefined
  const unsubscribe = vi.fn()
  const api = {
    subscribe: (next: typeof listener) => {
      listener = next
      return unsubscribe
    },
  } as UiApi
  const invoke = vi.fn(async () => ({})) as unknown as TauriInvoke
  const enabled = { current: true }
  const stop = installServerAttention(api, invoke, {
    initial,
    ...(preferences ? { preferences: () => preferences } : {}),
    startedAt: 100,
    enabled: () => enabled.current,
    botForThread: () => "bot-remote",
  })
  const emit = (seq: number, event: UiEventEnvelope["event"], at = 101) => listener?.({ seq, at, event })
  return { invoke, stop, emit, unsubscribe, enabled }
}

it("notifies once for a fresh approval with a validated remote deep link", () => {
  const { emit, invoke } = fixture()
  emit(1, { type: "notification.created", notification: note(1) })
  emit(1, { type: "notification.created", notification: note(1) })
  emit(2, { type: "notification.created", notification: note(1) })
  emit(3, {
    type: "notify",
    level: "info",
    title: "echo",
    body: "",
    threadId: "thread-remote",
    notificationId: 1,
    kind: "approval",
  })
  expect(invoke).toHaveBeenCalledTimes(1)
  expect(invoke).toHaveBeenCalledWith("server_attention", {
    title: "Preciso de aprovação",
    body: "Um bot precisa da sua atenção.",
    deepLink: "touri://open?bot=bot-remote&thread=thread-remote&notification=1",
  })
})

it("suppresses initial history, old replay, resolved records and informational completions", () => {
  const { emit, invoke, stop, unsubscribe } = fixture([note(1)])
  emit(1, { type: "notification.created", notification: note(1) })
  emit(2, { type: "notification.created", notification: note(0) }, 99)
  emit(3, { type: "notification.created", notification: note(3, { resolvedAt: 100 }) })
  emit(4, { type: "notification.created", notification: note(4, { kind: "done" }) })
  expect(invoke).not.toHaveBeenCalled()
  stop()
  expect(unsubscribe).toHaveBeenCalledOnce()
})

it("respects disabled notifications and never forwards malformed destination identifiers", () => {
  const { emit, invoke, enabled } = fixture()
  enabled.current = false
  emit(1, { type: "notification.created", notification: note(1) })
  expect(invoke).not.toHaveBeenCalled()
  enabled.current = true
  emit(2, { type: "notification.created", notification: note(2, { botId: "bad?target", threadId: "bad#target" }) })
  expect(invoke).toHaveBeenCalledWith("server_attention", {
    title: "Preciso de aprovação",
    body: "Um bot precisa da sua atenção.",
    deepLink: "touri://open?notification=2",
  })
})

it("accepts fresh attention after a resync resets a restarted server's sequence", () => {
  const { emit, invoke } = fixture()
  emit(100, { type: "notification.created", notification: note(1) })
  emit(0, { type: "transcript.resync" })
  emit(2, { type: "notification.created", notification: note(2) })
  expect(invoke).toHaveBeenCalledTimes(2)
})

it("uses persisted record ids rather than the desktop clock to identify fresh server attention", () => {
  const { emit, invoke } = fixture([note(20)])
  emit(1, { type: "notification.created", notification: note(21) }, 10)
  expect(invoke).toHaveBeenCalledOnce()
})

it("updates the native badge from pending attention and clears it when resolved", () => {
  const invoke = vi.fn(async () => ({})) as unknown as TauriInvoke
  const api = { subscribe: () => () => undefined } as unknown as UiApi
  const data = {
    loading: false,
    notifications: [note(1)],
    activityMessages: [],
    runs: [],
    threads: [],
    settings: { nativeNotifications: true },
  } as unknown as WorkspaceData
  const { rerender } = renderHook(({ current }) => useServerAttention({ api, invoke, enabled: true, data: current }), {
    initialProps: { current: data },
  })
  expect(invoke).toHaveBeenCalledWith("server_badge", { count: 1 })
  rerender({ current: { ...data, notifications: [note(1, { resolvedAt: 102, resolution: "allow" })] } })
  expect(invoke).toHaveBeenLastCalledWith("server_badge", { count: 0 })
})

it("applies type and bot filters before delivering remote attention", () => {
  const { emit, invoke } = fixture([], {
    digest: "all",
    types: { "turn-failed": false },
    bots: { "bot-remote": { types: { "routine-failed": false } } },
  })

  emit(1, { type: "notification.created", notification: note(1, { kind: "turn-failed" }) })
  emit(2, { type: "notification.created", notification: note(2, { kind: "routine-failed" }) })
  emit(3, { type: "notification.created", notification: note(3, { kind: "done" }) })

  expect(invoke).toHaveBeenCalledTimes(1)
  expect(invoke).toHaveBeenCalledWith(
    "server_attention",
    expect.objectContaining({ body: "Há um novo aviso na central de notificações." }),
  )
})

it("keeps non-blocking remote attention quiet during an all-day quiet window", () => {
  const { emit, invoke } = fixture([], { quietHours: { enabled: true, start: "00:00", end: "00:00", timeZone: "UTC" } })

  emit(1, { type: "notification.created", notification: note(1, { kind: "turn-failed" }) })

  expect(invoke).not.toHaveBeenCalled()
})

it.each(["approval", "question", "takeover"] as const)(
  "delivers blocking %s despite quiet hours and stale type mutes",
  (kind) => {
    const { emit, invoke } = fixture([], {
      types: { [kind]: false },
      bots: { "bot-remote": { types: { [kind]: false } } },
      quietHours: { enabled: true, start: "00:00", end: "00:00", timeZone: "UTC" },
    })

    emit(1, { type: "notification.created", notification: note(1, { kind }) })

    expect(invoke).toHaveBeenCalledOnce()
  },
)

it("delivers explicit bot notices with legacy settings even without saved preferences", () => {
  const { emit, invoke } = fixture()

  emit(1, { type: "notification.created", notification: note(1, { kind: "notice" }) })

  expect(invoke).toHaveBeenCalledWith(
    "server_attention",
    expect.objectContaining({ body: "Há um novo aviso na central de notificações." }),
  )
})
