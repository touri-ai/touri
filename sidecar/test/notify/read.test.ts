import { afterEach, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Kernel, NotificationRecord, NotifyKind, UiEventEnvelope } from "@touri/contracts"
import { createRateLimiter } from "../../src/cli/auth/rateLimit"
import { openAuthStore } from "../../src/cli/auth/store"
import { createSecretStore } from "../../src/cli/host/secretStore"
import { createWebGate, deviceCookieName, type MemberAuthorizer } from "../../src/cli/web/gate"
import { noAssets } from "../../src/cli/web/uiAssets"
import { initWorkMode } from "../../src/cli/work"
import { openDatabase } from "../../src/kernel/db"
import { createEventBus } from "../../src/kernel/event-bus"
import { createAppPaths } from "../../src/kernel/paths"
import { createRouteRegistry } from "../../src/kernel/routes"
import { createServices } from "../../src/kernel/services"
import { init as initNotify } from "../../src/notify"
import { createNotificationStore } from "../../src/notify/store"

const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  for (const close of cleanups) await close()
  cleanups.clear()
})

test("reading on desktop persists for the same person's mobile device without resolving the notice", async () => {
  const fixture = await getFixture()
  const notice = fixture.emit({ kind: "done", botId: null, threadId: "shared-chat", title: "Resumo", body: "Pronto" })

  const response = await fixture.request(fixture.desktop, "/notifications/read", "POST", { ids: [notice.id] })
  const mobile = await getNotifications(fixture, fixture.mobile)
  const owner = await getNotifications(fixture, fixture.owner)

  expect(response.status).toBe(200)
  expect(mobile[0]).toMatchObject({ id: notice.id, resolvedAt: null, resolution: null })
  expect(mobile[0]?.readAt).toBeNumber()
  expect(owner[0]?.readAt ?? null).toBeNull()
})

test("local native reads use the host owner and are visible on the owner's paired device", async () => {
  const fixture = await getFixture({ workMode: false })
  const notice = fixture.emit({ kind: "done", botId: null, threadId: null, title: "Resumo", body: "Pronto" })

  const response = await fixture.routes.handle({
    method: "POST",
    pathname: "/notifications/read",
    query: new URLSearchParams(),
    body: { ids: [notice.id] },
    signal: new AbortController().signal,
  })
  const mobile = await getNotifications(fixture, fixture.owner)

  expect(response.status).toBe(200)
  expect(mobile[0]?.readAt).toBeNumber()
  expect(mobile[0]?.resolvedAt).toBeNull()
})

test("read receipts survive reopening the host database and repeated reads preserve the first timestamp", async () => {
  const fixture = await getFixture()
  const notice = fixture.emit({ kind: "notice", botId: null, threadId: "shared-chat", title: "Aviso", body: "Salvo" })
  await fixture.request(fixture.desktop, "/notifications/read", "POST", { ids: [notice.id] })
  const original = await getNotifications(fixture, fixture.mobile)

  await fixture.request(fixture.mobile, "/notifications/read", "POST", { ids: [notice.id] })
  const reopened = openDatabase({ filename: join(fixture.root, "touri.db") })
  cleanups.add(async () => reopened.close())
  const store = createNotificationStore({ db: reopened })
  const restored = store.getForPerson(fixture.personId, store.recent(10))

  expect(restored).toEqual(original)
  expect(restored[0]?.readAt).toBeNumber()
  expect(restored[0]?.resolvedAt).toBeNull()
})

test("clearing information preserves every unresolved action, approval decision and channel unread count", async () => {
  const fixture = await getFixture()
  const actionable: NotifyKind[] = [
    "approval",
    "question",
    "takeover",
    "mention",
    "turn-failed",
    "routine-failed",
    "incident",
    "notice",
  ]
  const pending = actionable.map((kind) =>
    fixture.emit({
      kind,
      botId: "demo-bot",
      threadId: "shared-chat",
      title: "Revisar",
      body: "Ação pendente",
      requestId: kind === "notice" ? "pr-ready:fixture" : `pending:${kind}`,
    }),
  )
  const information: NotifyKind[] = ["done", "notice", "task-started", "delegation-settled", "routine-deferred"]
  const recent = information.map((kind) =>
    fixture.emit({ kind, botId: null, threadId: "shared-chat", title: "Informação", body: "Pronto" }),
  )
  fixture.database
    .query("INSERT INTO messages(id,thread_id,role,kind,parts_json,created_at,updated_at) VALUES (?,?,?,'text',?,?,?)")
    .run(
      "pending-message",
      "shared-chat",
      "assistant",
      JSON.stringify([{ type: "approval", approvalId: "pending:approval", decision: "pending" }]),
      1,
      1,
    )
  fixture.database.query("UPDATE threads SET unread = 7 WHERE id = ?").run("shared-chat")

  const response = await fixture.request(fixture.owner, "/notifications/read", "POST", {
    ids: pending.concat(recent).map((item) => item.id),
  })
  const payload = await response.json()
  const notifications = await getNotifications(fixture, fixture.owner)

  expect(response.status).toBe(200)
  expect(payload.skippedIds).toEqual(pending.map((item) => item.id))
  expect(new Set(notifications.filter((item) => item.readAt).map((item) => item.id))).toEqual(
    new Set(recent.map((item) => item.id)),
  )
  expect(notifications.every((item) => item.resolvedAt === null && item.resolution === null)).toBe(true)
  expect(fixture.database.query("SELECT unread FROM threads WHERE id = ?").get("shared-chat")).toEqual({ unread: 7 })
  expect(
    fixture.database
      .query("SELECT decision FROM workspace_message_attention WHERE approval_id = ?")
      .get("pending:approval"),
  ).toEqual({ decision: "pending" })
})

test("resolved history can be read without replacing its recorded decision", async () => {
  const fixture = await getFixture()
  const notice = fixture.emit({
    kind: "approval",
    botId: null,
    threadId: "shared-chat",
    title: "Revisão",
    body: "Decidida",
    requestId: "resolved-approval",
  })
  fixture.kernel.services.use("notify.resolve")?.({ requestId: "resolved-approval", resolution: "deny" })

  const response = await fixture.request(fixture.owner, "/notifications/read", "POST", { ids: [notice.id] })
  const notifications = await getNotifications(fixture, fixture.owner)

  expect(response.status).toBe(200)
  expect(notifications[0]?.readAt).toBeNumber()
  expect(notifications[0]?.resolution).toBe("deny")
  expect(notifications[0]?.resolvedAt).toBeNumber()
})

test("a guessed private notice makes the whole batch fail without writing public receipts", async () => {
  const fixture = await getFixture()
  const shared = fixture.emit({ kind: "done", botId: null, threadId: "shared-chat", title: "Público", body: "Pronto" })
  const privateNotice = fixture.emit({
    kind: "notice",
    botId: null,
    threadId: "shared-chat",
    targetPersonId: "owner",
    title: "Reservado",
    body: "Privado",
  })

  const response = await fixture.request(fixture.desktop, "/notifications/read", "POST", {
    ids: [shared.id, privateNotice.id],
  })

  expect(response.status).toBe(404)
  expect(await response.text()).not.toContain("Privado")
  expect(fixture.database.query("SELECT * FROM notification_reads").all()).toEqual([])
})

test.each([
  { ids: [1], personId: "owner" },
  { ids: [1, 1] },
  { ids: ["1"] },
  { ids: [-1] },
  { ids: [1.5] },
  {},
  { ids: Array.from({ length: 501 }, (_, index) => index + 1) },
])("invalid receipt input is rejected before storage: %j", async (body) => {
  const fixture = await getFixture()

  const response = await fixture.request(fixture.desktop, "/notifications/read", "POST", body)

  expect(response.status).toBe(400)
  expect(fixture.database.query("SELECT * FROM notification_reads").all()).toEqual([])
})

test("unauthenticated and revoked devices cannot write receipts", async () => {
  const fixture = await getFixture()
  const device = fixture.authStore.verifyDeviceToken(fixture.desktop)
  if (!device) throw new Error("Missing synthetic device")
  await fixture.authStore.revokeDevice(device.id)

  const revoked = await fixture.request(fixture.desktop, "/notifications/read", "POST", { ids: [] })
  const unauthenticated = await fixture.request("invalid", "/notifications/read", "POST", { ids: [] })

  expect(revoked.status).toBe(401)
  expect(unauthenticated.status).toBe(401)
  expect(fixture.database.query("SELECT * FROM notification_reads").all()).toEqual([])
})

test("cookie-authenticated read writes keep the existing Origin and CSRF protection", async () => {
  const fixture = await getFixture()
  const credentials = { Authorization: "", Cookie: `${deviceCookieName}=${fixture.desktop}` }

  const denied = await fixture.request(
    "",
    "/notifications/read",
    "POST",
    { ids: [] },
    Object.assign({}, credentials, { Origin: "https://foreign.example.test" }),
  )
  const accepted = await fixture.request(
    "",
    "/notifications/read",
    "POST",
    { ids: [] },
    Object.assign({}, credentials, { Origin: "https://touri.example.test" }),
  )

  expect(denied.status).toBe(403)
  expect(accepted.status).toBe(200)
})

test("failed receipt storage rolls back the batch and publishes no successful read", async () => {
  const fixture = await getFixture()
  const notices = ["Primeiro", "Segundo"].map((title) =>
    fixture.emit({ kind: "done", botId: null, threadId: "shared-chat", title, body: "Pronto" }),
  )
  fixture.database.exec(`CREATE TRIGGER reject_receipt BEFORE INSERT ON notification_reads
    WHEN NEW.notification_id = ${notices[1]?.id} BEGIN SELECT RAISE(ABORT, 'Synthetic storage failure'); END`)
  const received = new Set<string>()
  fixture.kernel.subscribe(({ event }) => received.add(event.type))

  const response = await fixture.request(fixture.desktop, "/notifications/read", "POST", {
    ids: notices.map((item) => item.id),
  })

  expect(response.status).toBe(500)
  expect(fixture.database.query("SELECT * FROM notification_reads").all()).toEqual([])
  expect(received.has("notifications.read")).toBe(false)
})

test("live and replayed read updates reach only the same person, including admin isolation", async () => {
  const fixture = await getFixture()
  const notice = fixture.emit({ kind: "done", botId: null, threadId: "shared-chat", title: "Resumo", body: "Pronto" })
  const mobile = getEventViewer(fixture, fixture.personId, "member")
  const other = getEventViewer(fixture, "owner", "admin")

  await fixture.request(fixture.desktop, "/notifications/read", "POST", { ids: [notice.id] })
  const reloaded = getEventViewer(fixture, fixture.personId, "member")

  expect(mobile.getEvents().some((item) => item.event?.type === "notifications.read")).toBe(true)
  expect(other.getEvents().some((item) => item.event?.type === "notifications.read")).toBe(false)
  expect(reloaded.getEvents().some((item) => item.event?.type === "notifications.read")).toBe(true)
})

const getEventViewer = (
  fixture: Awaited<ReturnType<typeof getFixture>>,
  personId: string,
  role: "member" | "admin",
) => {
  const frames = new Set<string>()
  fixture.events.add(
    {
      readyState: 1,
      sendText: (frame) => {
        frames.add(frame)
        return frame.length
      },
    },
    1,
    (event) => fixture.kernel.services.use("work.visibleEvent")?.({ personId, role, event }) ?? false,
  )

  return { getEvents: () => Array.from(frames, (frame) => JSON.parse(frame) as UiEventEnvelope) }
}

const getNotifications = async (fixture: Awaited<ReturnType<typeof getFixture>>, token: string) => {
  const response = await fixture.request(token, "/notifications")
  const body = (await response.json()) as { notifications: Array<NotificationRecord & { readAt?: number | null }> }

  return body.notifications
}

const getFixture = async ({ workMode = true } = {}) => {
  const root = await mkdtemp(join(tmpdir(), "touri-notice-read-"))
  const authStore = await openAuthStore({ filename: join(root, "auth.db") })
  const secrets = createSecretStore({ dir: root, env: { TOURI_SECRETS_KEY: "synthetic-test-key" } })
  const authorization: { authorize: MemberAuthorizer | null } = { authorize: null }
  const gate = createWebGate({
    store: authStore,
    secrets,
    ui: noAssets,
    limiter: createRateLimiter({ maxFailures: 8, windowMs: 60_000 }),
    authorizeMember: (input) => authorization.authorize?.(input) ?? null,
  })
  const database = openDatabase({ filename: join(root, "touri.db") })
  const events = createEventBus(database)
  const routes = createRouteRegistry()
  const kernel: Kernel = {
    paths: createAppPaths({ appData: root }),
    db: database,
    services: createServices(),
    publish: events.publish,
    subscribe: events.subscribe,
    registerRoutes: routes.registerRoutes,
    registerTools: () => ({ success: true, count: 0 }),
    spawnTree: () => ({ success: false, errorCode: "SPAWN_FAILED", error: "Synthetic host" }),
    callHost: async () => ({ success: false, errorCode: "HOST_UNAVAILABLE", error: "Synthetic host" }),
    onHostNotification: () => () => undefined,
    redact: (text) => text,
    addRedactionValue: () => undefined,
    shellEnv: async () => ({}),
    newId: randomUUID,
    log: () => undefined,
  }
  cleanups.add(async () => {
    await kernel.services.use("notify.recovery")?.dispose()
    await events.stop()
    database.close()
    await authStore.close()
    await rm(root, { recursive: true, force: true })
  })
  if (workMode) initWorkMode({ kernel, authStore, secrets, authorization })
  await initNotify(kernel)
  await kernel.services.use("notify.recovery")?.ready
  database
    .query("INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run("demo-bot", "Demo", "codex", "/fixture/bot", 1, 1)
  database
    .query(
      "INSERT INTO bot_groups(id,name,color,avatar_shape,avatar_seed,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    )
    .run("shared-channel", "Avisos", "#888888", "classic-none", "demo", 1, 1)
  database
    .query("INSERT INTO threads(id,bot_id,title,group_id,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run("shared-chat", "demo-bot", "Conversa fictícia", "shared-channel", 1, 1)
  const invite = await authStore.createInvite({
    actorPersonId: "owner",
    name: "Pessoa fictícia",
    email: "member@example.test",
    role: "member",
    channelIds: ["shared-channel"],
  })
  if (!invite.success) throw new Error("Synthetic invite failed")
  const desktop = await authStore.claimInvite({
    token: invite.token,
    email: "member@example.test",
    deviceName: "Desktop",
  })
  if (!desktop.success) throw new Error("Synthetic desktop failed")
  const pairing = await authStore.createPersonPairingCode(desktop.person.id)
  if (!pairing.success) throw new Error("Synthetic pairing failed")
  const mobile = await authStore.claimPairingCode({ code: pairing.code, deviceName: "Mobile" })
  const owner = await authStore.claimPairingCode({
    code: (await authStore.createPairingCode()).code,
    deviceName: "Owner",
  })
  if (!mobile.success || !owner.success) throw new Error("Synthetic device failed")
  const request = async (
    token: string,
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const url = new URL(`/api/v1${path}`, "https://touri.example.test")
    const request = new Request(url, {
      method,
      headers: Object.assign(
        {
          Authorization: `Bearer ${token}`,
          "X-Touri-Client": "test",
          "Content-Type": "application/json",
          Host: url.host,
        },
        headers,
      ),
      body: body === undefined ? null : JSON.stringify(body),
    })
    const blocked = await gate({ request, url, clientIp: "127.0.0.1" })
    if (blocked) return blocked

    const response = await routes.handle({
      method,
      pathname: url.pathname.slice("/api/v1".length),
      query: url.searchParams,
      body,
      signal: request.signal,
    })
    if (!("json" in response)) throw new Error("Expected a synthetic JSON response")

    return Response.json(response.json, { status: response.status })
  }
  const emit = kernel.services.use("notify.emit")
  if (!emit) throw new Error("Missing notifier")

  return {
    root,
    database,
    kernel,
    events,
    routes,
    authStore,
    personId: desktop.person.id,
    desktop: desktop.token,
    mobile: mobile.token,
    owner: owner.token,
    request,
    emit,
  }
}
