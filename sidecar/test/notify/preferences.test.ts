import type { Database } from "bun:sqlite"
import { afterEach, expect, mock, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  canDeliverNotification,
  isNotificationPreferences,
  type Kernel,
  type NotificationPreferences,
  type ToolContext,
} from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { createNotifyUserHandler } from "../../src/mcp/tools/notify-user"
import { init as initNotify } from "../../src/notify"
import { getNativeNotificationBody } from "../../src/notify/native"
import { createNotificationStore } from "../../src/notify/store"
import { createRuntimeNotices } from "../../src/runtime/notices"
import { init as initStore } from "../../src/store"

const cleanups = new Set<() => void>()
afterEach(() => {
  cleanups.forEach((close) => {
    close()
  })
  cleanups.clear()
})

test("global and bot type overrides apply before the digest and preserve legacy defaults", () => {
  const failure = { kind: "turn-failed", botId: "bot-demo" } as const
  const done = { kind: "done", botId: "bot-demo" } as const
  const preferences: NotificationPreferences = {
    digest: "all",
    types: { "turn-failed": false, done: false },
    bots: { "bot-demo": { types: { done: true } } },
  }

  const blocked = canDeliverNotification({ notification: failure, preferences })
  const overridden = canDeliverNotification({ notification: done, preferences })

  expect(blocked).toBe(false)
  expect(overridden).toBe(true)
  expect(canDeliverNotification({ notification: done, preferences: { digest: "attention" } })).toBe(false)
  expect(canDeliverNotification({ notification: done, preferences: { digest: "all" } })).toBe(true)
  expect(canDeliverNotification({ notification: failure, preferences, enabled: false })).toBe(false)
  expect(
    canDeliverNotification({
      notification: done,
      preferences: { ...preferences, bots: { "bot-demo": { enabled: false } } },
    }),
  ).toBe(false)
  expect(canDeliverNotification({ notification: { kind: "approval", botId: "bot-demo" }, botPreference: "none" })).toBe(
    true,
  )
})

test.each([
  ["2026-10-18T21:59:00Z", true],
  ["2026-10-18T22:00:00Z", false],
  ["2026-10-19T07:59:00Z", false],
  ["2026-10-19T08:00:00Z", true],
])("quiet hours include their start and exclude their end: %s", (time, expected) => {
  const preferences: NotificationPreferences = {
    quietHours: { enabled: true, start: "22:00", end: "08:00", timeZone: "UTC" },
  }

  const allowed = canDeliverNotification({
    notification: { kind: "notice", botId: null },
    preferences,
    now: new Date(time),
  })

  expect(allowed).toBe(expected)
})

test("quiet hours use the host time zone and support daytime and all-day windows", () => {
  const notification = { kind: "notice", botId: null } as const
  const now = new Date("2026-10-18T23:00:00Z")
  const daytime = { enabled: true, start: "09:00", end: "17:00", timeZone: "Asia/Tokyo" }

  expect(canDeliverNotification({ notification, preferences: { quietHours: daytime }, now })).toBe(true)
  expect(
    canDeliverNotification({ notification, preferences: { quietHours: { ...daytime, start: "08:00" } }, now }),
  ).toBe(false)
  expect(
    canDeliverNotification({
      notification,
      preferences: { quietHours: { ...daytime, start: "00:00", end: "00:00" } },
      now,
    }),
  ).toBe(false)
})

test.each(["approval", "question", "takeover"] as const)(
  "blocking %s ignores quiet hours and global and bot type mutes",
  (kind) => {
    const notification = { kind, botId: "bot-demo" }
    const now = new Date("2026-10-18T23:00:00Z")
    const preferences: NotificationPreferences = {
      digest: "attention",
      types: { [kind]: false },
      bots: { "bot-demo": { types: { [kind]: false } } },
      quietHours: { enabled: true, start: "00:00", end: "00:00", timeZone: "UTC" },
    }

    const delivered = canDeliverNotification({ notification, preferences, botPreference: "none", now })

    expect(delivered).toBe(true)
    expect(canDeliverNotification({ notification, preferences, enabled: false, now })).toBe(false)
  },
)

test("explicit notices keep their own preference while completions remain quiet by default", () => {
  const notification = { kind: "notice", botId: "bot-demo" } as const

  expect(canDeliverNotification({ notification, botPreference: "failures" })).toBe(true)
  expect(canDeliverNotification({ notification, preferences: { digest: "attention" } })).toBe(true)
  expect(canDeliverNotification({ notification, preferences: { types: { notice: false } } })).toBe(false)
  expect(canDeliverNotification({ notification, botPreference: "none" })).toBe(false)
})

test.each([
  { types: { unknown: true } },
  { types: { approval: "yes" } },
  { bots: { demo: { enabled: "yes" } } },
  { bots: [] },
  { quietHours: { enabled: true, start: "25:00", end: "08:00" } },
  { quietHours: { enabled: true, start: "22:00", end: "08:00", timeZone: "unknown-zone" } },
  { sound: { attention: true, replies: false, volume: 101 } },
  { sound: { attention: "yes" } },
])("invalid notification preferences are rejected: %j", (preferences) => {
  expect(isNotificationPreferences(preferences)).toBe(false)
})

test("sound preferences accept the attention, reply and volume controls", () => {
  expect(isNotificationPreferences({ sound: { attention: true, replies: false, volume: 45 } })).toBe(true)
})

test("muted records remain stored, pending and published while native delivery is suppressed", async () => {
  const fixture = await getFixture()
  savePreferences(fixture.db, { quietHours: { enabled: true, start: "00:00", end: "00:00" } })
  const events = mock()
  fixture.kernel.subscribe(({ event }) => events(event))

  const saved = fixture.emit({
    kind: "turn-failed",
    botId: null,
    threadId: null,
    title: "Revisar arquivo",
    body: "Falha no turno",
    requestId: "request-demo",
  })

  expect(fixture.callHost).not.toHaveBeenCalled()
  expect(fixture.store.pending().map((record) => record.id)).toContain(saved.id)
  expect(events).toHaveBeenCalledWith({ type: "notification.created", notification: saved })
})

test("notification settings round-trip through the API and malformed patches cannot replace them", async () => {
  const fixture = await getFixture()
  const preferences: NotificationPreferences = {
    digest: "all",
    types: { approval: false },
    bots: { "bot-demo": { types: { question: false } } },
    quietHours: { enabled: true, start: "22:00", end: "08:00" },
  }

  const saved = await fixture.request("PATCH", { notificationPreferences: preferences })
  const rejected = await fixture.request("PATCH", {
    notificationPreferences: { quietHours: { enabled: true, start: "bad", end: "08:00" } },
  })
  const restored = await fixture.request("GET")

  expect(saved.status).toBe(200)
  expect(rejected.status).toBe(400)
  expect(await restored.json()).toMatchObject({
    settings: {
      notificationPreferences: {
        ...preferences,
        quietHours: { ...preferences.quietHours, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      },
    },
  })
})

test("no-news notifications store a key and translate it before native delivery", async () => {
  const fixture = await getFixture()
  savePreferences(fixture.db, { digest: "all" })

  const saved = fixture.emit({
    kind: "done",
    botId: null,
    threadId: null,
    title: "Done",
    body: "Analisei as mensagens e não encontrei nada relevante.\n\nNO_NOTIFICATION",
  })

  expect(saved.body).toBe("Routine finished with no news.")
  expect(fixture.store.recent(10)[0]?.body).toBe(saved.body)
  expect(fixture.callHost).toHaveBeenCalledWith(
    "notify",
    expect.objectContaining({ body: getNativeNotificationBody(saved) }),
  )
})

test.each(["O código NO_NOTIFICATION indica uma execução sem novidades.", "Exemplo:\n```text\nNO_NOTIFICATION\n```"])(
  "ordinary completion text can explain the marker: %s",
  async (body) => {
    const fixture = await getFixture()

    const saved = fixture.emit({ kind: "done", botId: null, threadId: null, title: "Done", body })

    expect(saved.body).toBe(body)
  },
)

test("routine markers are handled before a long result is shortened", async () => {
  const fixture = await getFixture()
  const notices = createRuntimeNotices({ kernel: fixture.kernel })
  const summary = `${"Análise detalhada. ".repeat(60)}NO_NOTIFICATION`

  notices.done({ botId: "bot-demo", threadId: "thread-demo", summary, routine: true })

  expect(fixture.store.recent(10)[0]?.body).toBe("Routine finished with no news.")
})

test("notify_user stores muted notifications, reports its rate limit and accepts another bot", async () => {
  const fixture = await getFixture()
  savePreferences(fixture.db, { digest: "all", types: { notice: false } })
  const handler = createNotifyUserHandler({ kernel: fixture.kernel, getNow: () => 1000 })
  const args = { title: "Resultado", body: "Relatório pronto" }

  const first = await handler({ ctx: getContext("bot-demo"), args })
  const limited = await handler({ ctx: getContext("bot-demo"), args })
  const anotherBot = await handler({ ctx: getContext("bot-other"), args })

  expect(first).toMatchObject({
    success: true,
    content: [{ type: "text", text: "Notification saved. Alerts follow your notification preferences." }],
  })
  expect(limited).toMatchObject({
    success: false,
    errorCode: "RATE_LIMITED",
    error: expect.stringContaining("30 seconds"),
  })
  expect(anotherBot.success).toBe(true)
  expect(fixture.store.recent(10)).toHaveLength(2)
  expect(fixture.callHost).not.toHaveBeenCalled()
})

test("notify_user alerts with the default failures preference even when completion alerts are muted", async () => {
  const fixture = await getFixture()
  savePreferences(fixture.db, { types: { done: false } })
  fixture.db
    .query(
      "INSERT INTO bots (id, name, provider, home_dir, created_at, updated_at) VALUES ('bot-demo', 'Demo', 'codex', '.', 1, 1)",
    )
    .run()
  const bot = fixture.kernel.services.use("store.api")?.getBot({ botId: "bot-demo" })
  if (!bot) throw new Error("Missing bot")
  const handler = createNotifyUserHandler({ kernel: fixture.kernel })

  const result = await handler({ ctx: getContext(bot.id), args: { title: "Resultado", body: "Relatório pronto" } })

  expect(bot.notifications).toBe("failures")
  expect(result.success).toBe(true)
  expect(fixture.store.recent(1)[0]?.kind).toBe("notice")
  expect(fixture.callHost).toHaveBeenCalledWith("notify", expect.objectContaining({ kind: "notice" }))
})

test("notify_user accepts the next alert at the rate-limit boundary", async () => {
  const fixture = await getFixture()
  const getNow = mock(() => 31_000)
    .mockReturnValueOnce(1000)
    .mockReturnValueOnce(30_999)
  const handler = createNotifyUserHandler({ kernel: fixture.kernel, getNow })
  const request = { ctx: getContext("bot-demo"), args: { title: "Resultado", body: "Relatório pronto" } }

  const first = await handler(request)
  const early = await handler(request)
  const next = await handler(request)

  expect(first.success).toBe(true)
  expect(early).toMatchObject({ success: false, errorCode: "RATE_LIMITED" })
  expect(next.success).toBe(true)
  expect(fixture.store.recent(10)).toHaveLength(2)
})

const getFixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-notify-preferences-"))
  const runtime = createKernel({ appData: root })
  const callHost = mock<Kernel["callHost"]>(async () => ({
    success: false,
    errorCode: "HOST_UNAVAILABLE",
    error: "No desktop host in this fixture",
  }))
  const kernel: Kernel = { ...runtime.kernel, callHost }
  cleanups.add(() => {
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  await initStore(kernel)
  await initNotify(kernel)
  const db = kernel.db as Database
  const emit = kernel.services.use("notify.emit")
  if (!emit) throw new Error("Missing notifier")

  const { token } = JSON.parse(readFileSync(join(root, "run", "handshake.json"), "utf8")) as { token: string }
  const request = (method: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${runtime.handshake.port}/api/settings`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Touri-Client": "test",
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  return { kernel, db, emit, callHost, store: createNotificationStore({ db }), request }
}

const savePreferences = (db: Database, preferences: NotificationPreferences) => {
  db.query(
    "INSERT INTO settings (key, value_json, updated_at) VALUES ('notificationPreferences', ?, 0) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
  ).run(JSON.stringify(preferences))
}

const getContext = (botId: string): ToolContext => ({
  botId,
  threadId: "thread-demo",
  runId: null,
  projectId: null,
  cwd: "/workspace/demo",
  signal: new AbortController().signal,
})
