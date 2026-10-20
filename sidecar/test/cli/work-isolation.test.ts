import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Attachment, Message, Thread } from "@touri/contracts"
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

test("uploading identical bytes grants each uploader access without exposing another person's filename", async () => {
  const fixture = await getFixture()
  const dataBase64 = Buffer.from("Synthetic shared file").toString("base64")
  const original = await fixture.ownerRequest("/attachments", "POST", { name: "private-admin-name.txt", dataBase64 })
  const originalFile = (await original.json()) as { attachment: Attachment }
  expect((await fixture.request(`/attachments/${originalFile.attachment.id}`)).status).toBe(404)

  const uploaded = await fixture.request("/attachments", "POST", { name: "my-file.txt", dataBase64 })
  const ownFile = (await uploaded.json()) as { attachment: Attachment }
  const downloaded = await fixture.request(`/attachments/${ownFile.attachment.id}`)
  await fixture.request("/threads/member-chat/messages", "POST", {
    text: "Confira meu arquivo",
    parentId: null,
    attachmentIds: [ownFile.attachment.id],
    clientNonce: "same-file",
  })
  const history = (await (await fixture.request("/threads/member-chat/messages")).json()) as { messages: Message[] }

  expect(uploaded.status).toBe(201)
  expect(downloaded.status).toBe(200)
  expect(await downloaded.text()).toBe("Synthetic shared file")
  expect(ownFile.attachment).toMatchObject({ path: "my-file.txt", originPath: "my-file.txt" })
  expect(history.messages[0]?.parts).toContainEqual(expect.objectContaining({ type: "file", name: "my-file.txt" }))
})

test("tool output files follow the visibility of their message", async () => {
  const fixture = await getFixture()
  const uploaded = await fixture.ownerRequest("/attachments", "POST", {
    name: "private-owner-output.txt",
    dataBase64: Buffer.from("Synthetic tool output").toString("base64"),
  })
  const { attachment } = (await uploaded.json()) as { attachment: Attachment }
  const insert =
    fixture.database.query(`INSERT INTO messages(id,thread_id,role,kind,status,text,parts_json,created_at,updated_at)
    VALUES (?,?,'assistant','text','complete','Synthetic output',?,1,1)`)
  const parts = JSON.stringify([{ type: "command", outputAttachmentId: attachment.id }])
  insert.run("private-output", "owner-chat", parts)
  expect((await fixture.request(`/attachments/${attachment.id}`)).status).toBe(404)

  insert.run("visible-output", "member-chat", parts)
  const visible = await fixture.request(`/attachments/${attachment.id}`)

  expect(visible.status).toBe(200)
  expect(await visible.text()).toBe("Synthetic tool output")
  await fixture.request("/threads/member-chat/messages", "POST", {
    text: "Forward this output",
    parentId: null,
    attachmentIds: [attachment.id],
    clientNonce: "forwarded-output",
  })
  const history = (await (await fixture.request("/threads/member-chat/messages")).json()) as { messages: Message[] }
  expect(history.messages[0]?.parts).toContainEqual(
    expect.objectContaining({ type: "file", name: `${attachment.id}.txt` }),
  )
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
  const owner = await authStore.claimPairingCode({
    code: (await authStore.createPairingCode()).code,
    deviceName: "Admin test",
  })
  if (!owner.success) throw new Error("Admin setup failed")
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

  const requestAs = (token: string, path: string, method = "GET", body?: unknown) =>
    fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Touri-Client": "test",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  return {
    database,
    request: (path: string, method = "GET", body?: unknown) => requestAs(claimed.token, path, method, body),
    ownerRequest: (path: string, method = "GET", body?: unknown) => requestAs(owner.token, path, method, body),
    personId: claimed.person.id,
  }
}
