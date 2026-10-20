import { expect, it, vi } from "vitest"
import { createNotificationSoundController, type NotificationSoundEvent } from "../src/notificationSound"

const getSoundEvent = (patch: Partial<Omit<NotificationSoundEvent, "now">> = {}) => ({
  kind: "attention" as const,
  botId: "bot-other",
  notificationKind: "question" as const,
  threadId: "thread-other",
  preferences: undefined,
  activeThreadId: "thread-current",
  visible: true,
  focused: true,
  systemQuiet: false,
  ...patch,
})

it("respects disabled global, bot and notification-type delivery preferences", () => {
  const sink = vi.fn()
  const controller = createNotificationSoundController({ sink })

  expect(controller.play(getSoundEvent({ preferences: { enabled: false } }))).toBe(false)
  expect(controller.play(getSoundEvent({ preferences: { bots: { "bot-other": { enabled: false } } } }))).toBe(false)
  expect(
    controller.play(
      getSoundEvent({ notificationKind: "turn-failed", preferences: { types: { "turn-failed": false } } }),
    ),
  ).toBe(false)
  expect(sink).not.toHaveBeenCalled()
})

it("stays silent when the window is hidden or unfocused and when attention sound is off", () => {
  const sink = vi.fn()
  const controller = createNotificationSoundController({ sink })

  expect(controller.play(getSoundEvent({ visible: false }))).toBe(false)
  expect(controller.play(getSoundEvent({ focused: false }))).toBe(false)
  expect(controller.play(getSoundEvent({ preferences: { sound: { attention: false } } }))).toBe(false)
  expect(sink).not.toHaveBeenCalled()
})

it("gates sound during quiet hours, system quiet mode, and the active conversation", () => {
  const sink = vi.fn()
  const controller = createNotificationSoundController({
    sink,
    now: () => new Date("2026-10-20T23:00:00Z").getTime(),
  })

  expect(
    controller.play(
      getSoundEvent({
        preferences: { quietHours: { enabled: true, start: "22:00", end: "08:00", timeZone: "UTC" } },
      }),
    ),
  ).toBe(false)
  expect(controller.play(getSoundEvent({ systemQuiet: true }))).toBe(false)
  expect(controller.play(getSoundEvent({ threadId: "thread-current" }))).toBe(false)
  expect(sink).not.toHaveBeenCalled()
})

it("plays attention by default, keeps reply sound off by default, and uses the saved volume", () => {
  const sink = vi.fn()
  let current = 10_000
  const controller = createNotificationSoundController({ sink, now: () => current })

  expect(controller.play(getSoundEvent())).toBe(true)
  expect(controller.play(getSoundEvent({ kind: "reply" }))).toBe(false)
  current += 3000
  expect(controller.play(getSoundEvent({ kind: "reply", preferences: { sound: { replies: true, volume: 70 } } }))).toBe(
    true,
  )
  expect(sink).toHaveBeenCalledTimes(2)
  expect(sink).toHaveBeenNthCalledWith(1, 0.45)
  expect(sink).toHaveBeenNthCalledWith(2, 0.7)
})

it("debounces all notification sounds for three seconds", () => {
  const sink = vi.fn()
  let current = 10_000
  const controller = createNotificationSoundController({ sink, now: () => current })

  expect(controller.play(getSoundEvent())).toBe(true)
  current += 2999
  expect(controller.play(getSoundEvent())).toBe(false)
  current += 1
  expect(controller.play(getSoundEvent())).toBe(true)
  expect(sink).toHaveBeenCalledTimes(2)
})
