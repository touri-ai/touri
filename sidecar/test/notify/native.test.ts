import { expect, test } from "bun:test"
import type { NotificationRecord } from "@touri/contracts"
import {
  buildDeepLink,
  getNativeNotificationBody,
  nativeNotificationTitle,
  shouldNotifyNative,
} from "../../src/notify/native"

const record = (kind: NotificationRecord["kind"]): NotificationRecord => ({
  id: 1,
  kind,
  level: "info",
  botId: "b",
  botName: "Bot",
  botColor: "#fff",
  avatarShape: "short-flower",
  threadId: "t",
  title: "t",
  body: "b",
  requestId: null,
  createdAt: 0,
  resolvedAt: null,
  resolution: null,
})

test("native notifications follow the bot preference", () => {
  expect(shouldNotifyNative({ notification: record("turn-failed"), preference: "failures" })).toBe(true)
  expect(shouldNotifyNative({ notification: record("done"), preference: "failures" })).toBe(false)
  expect(shouldNotifyNative({ notification: record("done"), preference: "all" })).toBe(true)
  expect(shouldNotifyNative({ notification: record("incident"), preference: "none" })).toBe(false)
  expect(shouldNotifyNative({ notification: record("approval"), preference: "none" })).toBe(true)
  expect(shouldNotifyNative({ notification: record("question"), preference: null })).toBe(true)
})

test("deep links carry the bot and thread", () => {
  expect(buildDeepLink({ botId: "bot-1", threadId: "th 2" })).toBe("touri://open?bot=bot-1&thread=th+2")
  expect(buildDeepLink({ botId: "bot-1", threadId: "th 2", notificationId: 42 })).toBe(
    "touri://open?bot=bot-1&thread=th+2&notification=42",
  )
  expect(buildDeepLink({ botId: null, threadId: null })).toBe("touri://open?")
})

test("approval titles name the bot and action, without changing informational titles", () => {
  expect(
    nativeNotificationTitle({ ...record("approval"), botName: "Café Ideias", body: "Executar comando no terminal." }),
  ).toBe("Café Ideias precisa de você: autorizar executar comando no terminal.")
  expect(nativeNotificationTitle({ ...record("done"), title: "Concluído" })).toBe("Bot: Concluído")
})

test.each([
  ["pt-BR", "Rotina concluída sem novidades."],
  ["en", "Routine finished with no news."],
])("native no-news bodies translate the stored key for %s", (locale, expected) => {
  const notification = { ...record("done"), body: "Routine finished with no news." }

  const body = getNativeNotificationBody(notification, locale)

  expect(body).toBe(expected)
  expect(getNativeNotificationBody({ ...notification, body: "Relatório pronto" }, locale)).toBe("Relatório pronto")
})
