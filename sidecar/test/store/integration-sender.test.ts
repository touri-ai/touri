import type { Database } from "bun:sqlite"
import { afterEach, expect, mock, setDefaultTimeout, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ApiRoutes, Kernel } from "@touri/contracts"
import { createRateLimiter } from "../../src/cli/auth/rateLimit"
import { openAuthStore } from "../../src/cli/auth/store"
import { createSecretStore } from "../../src/cli/host/secretStore"
import { createWebGate, deviceCookieName } from "../../src/cli/web/gate"
import { init as initGroups } from "../../src/groups"
import { createGroupStore } from "../../src/groups/store"
import { createKernel } from "../../src/kernel"
import { init as initNotify } from "../../src/notify"
import { createNotificationStore } from "../../src/notify/store"
import { init as initStore } from "../../src/store"

setDefaultTimeout(30_000)
const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  await Promise.all(Array.from(cleanups, (cleanup) => cleanup()))
  cleanups.clear()
})

const getFixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "touri-integration-"))
  const auth = await openAuthStore({ filename: join(directory, "auth.db") })
  const pairing = await auth.createPairingCode()
  const paired = await auth.claimPairingCode({ code: pairing.code, deviceName: "Automation" })
  if (!paired.success) throw new Error("Synthetic pairing failed")
  const intercept = createWebGate({
    store: auth,
    limiter: createRateLimiter({ maxFailures: 10, windowMs: 60_000 }),
    secrets: createSecretStore({ dir: directory, env: { TOURI_SECRETS_KEY: "synthetic-test-key" } }),
    ui: { source: "embedded", get: () => null },
  })
  const callHost = mock<Kernel["callHost"]>(async () => ({
    success: false,
    errorCode: "HOST_UNAVAILABLE",
    error: "Synthetic host",
  }))
  const runtime = createKernel({
    appData: directory,
    web: { hostname: "127.0.0.1", port: 0, intercept, host: () => callHost },
  })
  cleanups.add(async () => {
    await runtime.stop()
    await auth.close()
    await rm(directory, { recursive: true, force: true })
  })
  const kernel = runtime.kernel
  await initStore(kernel)
  await initGroups(kernel)
  await initNotify(kernel)
  kernel.services.provide("work.channelPeople", () => [
    { id: "owner", name: "Pessoa A", handle: "pessoa", avatarSeed: "owner", role: "admin" },
  ])
  const database = kernel.db as Database
  database
    .query("INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES(?,?,?,?,?,?)")
    .run("atlas", "Atlas", "codex", join(directory, "atlas"), 1, 1)
  const groups = createGroupStore(kernel)
  const group = groups.save({
    name: "avisos",
    avatarShape: "classic-none",
    color: "#2563eb",
    memberIds: ["atlas"],
    coordinatorBotId: "atlas",
  })
  const thread = groups.createThread(group)
  const enqueue = mock(() => ({
    success: false as const,
    errorCode: "BOT_PAUSED" as const,
    error: "Synthetic runtime",
  }))
  kernel.services.provide("runtime.enqueue", enqueue)
  const store = kernel.services.use("store.api")
  if (!store) throw new Error("Store missing")
  const notifications = createNotificationStore({ db: database })
  const headers = {
    Authorization: `Bearer ${paired.token}`,
    "X-Touri-Client": "touri avisos",
    "Content-Type": "application/json",
  }
  const post = (body: unknown, extraHeaders: Record<string, string> = {}, threadId = thread.id) =>
    fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1/threads/${threadId}/messages`, {
      method: "POST",
      headers: { ...headers, ...extraHeaders },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
  const getMessages = () =>
    fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1/threads/${thread.id}/messages`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    })
  const flushEvents = () =>
    new Promise<void>((resolve) => {
      const unsubscribe = kernel.subscribe(({ event }) => {
        if (event.type !== "transcript.superseded") return
        unsubscribe()
        resolve()
      })
      kernel.publish({ type: "transcript.superseded" })
    })
  return {
    auth,
    paired,
    kernel,
    database,
    store,
    thread,
    enqueue,
    callHost,
    post,
    getMessages,
    flushEvents,
    getNotes: () => notifications.recent(50),
  }
}

const getNotice = (text = "Publicação concluída", clientNonce = "notice-one") => ({
  text,
  parentId: null,
  attachmentIds: [],
  clientNonce,
  as: { kind: "integration" },
})

test("an authenticated script has persistent identity, unread count and one notification across retries", async () => {
  const fixture = await getFixture()

  const response = await fixture.post(getNotice())
  const result = (await response.json()) as ApiRoutes["POST /threads/:id/messages"]["res"]
  const replay = await fixture.post(getNotice())
  const history = await fixture.getMessages()
  const saved = (await history.json()) as ApiRoutes["GET /threads/:id/messages"]["res"]
  await fixture.flushEvents()

  expect(response.status).toBe(201)
  expect(replay.status).toBe(200)
  expect(history.status).toBe(200)
  expect(saved.messages[0]?.sender).toEqual(result.message.sender)
  expect(result.message.sender).toMatchObject({ name: "touri avisos", kind: "integration" })
  expect(result.message.sender?.id).toStartWith("integration:")
  expect(result.message.sender?.avatarSeed).toBe(result.message.sender?.id)
  expect(result.run).toBeNull()
  expect(fixture.enqueue).not.toHaveBeenCalled()
  expect(fixture.store.activePath({ threadId: fixture.thread.id })[0]?.sender).toEqual(result.message.sender)
  expect(fixture.store.getThread({ threadId: fixture.thread.id })?.unread).toBe(1)
  expect(fixture.getNotes()).toMatchObject([{ kind: "notice", targetPersonId: "owner", body: "Publicação concluída" }])
  expect(fixture.getNotes()).toHaveLength(1)
  expect(fixture.callHost).toHaveBeenCalledWith("notify", expect.objectContaining({ kind: "notice" }))
})

test("a person mention pings the owner once without dispatching the channel bot", async () => {
  const fixture = await getFixture()

  const response = await fixture.post({
    ...getNotice("@pessoa precisa revisar"),
    as: { kind: "integration", name: "publicação" },
  })
  await fixture.flushEvents()

  expect(response.status).toBe(201)
  expect(fixture.enqueue).not.toHaveBeenCalled()
  expect(fixture.getNotes()).toMatchObject([
    { kind: "mention", targetPersonId: "owner", title: "@publicação mencionou você em #avisos" },
  ])
  expect(fixture.getNotes()).toHaveLength(1)
})

test("an integration dispatches a bot only with an explicit bot mention", async () => {
  const fixture = await getFixture()

  const response = await fixture.post(getNotice("@Atlas revise esta publicação"))

  expect(response.status).toBe(409)
  expect(fixture.enqueue).toHaveBeenCalledTimes(1)
  expect(fixture.enqueue).toHaveBeenCalledWith(
    expect.objectContaining({ threadId: fixture.thread.id, trigger: "user" }),
  )
})

test.each([
  false,
  { enabled: false },
  { types: { notice: false } },
  { quietHours: { enabled: true, start: "00:00", end: "00:00" } },
])("muted notices remain in history and unread counts: %j", async (preference) => {
  const fixture = await getFixture()
  const key = preference === false ? "nativeNotifications" : "notificationPreferences"
  fixture.database
    .query("INSERT OR REPLACE INTO settings(key,value_json,updated_at) VALUES(?,?,?)")
    .run(key, JSON.stringify(preference), 1)

  const response = await fixture.post(getNotice())
  await fixture.flushEvents()

  expect(response.status).toBe(201)
  expect(fixture.callHost).not.toHaveBeenCalled()
  expect(fixture.getNotes()).toHaveLength(1)
  expect(fixture.store.getThread({ threadId: fixture.thread.id })?.unread).toBe(1)
})

test("member tokens, cookies, unauthenticated requests and revoked tokens cannot post as an integration", async () => {
  const fixture = await getFixture()
  const invite = await fixture.auth.createInvite({
    actorPersonId: "owner",
    name: "Pessoa B",
    email: "member@example.test",
    role: "member",
    channelIds: [],
  })
  if (!invite.success) throw new Error("Synthetic invite failed")
  const member = await fixture.auth.claimInvite({
    token: invite.token,
    email: "member@example.test",
    deviceName: "Member device",
  })
  if (!member.success) throw new Error("Synthetic invitation claim failed")

  const forbidden = await fixture.post(getNotice(), { Authorization: `Bearer ${member.token}` })
  const anonymous = await fixture.post(getNotice(), { Authorization: "" })
  const cookie = await fixture.post(getNotice(), {
    Authorization: "",
    Cookie: `${deviceCookieName}=${fixture.paired.token}`,
  })
  await fixture.auth.revokeDevice(fixture.paired.device.id)
  const revoked = await fixture.post(getNotice())

  expect(forbidden.status).toBe(403)
  expect(anonymous.status).toBe(401)
  expect(cookie.status).toBe(403)
  expect(revoked.status).toBe(401)
  expect(fixture.store.activePath({ threadId: fixture.thread.id })).toEqual([])
})

test.each([
  { kind: "person", name: "Pessoa A" },
  { kind: "integration", name: "Pessoa A" },
  { kind: "integration", name: "Atlas" },
  { kind: "integration", name: "owner" },
  { kind: "integration", name: "pessoa" },
  { kind: "integration", name: "Átlas" },
  { kind: "integration", name: "x\u200by" },
  { kind: "integration", name: "x".repeat(81) },
  { kind: "integration", name: "automation", id: "owner" },
  { kind: "integration", name: "automation", avatarSeed: "owner" },
])("integration identities reject impersonation and invalid names: %j", async (sender) => {
  const fixture = await getFixture()

  const response = await fixture.post({ ...getNotice(), as: sender })

  expect(response.status).toBe(400)
  expect(fixture.store.activePath({ threadId: fixture.thread.id })).toEqual([])
  expect(fixture.enqueue).not.toHaveBeenCalled()
})

test("integration content cannot resolve a person's question or override mention routing", async () => {
  const fixture = await getFixture()
  fixture.kernel.services.use("notify.emit")?.({
    kind: "question",
    botId: "atlas",
    threadId: fixture.thread.id,
    requestId: "pending-question",
    title: "Revisar?",
    body: "Preciso da sua decisão",
  })

  const response = await fixture.post({
    ...getNotice(),
    sender: { kind: "person", id: "owner", name: "Pessoa A" },
    groupAction: "ask_all",
  })
  const ordinary = await fixture.post({ ...getNotice(), sender: { kind: "person", id: "owner", name: "Pessoa A" } })
  await fixture.flushEvents()

  expect(response.status).toBe(400)
  expect(ordinary.status).toBe(201)
  expect(fixture.enqueue).not.toHaveBeenCalled()
  expect(fixture.getNotes().find((note) => note.kind === "question")?.resolvedAt).toBeNull()
  expect(fixture.store.activePath({ threadId: fixture.thread.id })[0]?.sender?.kind).toBe("integration")
})

test("integration sends are limited to channels and cannot borrow another sender's nonce", async () => {
  const fixture = await getFixture()
  const privateThread = fixture.store.createThread({ botId: "atlas", kind: "chat", title: "Privado" })
  if (!privateThread.success) throw new Error(privateThread.error)

  const privateResponse = await fixture.post(getNotice(), {}, privateThread.thread.id)
  const first = await fixture.post(getNotice())
  const conflict = await fixture.post({ ...getNotice(), as: { kind: "integration", name: "outro script" } })

  expect(privateResponse.status).toBe(400)
  expect(first.status).toBe(201)
  expect(conflict.status).toBe(409)
  expect(fixture.store.getThread({ threadId: fixture.thread.id })?.unread).toBe(1)
})
