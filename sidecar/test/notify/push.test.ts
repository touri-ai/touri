import type { Database } from "bun:sqlite"
import { afterEach, expect, mock, test } from "bun:test"
import { createECDH, randomBytes } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ApiRoutes, Kernel, NotificationRecord } from "@touri/contracts"
import { generateVAPIDKeys } from "web-push"
import type { Person } from "../../src/cli/auth/store"
import { createSecretStore } from "../../src/cli/host/secretStore"
import { init as initGroups } from "../../src/groups"
import { createGroupStore } from "../../src/groups/store"
import { createKernel } from "../../src/kernel"
import { bindDeviceSession } from "../../src/kernel/device-session"
import { createRouteRegistry } from "../../src/kernel/routes"
import { init as initNotify } from "../../src/notify"
import { getPushPayload, initWebPush } from "../../src/notify/push"
import { createPushStore } from "../../src/notify/push-store"
import { getPushAccount, getPushSubscription, sendWebPush } from "../../src/notify/push-transport"
import { createRuntimeNotices } from "../../src/runtime/notices"
import { init as initStore } from "../../src/store"

const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup()
  cleanups.clear()
})

const getPerson = (): Person => ({
  id: "owner",
  name: "Pessoa de teste",
  email: null,
  avatarSeed: "demo",
  role: "admin",
  createdAt: 1,
  removedAt: null,
})

const getSubscription = () => {
  const curve = createECDH("prime256v1")

  return {
    endpoint: "https://web.push.apple.com/test/synthetic",
    keys: { p256dh: curve.generateKeys().toString("base64url"), auth: randomBytes(16).toString("base64url") },
    locale: "pt-BR" as const,
  }
}

const getFixture = async ({
  getPersonForDevice = () => getPerson(),
  send = mock<typeof sendWebPush>(async () => 201),
  now = Date.now,
}: {
  getPersonForDevice?: (id: string) => Person | null
  send?: ReturnType<typeof mock<typeof sendWebPush>>
  now?: () => number
} = {}) => {
  const root = await mkdtemp(join(tmpdir(), "touri-owner-push-"))
  const host = createKernel({ appData: root })
  const routes = createRouteRegistry()
  const callHost = mock<Kernel["callHost"]>(async () => ({
    success: false,
    errorCode: "HOST_UNAVAILABLE",
    error: "Synthetic host",
  }))
  const kernel: Kernel = {
    ...host.kernel,
    callHost,
    registerRoutes: (module) => {
      routes.registerRoutes(module)
      host.kernel.registerRoutes(module)
    },
  }
  const database = kernel.db as Database
  const secrets = createSecretStore({ dir: root })
  await initStore(kernel)
  await initGroups(kernel)
  await initNotify(kernel)
  const push = await initWebPush({ kernel, authStore: { getPersonForDevice }, secrets, send, now, schedule: false })
  cleanups.add(async () => {
    await push.stop()
    await host.stop()
    await rm(root, { recursive: true, force: true })
  })
  database
    .query(
      "INSERT INTO bots(id, name, provider, home_dir, notifications, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run("demo-bot", "Bot de teste", "codex", join(root, "bot"), "all", 1, 1)
  const store = kernel.services.use("store.api")
  if (!store) throw new Error("Missing store")
  const created = store.createThread({ botId: "demo-bot", kind: "main", title: "Conversa fictícia" })
  if (!created.success) throw new Error("Missing thread")
  const groups = createGroupStore(kernel)
  const group = groups.save({
    name: "avisos",
    color: "#2563eb",
    avatarShape: "classic-none",
    memberIds: ["demo-bot"],
    coordinatorBotId: null,
  })
  const channel = groups.createThread(group)
  const signal = new AbortController().signal
  bindDeviceSession(signal, {
    deviceId: "phone",
    person: getPerson(),
    active: () => Boolean(getPersonForDevice("phone")),
    origin: "https://touri.example",
  })
  const call = (method: string, pathname: string, body: unknown = {}, actor = signal) =>
    routes.handle({ method, pathname, body, signal: actor, query: new URLSearchParams() })
  const subscription = getSubscription()
  const registered = await call("PUT", "/push", subscription)
  expect(registered?.status).toBe(200)
  const emit = kernel.services.use("notify.emit")
  if (!emit) throw new Error("Missing notifier")

  return {
    root,
    kernel,
    database,
    secrets,
    push,
    send,
    callHost,
    store,
    thread: created.thread,
    channel,
    call,
    emit,
    signal,
    subscription,
    notices: createRuntimeNotices({ kernel }),
  }
}

test.each(["done", "approval", "question", "turn-failed"] as const)(
  "%s reaches native delivery and push once with the exact conversation",
  async (kind) => {
    const fixture = await getFixture()
    const { notices, thread } = fixture
    const target = { botId: "demo-bot", threadId: thread.id }

    if (kind === "done") notices.done({ ...target, summary: "Private task detail" })
    if (kind === "approval")
      notices.approval({ ...target, requestId: "approval-demo", request: "command", detail: "Private command" })
    if (kind === "question")
      notices.prompt({
        ...target,
        requestId: "question-demo",
        toolName: "AskUserQuestion",
        input: { question: "Private question" },
        detail: "",
      })
    if (kind === "turn-failed") notices.failure({ ...target, routine: false, reason: "Private failure" })
    await fixture.push.drain()
    await fixture.push.drain()

    expect(fixture.send).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(fixture.send.mock.calls[0]?.[0].payload ?? "{}")
    expect(new URL(payload.url, "https://touri.example").searchParams.get("thread")).toBe(thread.id)
    expect(payload).toMatchObject({ title: "touri" })
    expect(JSON.stringify(payload)).not.toContain("Private")
    expect(
      fixture.callHost.mock.calls.some(
        ([method, params]) => method === "notify" && "kind" in params && params.kind === kind,
      ),
    ).toBe(true)
  },
)

test("review notices persist once and link push to #avisos without starting a bot", async () => {
  const fixture = await getFixture()
  const notice = { kind: "pr-ready", eventId: "demo:review:42", text: "Revisão fictícia pronta" }

  const first = await fixture.call("POST", `/threads/${fixture.channel.id}/notices`, notice)
  const repeated = await fixture.call("POST", `/threads/${fixture.channel.id}/notices`, notice)
  await fixture.push.drain()

  expect(first?.status).toBe(200)
  expect(repeated).toEqual(first)
  expect(fixture.send).toHaveBeenCalledTimes(1)
  expect(fixture.send.mock.calls[0]?.[0].payload).toContain("Uma revisão está pronta")
  expect(fixture.store.activePath({ threadId: fixture.channel.id })).toHaveLength(1)
  expect(fixture.database.query("SELECT count(*) AS total FROM runs").get()).toEqual({ total: 0 })
})

test("the existing authenticated automation client produces one review notice while normal user messages stay quiet", async () => {
  const fixture = await getFixture()
  const automated = new AbortController().signal
  bindDeviceSession(automated, { deviceId: "phone", person: getPerson(), active: () => true, automation: "notices" })
  const path = `/threads/${fixture.channel.id}/messages`
  const text = "READY https://github.com/touri-ai/touri/pull/42"

  await fixture.call("POST", path, { text }, fixture.signal)
  await fixture.push.drain()
  expect(fixture.send).not.toHaveBeenCalled()
  await fixture.call("POST", path, { text }, automated)
  await fixture.call("POST", path, { text }, automated)
  await fixture.push.drain()

  expect(fixture.send).toHaveBeenCalledTimes(1)
  expect(fixture.send.mock.calls[0]?.[0].payload).toContain("Uma revisão está pronta")
})

test("explicit integration sends preserve their provenance and validation for the legacy client", async () => {
  const fixture = await getFixture()
  const automated = new AbortController().signal
  bindDeviceSession(automated, {
    deviceId: "phone",
    person: getPerson(),
    active: () => true,
    automation: "notices",
    scopes: ["integration:write"],
    clientName: "touri-notify",
  })
  const path = `/threads/${fixture.channel.id}/messages`

  const accepted = await fixture.call("POST", path, { text: "Aviso fictício", as: { kind: "integration" } }, automated)
  const denied = await fixture.call("POST", path, { text: "Aviso fictício", as: { kind: "person" } }, automated)

  expect(accepted).toMatchObject({ status: 201, json: { message: { sender: { kind: "integration" } } } })
  expect(denied).toMatchObject({ status: 400, json: { errorCode: "INVALID_INTEGRATION" } })
})

test("scheduled delivery starts explicitly once after initialization", async () => {
  const delivered = Promise.withResolvers<void>()
  const send = mock<typeof sendWebPush>(async () => {
    delivered.resolve()
    return 201
  })
  const fixture = await getFixture({ send })
  fixture.notices.done({ botId: "demo-bot", threadId: fixture.thread.id, summary: "Tarefa fictícia concluída" })
  expect(send).not.toHaveBeenCalled()

  fixture.push.start()
  fixture.push.start()
  await delivered.promise
  await fixture.push.stop()

  expect(send).toHaveBeenCalledTimes(1)
})

test("canceling a push test cancels its upstream request", async () => {
  const started = Promise.withResolvers<AbortSignal>()
  const send = mock<typeof sendWebPush>(async ({ signal }) => {
    started.resolve(signal)
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
    throw new Error("Synthetic cancellation")
  })
  const fixture = await getFixture({ send })
  const request = new AbortController()
  bindDeviceSession(request.signal, { deviceId: "phone", person: getPerson(), active: () => true })

  const pending = fixture.call("POST", "/push/test", {}, request.signal)
  const upstream = await started.promise
  request.abort()
  const response = await pending

  expect(upstream.aborted).toBe(true)
  expect(response?.status).toBe(503)
})

test("registration secrets stay encrypted and only device metadata enters the database", async () => {
  const fixture = await getFixture()

  const encrypted = await readFile(join(fixture.root, "secrets.enc"), "utf8")
  const rows = fixture.database.query("SELECT * FROM push_devices").all()
  const stored = await fixture.secrets.getAsync(getPushAccount("phone"))

  expect(encrypted).not.toContain(fixture.subscription.endpoint)
  expect(encrypted).not.toContain(fixture.subscription.keys.auth)
  expect(JSON.stringify(rows)).not.toContain(fixture.subscription.keys.auth)
  expect(JSON.parse(stored ?? "null")).toEqual(fixture.subscription)
})

test("revoked devices and members outside the conversation never receive push", async () => {
  const person = mock((): Person | null => getPerson())
  const fixture = await getFixture({ getPersonForDevice: person })
  fixture.emit({
    kind: "approval",
    botId: "demo-bot",
    threadId: fixture.thread.id,
    requestId: "request-demo",
    title: "Approval",
    body: "Details",
  })

  person.mockReturnValue({ ...getPerson(), id: "other-person", role: "member" })
  await fixture.push.drain()
  person.mockReturnValue(null)
  fixture.emit({ kind: "question", botId: "demo-bot", threadId: fixture.thread.id, title: "Question", body: "Details" })
  await fixture.push.drain()

  expect(fixture.send).not.toHaveBeenCalled()
})

test("a resolved request, disabled delivery and quiet results are not sent", async () => {
  const fixture = await getFixture()
  const notification = fixture.emit({
    kind: "approval",
    botId: "demo-bot",
    threadId: fixture.thread.id,
    requestId: "request-demo",
    title: "Approval",
    body: "Details",
  })
  fixture.kernel.services.use("notify.resolve")?.({ requestId: notification.requestId ?? "", resolution: "allow" })
  const preferences = { quietHours: { enabled: true, start: "00:00", end: "00:00" } }
  fixture.database
    .query("INSERT OR REPLACE INTO settings(key,value_json,updated_at) VALUES ('notificationPreferences',?,1)")
    .run(JSON.stringify(preferences))

  fixture.notices.done({ botId: "demo-bot", threadId: fixture.thread.id, summary: "Done" })
  await fixture.push.drain()
  fixture.database
    .query("INSERT OR REPLACE INTO settings(key,value_json,updated_at) VALUES ('nativeNotifications','false',1)")
    .run()
  fixture.notices.prompt({
    botId: "demo-bot",
    threadId: fixture.thread.id,
    requestId: "next-question",
    toolName: "AskUserQuestion",
    input: {},
    detail: "",
  })
  await fixture.push.drain()

  expect(fixture.send).not.toHaveBeenCalled()
})

test("failed deliveries survive reopening the sender and expired subscriptions are removed", async () => {
  const send = mock<typeof sendWebPush>(async () => 503)
  const fixture = await getFixture({ send, now: () => 1000 })
  fixture.notices.failure({ botId: "demo-bot", threadId: fixture.thread.id, routine: false, reason: "Failed" })
  await fixture.push.drain()
  await fixture.push.stop()
  const retried = mock<typeof sendWebPush>(async () => 410)
  const reopened = await initWebPush({
    kernel: fixture.kernel,
    authStore: { getPersonForDevice: getPerson },
    secrets: fixture.secrets,
    send: retried,
    now: () => 10_000,
    schedule: false,
  })
  cleanups.add(reopened.stop)

  await reopened.drain()

  expect(send).toHaveBeenCalledTimes(1)
  expect(retried).toHaveBeenCalledTimes(1)
  expect(createPushStore(fixture.database).getDevice("phone")).toBeNull()
  expect(await fixture.secrets.getAsync(getPushAccount("phone"))).toBeNull()
})

test("registration requires an active device, HTTPS and administrator authority for review publication", async () => {
  const fixture = await getFixture()
  const anonymous = new AbortController().signal
  const member = new AbortController().signal
  bindDeviceSession(member, {
    deviceId: "member",
    person: { ...getPerson(), role: "member" },
    active: () => true,
    origin: "http://touri.example",
  })

  const unauthorized = await fixture.call("GET", "/push", {}, anonymous)
  const insecure = await fixture.call("PUT", "/push", fixture.subscription, member)
  const notice = await fixture.call(
    "POST",
    `/threads/${fixture.channel.id}/notices`,
    { kind: "pr-ready", eventId: "demo", text: "Hello" },
    member,
  )

  expect(unauthorized?.status).toBe(403)
  expect(insecure?.status).toBe(403)
  expect(notice?.status).toBe(403)
})

test.each([
  "http://127.0.0.1/test",
  "https://127.0.0.1/test",
  "https://example.com/test",
  "https://web.push.apple.com.attacker.example/test",
  "https://user:pass@web.push.apple.com/test",
  "https://web.push.apple.com:8443/test",
])("rejects push endpoint %s", (endpoint) => {
  const subscription = getSubscription()

  expect(getPushSubscription({ ...subscription, endpoint })).toBeNull()
})

test("push payloads translate event types without including task content", () => {
  const notification = { id: 1, kind: "done", botId: null, threadId: "demo", requestId: null } as NotificationRecord

  expect(getPushPayload("en", notification).body).toBe("The bot finished. Open the conversation to see the result.")
  expect(getPushPayload("pt-BR", { ...notification, kind: "approval" }).body).toContain("precisa de você")
})

test("transport encrypts the payload and rejects redirects with a finite deadline", async () => {
  const getResponse = Object.assign(async (..._args: Parameters<typeof fetch>) => new Response(null, { status: 201 }), {
    preconnect: () => undefined,
  })
  const network = Object.assign(mock(getResponse), { preconnect: getResponse.preconnect })
  const payload = JSON.stringify({ body: "Synthetic private detail" })

  const status = await sendWebPush({
    subscription: getSubscription(),
    keys: generateVAPIDKeys(),
    payload,
    signal: new AbortController().signal,
    fetch: network,
  })

  expect(status).toBe(201)
  const request = network.mock.calls[0]?.[1]
  expect(request?.body).toBeInstanceOf(Uint8Array)
  expect(request?.redirect).toBe("error")
  expect(request?.signal).toBeInstanceOf(AbortSignal)
  if (request?.body instanceof Uint8Array)
    expect(new TextDecoder().decode(request.body)).not.toContain("Synthetic private detail")
})

test("the outbox uses indexed due and retention queries", async () => {
  const fixture = await getFixture()

  const due = fixture.database
    .query(
      "EXPLAIN QUERY PLAN SELECT * FROM push_deliveries WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 2",
    )
    .all(1000)
  const expiry = fixture.database
    .query("EXPLAIN QUERY PLAN SELECT rowid FROM push_deliveries WHERE expires_at <= ? ORDER BY expires_at LIMIT 100")
    .all(1000)

  expect(JSON.stringify(due)).toContain("push_deliveries_due")
  expect(JSON.stringify(expiry)).toContain("push_deliveries_expiry")
})

test("automatic channel summaries retain uploaded image attachments and reject missing attachment ids", async () => {
  const fixture = await getFixture()
  const automated = new AbortController().signal
  bindDeviceSession(automated, { deviceId: "phone", person: getPerson(), active: () => true, automation: "notices" })
  const uploaded = await fixture.call(
    "POST",
    "/attachments",
    {
      name: "demo-screen.png",
      dataBase64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64"),
    },
    automated,
  )
  if (!uploaded || !("json" in uploaded)) throw new Error("Missing upload response")
  const attachment = (uploaded.json as { attachment: { id: string } }).attachment

  const response = await fixture.call(
    "POST",
    `/threads/${fixture.channel.id}/messages`,
    {
      text: "Captura fictícia da auditoria",
      attachments: [attachment.id],
    },
    automated,
  )
  const rejected = await fixture.call(
    "POST",
    `/threads/${fixture.channel.id}/messages`,
    {
      text: "Anexo inexistente",
      attachmentIds: ["missing"],
    },
    automated,
  )

  expect(response?.status).toBe(201)
  if (!response || !("json" in response)) throw new Error("Missing message response")
  expect((response.json as { message: { parts: unknown[] } }).message.parts).toContainEqual({
    type: "image",
    attachmentId: attachment.id,
    name: "demo-screen.png",
    mime: "image/png",
  })
  const parts = (response.json as { message: { parts: Array<{ type: string }> } }).message.parts
  expect(parts.findIndex((part) => part.type === "text")).toBeLessThan(parts.findIndex((part) => part.type === "image"))
  expect(rejected?.status).toBe(400)
  expect(fixture.database.query("SELECT count(*) AS total FROM runs").get()).toEqual({ total: 0 })
})

test("plain integration notices retain their sender, publish once and never start a run", async () => {
  const fixture = await getFixture()
  const events: string[] = []
  fixture.kernel.subscribe((event) => {
    events.push(event.event.type)
  })
  const path = `/threads/${fixture.channel.id}/notices`
  const body: ApiRoutes["POST /threads/:id/notices"]["req"] = {
    text: "@Bot de teste: aviso fictício",
    sender: { id: "publisher", name: "Publicações QA" },
  }

  const result = await fixture.call("POST", path, body)
  await fixture.kernel.flushEvents?.()
  if (!result || !("json" in result)) throw new Error("Expected notice JSON response")
  const response = result.json as ApiRoutes["POST /threads/:id/notices"]["res"]

  expect(result?.status).toBe(200)
  expect(response.message).toMatchObject({
    role: "assistant",
    kind: "notice",
    runId: null,
    sender: { id: "integration:publisher", name: "Publicações QA", kind: "integration" },
  })
  expect(fixture.store.activePath({ threadId: fixture.channel.id })).toHaveLength(1)
  expect(fixture.database.query("SELECT count(*) AS total FROM runs").get()).toEqual({ total: 0 })
  expect(events.filter((type) => type === "message.created")).toHaveLength(1)
})

test("notice sender validation rejects malformed identities and unauthorized writers", async () => {
  const fixture = await getFixture()
  const path = `/threads/${fixture.channel.id}/notices`
  const anonymous = new AbortController().signal

  expect(await fixture.call("POST", path, { text: "Aviso", sender: { name: "sender" } }, anonymous)).toMatchObject({
    status: 403,
  })
  for (const sender of [null, { name: "" }, { name: "bad\nname" }, { name: "sender", id: "../owner" }]) {
    expect(await fixture.call("POST", path, { text: "Aviso", sender })).toMatchObject({ status: 400 })
  }
  expect(fixture.store.activePath({ threadId: fixture.channel.id })).toHaveLength(0)
})

test("sender-free plain notices create independent messages and named retries publish only once", async () => {
  const fixture = await getFixture()
  const events: string[] = []
  fixture.kernel.subscribe(({ event }) => events.push(event.type))
  const path = `/threads/${fixture.channel.id}/notices`
  const named: ApiRoutes["POST /threads/:id/notices"]["req"] = {
    text: "Aviso",
    kind: "notice",
    eventId: "demo:repeat",
    sender: { name: "Publicações QA" },
  }
  const plain: ApiRoutes["POST /threads/:id/notices"]["req"] = { text: "Aviso" }

  const first = await fixture.call("POST", path, plain)
  await fixture.call("POST", path, plain)
  const namedFirst = await fixture.call("POST", path, named)
  const namedAgain = await fixture.call("POST", path, named)
  await fixture.kernel.flushEvents?.()

  expect(first).toMatchObject({
    status: 200,
    json: {
      message: {
        role: "assistant",
        sender: { id: "automation-notices", name: "touri" },
      },
    },
  })
  expect(namedFirst).toMatchObject({ status: 200, json: { message: { sender: { kind: "integration" } } } })
  expect(namedAgain).toEqual(namedFirst)
  expect(fixture.store.activePath({ threadId: fixture.channel.id })).toHaveLength(3)
  expect(events.filter((type) => type === "message.created")).toHaveLength(3)
  expect(fixture.database.query("SELECT count(*) AS total FROM runs").get()).toEqual({ total: 0 })
})
