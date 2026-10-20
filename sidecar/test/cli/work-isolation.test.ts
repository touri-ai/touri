import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Message, Thread } from "@touri/contracts"
import { createRateLimiter } from "../../src/cli/auth/rateLimit"
import { openAuthStore } from "../../src/cli/auth/store"
import { createSecretStore } from "../../src/cli/host/secretStore"
import { createWebGate, type MemberAuthorizer } from "../../src/cli/web/gate"
import { noAssets } from "../../src/cli/web/uiAssets"
import { initWorkMode } from "../../src/cli/work"
import { createKernel } from "../../src/kernel"
import { init as initStore } from "../../src/store"

const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  for (const close of cleanups) await close()
  cleanups.clear()
})

test("member HTTP requests cannot cross person or channel boundaries or perform admin writes", async () => {
  const fixture = await getFixture()

  for (const path of ["/people", "/invites", "/email"]) {
    expect((await fixture.request(path)).status).toBe(403)
  }
  for (const path of ["/threads/owner-chat/messages", "/groups/other-channel/threads"]) {
    expect((await fixture.request(path)).status).toBe(404)
  }
  for (const [method, path, body] of [
    ["POST", "/invites", { role: "admin", email: "new@example.test" }],
    ["DELETE", "/people/owner", {}],
    ["PUT", "/email", {}],
    ["POST", "/approvals/other-approval", { decision: "approved" }],
    ["PATCH", "/bots/shared-bot", { responsiblePersonId: fixture.personId }],
  ] as const) {
    expect((await fixture.request(path, method, body)).status).toBe(403)
  }

  expect((await fixture.request("/groups/member-channel/threads")).status).toBe(200)
  const sent = await fixture.request("/threads/member-chat/messages", "POST", {
    text: "Mensagem sintética",
    parentId: null,
    attachmentIds: [],
    clientNonce: "member-message",
    sender: { id: "owner", name: "Admin" },
  })
  expect(sent.status).toBe(503)
  const history = await fixture.request("/threads/member-chat/messages")
  const payload = (await history.json()) as { messages: Message[] }
  expect(payload.messages[0]?.sender).toMatchObject({ id: fixture.personId, name: "Pessoa de teste" })
})

test("private session creation checks the requested bot even when the member owns another bot", async () => {
  const fixture = await getFixture()
  const allowed = await fixture.request("/threads", "POST", { botId: "member-bot" })
  const denied = await fixture.request("/threads", "POST", { botId: "shared-bot" })

  expect(allowed.status).toBe(201)
  expect(((await allowed.json()) as { thread: Thread }).thread.ownerPersonId).toBe(fixture.personId)
  expect(denied.status).toBe(404)
})

const getFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-work-isolation-"))
  const authStore = await openAuthStore({ filename: join(root, "auth.db") })
  const secrets = createSecretStore({ dir: root, env: { TOURI_SECRETS_KEY: "synthetic-test-key" } })
  const authorization: { authorize: MemberAuthorizer | null } = { authorize: null }
  const intercept = createWebGate({
    store: authStore,
    secrets,
    ui: noAssets,
    limiter: createRateLimiter({ maxFailures: 8, windowMs: 60_000 }),
    authorizeMember: (input) => authorization.authorize?.(input) ?? null,
  })
  const runtime = createKernel({
    appData: root,
    web: {
      hostname: "127.0.0.1",
      port: 0,
      intercept,
      host: () => async () => ({ success: false, errorCode: "HOST_UNAVAILABLE", error: "Test host" }),
    },
  })
  cleanups.add(async () => {
    runtime.stop()
    await authStore.close()
    await rm(root, { recursive: true, force: true })
  })
  initWorkMode({ kernel: runtime.kernel, authStore, secrets, authorization })
  await initStore(runtime.kernel)
  const invite = await authStore.createInvite({
    actorPersonId: "owner",
    name: "Pessoa de teste",
    email: "member@example.test",
    role: "member",
    channelIds: ["member-channel"],
  })
  if (!invite.success) throw new Error("Invite setup failed")
  const claimed = await authStore.claimInvite({ token: invite.token, email: "member@example.test", deviceName: "Test" })
  if (!claimed.success) throw new Error("Member setup failed")
  const database = runtime.kernel.db as Database
  database.exec(`
    INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at,responsible_person_id)
      VALUES ('shared-bot','Shared','codex','/tmp/shared-bot',1,1,'owner');
    INSERT INTO bot_groups(id,name,color,avatar_shape,avatar_seed,created_at,updated_at)
      VALUES ('member-channel','Team A','#888888','circle','a',1,1), ('other-channel','Team B','#888888','circle','b',1,1);
    INSERT INTO group_members(group_id,bot_id,position) VALUES ('member-channel','shared-bot',0);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at,owner_person_id)
      VALUES ('owner-chat','shared-bot','Private',1,1,'owner');
  `)
  database
    .query(`INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at,responsible_person_id)
    VALUES ('member-bot','Own bot','codex','/tmp/member-bot',1,1,?)`)
    .run(claimed.person.id)
  database
    .query(`INSERT INTO threads(id,bot_id,title,created_at,updated_at,owner_person_id)
    VALUES ('member-chat','member-bot','Own chat',1,1,?)`)
    .run(claimed.person.id)
  runtime.kernel.registerRoutes({
    name: "channel-fixture",
    routes: [
      { method: "GET", path: "/groups/:id/threads", handler: async () => ({ status: 200, json: { threads: [] } }) },
    ],
  })

  const request = (path: string, method = "GET", body?: unknown) =>
    fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${claimed.token}`,
        "X-Touri-Client": "test",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  return { request, personId: claimed.person.id }
}
