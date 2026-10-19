import type { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, Message, Run, StoreApi } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { openDatabase } from "../../src/kernel/db"
import { createNotificationStore } from "../../src/notify/store"
import { getHost } from "../../src/platform/host"
import { createRuntimePersistence } from "../../src/runtime/persistence"
import { init } from "../../src/store"

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "touri-wp2-"))

const startStore = async (): Promise<{
  root: string
  runtime: ReturnType<typeof createKernel>
  bot: Bot
  threadId: string
  close: () => void
}> => {
  const root = tempRoot()
  const runtime = createKernel({ appData: root })
  await init(runtime.kernel)
  const response = await fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1/bots`, {
    method: "POST",
    headers: { Authorization: "Bearer dev-ui-token", Origin: "tauri://localhost", "Content-Type": "application/json" },
    body: JSON.stringify({ name: "mark", provider: "codex", instructions: "You are helpful." }),
  })
  const created = (await response.json()) as { bot: Bot }
  const botThreads = await fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1/bots/${created.bot.id}/threads`, {
    headers: { Authorization: "Bearer dev-ui-token", Origin: "tauri://localhost" },
  })
  const threadPayload = (await botThreads.json()) as { threads: Array<{ id: string }> }
  return {
    root,
    runtime,
    bot: created.bot,
    threadId: threadPayload.threads[0]?.id ?? "",
    close: () => {
      runtime.stop()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

const headers = {
  Authorization: "Bearer dev-ui-token",
  Origin: "tauri://localhost",
  "Content-Type": "application/json",
}

test("VM memory preference survives database reopen while absent or invalid values use 1536 MiB", async () => {
  const f = await startStore()
  let reopened: ReturnType<typeof createKernel> | null = null
  try {
    const response = await fetch(`http://127.0.0.1:${f.runtime.handshake.port}/api/v1/settings`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ botVmMemoryMb: 1024 }),
    })
    expect(response.status).toBe(200)
    f.runtime.stop()
    reopened = createKernel({ appData: f.root })
    await init(reopened.kernel)
    const settings = reopened.kernel.services.use("store.settings")
    expect(settings?.().botVmMemoryMb).toBe(1024)
    const db = reopened.kernel.db as Database
    db.query("UPDATE settings SET value_json = '0' WHERE key = 'botVmMemoryMb'").run()
    expect(settings?.().botVmMemoryMb).toBe(1536)
    db.query("DELETE FROM settings WHERE key = 'botVmMemoryMb'").run()
    expect(settings?.().botVmMemoryMb).toBe(1536)
  } finally {
    reopened?.stop()
    f.close()
  }
})

test("sidebar float preference defaults on, persists off across reopen and rejects non-booleans", async () => {
  const f = await startStore()
  let reopened: ReturnType<typeof createKernel> | null = null
  try {
    const url = `http://127.0.0.1:${f.runtime.handshake.port}/api/v1/settings`
    const initial = (await (await fetch(url, { headers })).json()) as { settings: { sidebarFloatUpdates?: boolean } }
    expect(initial.settings.sidebarFloatUpdates).toBe(true)
    const invalid = await fetch(url, { method: "PATCH", headers, body: JSON.stringify({ sidebarFloatUpdates: "no" }) })
    expect(invalid.status).toBe(400)
    const unauthorized = await fetch(url, {
      method: "PATCH",
      headers: { ...headers, Authorization: "Bearer wrong" },
      body: JSON.stringify({ sidebarFloatUpdates: false }),
    })
    expect(unauthorized.status).toBe(401)
    const response = await fetch(url, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ sidebarFloatUpdates: false }),
    })
    expect(response.status).toBe(200)
    f.runtime.stop()
    reopened = createKernel({ appData: f.root })
    await init(reopened.kernel)
    const settings = reopened.kernel.services.use("store.settings")
    expect(settings?.().sidebarFloatUpdates).toBe(false)
    const db = reopened.kernel.db as Database
    db.query("UPDATE settings SET value_json = '\"x\"' WHERE key = 'sidebarFloatUpdates'").run()
    expect(settings?.().sidebarFloatUpdates).toBe(true)
  } finally {
    reopened?.stop()
    f.close()
  }
})

test("branch 2/2 → 1/2 → 2/2 restores descendants through the HTTP pointer and message query", async () => {
  const f = await startStore()
  try {
    const api = f.runtime.kernel.services.use("store.api")
    if (!api) throw new Error("missing store")
    for (const [id, parentId] of [
      ["root", null],
      ["v1", "root"],
      ["v2", "root"],
      ["later-user", "v2"],
      ["later-reply", "later-user"],
    ] as const)
      insertTextMessage({ api, threadId: f.threadId, id, parentId, text: id })
    const url = `http://127.0.0.1:${f.runtime.handshake.port}/api/v1/threads/${f.threadId}`
    const select = (activeLeafId: string) =>
      fetch(url, { method: "PATCH", headers, body: JSON.stringify({ activeLeafId }) })
    await select("v1")
    expect(api.activePath({ threadId: f.threadId }).map((message) => message.id)).toEqual(["root", "v1"])
    await select("v2")
    const response = await fetch(`${url}/messages`, { headers })
    const data = (await response.json()) as { messages: Message[]; activeLeafId: string }
    expect(data.activeLeafId).toBe("later-reply")
    expect(data.messages.map((message) => message.id)).toEqual(["root", "v2", "later-user", "later-reply"])
    const all = (await (await fetch(`${url}/messages?all=true`, { headers })).json()) as { messages: Message[] }
    expect(all.messages).toHaveLength(5)
  } finally {
    f.close()
  }
})

const insertTextMessage = ({
  api,
  threadId,
  id,
  parentId,
  text,
  status = "complete",
}: {
  api: StoreApi
  threadId: string
  id: string
  parentId: string | null
  text: string
  status?: Message["status"]
}): Message => {
  if (!api || !("insertMessage" in api)) throw new Error("store service is unavailable")
  const result = api.insertMessage({
    message: {
      id,
      threadId,
      parentId,
      role: "assistant",
      kind: "text",
      status,
      runId: null,
      text,
      parts: [{ type: "text", text }],
      sender: null,
      source: "local",
    },
  })
  if (!result.success) throw new Error(result.error)
  return result.message
}

const makeRun = ({ botId, threadId }: { botId: string; threadId: string }): Run => ({
  id: "run-test",
  threadId,
  botId,
  provider: "codex",
  trigger: "user",
  requestMessageId: null,
  replyMessageId: null,
  externalTurnId: null,
  status: "queued",
  errorClass: null,
  errorMessage: null,
  usage: null,
  routineRunId: null,
  queuedAt: Date.now(),
  startedAt: null,
  finishedAt: null,
})

test("message tree supports branches and active paths", async () => {
  const context = await startStore()
  try {
    const api = context.runtime.kernel.services.use("store.api")
    expect(api).not.toBeNull()
    if (!api) return
    const root = insertTextMessage({ api, threadId: context.threadId, id: "root", parentId: null, text: "root" })
    const a = insertTextMessage({ api, threadId: context.threadId, id: "a", parentId: root.id, text: "A" })
    const b = insertTextMessage({ api, threadId: context.threadId, id: "b", parentId: a.id, text: "B" })
    const aPrime = insertTextMessage({ api, threadId: context.threadId, id: "a-prime", parentId: root.id, text: "A'" })
    expect(api.activePath({ threadId: context.threadId, leafId: b.id }).map((message) => message.id)).toEqual([
      "root",
      "a",
      "b",
    ])
    const switched = api.setActiveLeaf({ threadId: context.threadId, leafId: aPrime.id })
    expect(switched.success).toBe(true)
    expect(api.activePath({ threadId: context.threadId }).map((message) => message.id)).toEqual(["root", "a-prime"])
  } finally {
    context.close()
  }
})

test("FTS searches accented text without diacritics", async () => {
  const context = await startStore()
  try {
    const api = context.runtime.kernel.services.use("store.api")
    if (!api) throw new Error("store service is unavailable")
    insertTextMessage({
      api,
      threadId: context.threadId,
      id: "accented",
      parentId: null,
      text: "Configuração de autenticação",
    })
    const hits = api.search({ q: "configuracao", threadId: context.threadId, limit: 10 })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.messageId).toBe("accented")
  } finally {
    context.close()
  }
})

test("delta buffering keeps the complete text after a large stream", async () => {
  const context = await startStore()
  try {
    const api = context.runtime.kernel.services.use("store.api")
    if (!api) throw new Error("store service is unavailable")
    insertTextMessage({ api, threadId: context.threadId, id: "stream", parentId: null, text: "", status: "streaming" })
    for (let index = 0; index < 1000; index += 1)
      api.appendDelta({ threadId: context.threadId, messageId: "stream", partIndex: 0, delta: "x" })
    await Bun.sleep(250)
    const message = api.activePath({ threadId: context.threadId, leafId: "stream" }).at(-1)
    expect(message?.text).toBe("x".repeat(1000))
    expect(message?.parts).toEqual([{ type: "text", text: "x".repeat(1000) }])
  } finally {
    context.close()
  }
})

test("POST message persists before returning runtime unavailable", async () => {
  const context = await startStore()
  try {
    const response = await fetch(
      `http://127.0.0.1:${context.runtime.handshake.port}/api/v1/threads/${context.threadId}/messages`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ threadId: context.threadId, parentId: null, text: "queued locally", attachmentIds: [] }),
      },
    )
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ errorCode: "RUNTIME_UNAVAILABLE" })
    const database = context.runtime.kernel.db as Database
    expect(database.query("SELECT text FROM messages WHERE thread_id = ?").all(context.threadId)).toEqual([
      { text: "queued locally" },
    ])
  } finally {
    context.close()
  }
})

test("POST message enqueues through the runtime service after persistence", async () => {
  const context = await startStore()
  try {
    const persistence = createRuntimePersistence({ database: context.runtime.kernel.db })
    context.runtime.kernel.services.provide("runtime.enqueue", ({ threadId, requestMessageId, trigger }) => {
      const run = { ...makeRun({ botId: context.bot.id, threadId }), requestMessageId, trigger }
      persistence.saveRun(run)
      return { success: true, run }
    })
    const response = await fetch(
      `http://127.0.0.1:${context.runtime.handshake.port}/api/v1/threads/${context.threadId}/messages`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ threadId: context.threadId, parentId: null, text: "run this", attachmentIds: [] }),
      },
    )
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      run: { trigger: "user", status: "queued" },
      message: { text: "run this" },
    })
  } finally {
    context.close()
  }
})

test("attachments are content-addressed and deduplicated", async () => {
  const context = await startStore()
  const source = join(context.root, "upload.txt")
  writeFileSync(source, "same bytes", { mode: 0o600 })
  try {
    const first = await fetch(`http://127.0.0.1:${context.runtime.handshake.port}/api/v1/attachments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "upload.txt", dataBase64: Buffer.from("same bytes").toString("base64") }),
    })
    const second = await fetch(`http://127.0.0.1:${context.runtime.handshake.port}/api/v1/attachments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "upload.txt", dataBase64: Buffer.from("same bytes").toString("base64") }),
    })
    const firstPayload = (await first.json()) as { attachment: { id: string; path: string } }
    const secondPayload = (await second.json()) as { attachment: { id: string; path: string } }
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(secondPayload.attachment).toEqual(firstPayload.attachment)
    expect(readFileSync(firstPayload.attachment.path, "utf8")).toBe("same bytes")
    const downloaded = await fetch(
      `http://127.0.0.1:${context.runtime.handshake.port}/api/v1/attachments/${firstPayload.attachment.id}`,
      {
        headers: { Authorization: "Bearer dev-ui-token", Origin: "tauri://localhost" },
      },
    )
    expect(downloaded.status).toBe(200)
    expect(await downloaded.text()).toBe("same bytes")
    const database = context.runtime.kernel.db as Database
    expect(database.query("SELECT count(*) AS count FROM attachments").get()).toEqual({ count: 1 })
  } finally {
    context.close()
  }
})

test("bot homes mirror SOUL instructions and keep the instruction hash current", async () => {
  const context = await startStore()
  try {
    const soulPath = join(context.bot.homeDir, "SOUL.md")
    expect(readFileSync(soulPath, "utf8")).toBe("You are helpful.")
    const response = await fetch(`http://127.0.0.1:${context.runtime.handshake.port}/api/v1/bots/${context.bot.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ instructions: "Be concise." }),
    })
    const payload = (await response.json()) as { bot: Bot }
    expect(response.status).toBe(200)
    expect(payload.bot.instructions).toBe("Be concise.")
    expect(readFileSync(soulPath, "utf8")).toBe("Be concise.")
    expect(payload.bot.instructionsHash).not.toBe(context.bot.instructionsHash)
  } finally {
    context.close()
  }
})

test("all WP2 HTTP routes respond with contract-shaped payloads", async () => {
  const context = await startStore()
  try {
    const base = `http://127.0.0.1:${context.runtime.handshake.port}/api/v1`
    const get = (path: string): Promise<Response> => fetch(`${base}${path}`, { headers })
    const health = await get("/health")

    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ hostKind: getHost() })
    expect((await get("/doctor")).status).toBe(200)
    expect((await get("/bots")).status).toBe(200)
    expect((await get(`/bots/${context.bot.id}/threads`)).status).toBe(200)
    expect((await get(`/threads/${context.threadId}/messages`)).status).toBe(200)
    expect((await get("/search?q=missing")).status).toBe(200)
    expect((await get("/settings")).status).toBe(200)
    const createdThread = await fetch(`${base}/threads`, {
      method: "POST",
      headers,
      body: JSON.stringify({ botId: context.bot.id, title: "Chat" }),
    })
    expect(createdThread.status).toBe(201)
    const createdThreadPayload = (await createdThread.json()) as { thread: { id: string } }
    expect(
      (
        await fetch(`${base}/threads/${createdThreadPayload.thread.id}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ title: "Renamed" }),
        })
      ).status,
    ).toBe(200)
    expect(
      (await fetch(`${base}/settings`, { method: "PATCH", headers, body: JSON.stringify({ maxConcurrentRuns: 4 }) }))
        .status,
    ).toBe(200)
  } finally {
    context.close()
  }
}, 30_000)

test("avatar identity survives create, patch, database reopen and notification serialization", async () => {
  const fixture = await startStore()
  try {
    const endpoint = `http://127.0.0.1:${fixture.runtime.handshake.port}/api/v1`
    const response = await fetch(`${endpoint}/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Morpheus",
        provider: "codex",
        avatarShape: "short-flower",
        avatarSeed: "stable-seed",
        color: "#2468ac",
      }),
    })
    expect(response.status).toBe(201)
    const { bot } = (await response.json()) as { bot: Bot }
    expect(bot).toMatchObject({ avatarShape: "short-flower", avatarSeed: "stable-seed", color: "#2468ac" })
    const patch = await fetch(`${endpoint}/bots/${bot.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ avatarShape: "long-crown", name: "Renamed" }),
    })
    expect(patch.status).toBe(200)
    expect(((await patch.json()) as { bot: Bot }).bot).toMatchObject({
      avatarShape: "long-crown",
      avatarSeed: "stable-seed",
      color: "#2468ac",
    })
    const reopened = openDatabase({ filename: fixture.runtime.kernel.paths.db })
    try {
      expect(reopened.query("SELECT avatar_shape, avatar_seed, color FROM bots WHERE id = ?").get(bot.id)).toEqual({
        avatar_shape: "long-crown",
        avatar_seed: "stable-seed",
        color: "#2468ac",
      })
      const record = createNotificationStore({ db: reopened }).insert({
        kind: "done",
        botId: bot.id,
        threadId: bot.mainThreadId,
        title: "Done",
        body: "Reply",
      }).notification
      expect(record).toMatchObject({ avatarShape: "long-crown", avatarSeed: "stable-seed", botColor: "#2468ac" })
    } finally {
      reopened.close()
    }
    const legacy = await fetch(`${endpoint}/bots/${bot.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ avatarShape: "cercle", name: "Renamed again" }),
    })
    expect(legacy.status).toBe(200)
    expect(((await legacy.json()) as { bot: Bot }).bot.avatarShape).toBe("cercle")
    for (const input of [
      { avatarShape: "bull" },
      { avatarShape: "goutte" },
      { avatarSeed: "" },
      { color: '<svg onload="bad()">' },
    ]) {
      const invalid = await fetch(`${endpoint}/bots/${bot.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(input),
      })
      expect(invalid.status).toBe(400)
    }
  } finally {
    fixture.close()
  }
})

test("r2: role line and optional title persist through create, settings, unrelated patches and database reopen", async () => {
  const fixture = await startStore()
  try {
    const base = `http://127.0.0.1:${fixture.runtime.handshake.port}/api/v1`
    const created = await fetch(`${base}/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "SEO",
        provider: "claude",
        roleLine: "SEO do site",
        title: "Analista",
        instructions: "SOUL original",
      }),
    })
    expect(created.status).toBe(201)
    const { bot } = (await created.json()) as { bot: Bot }
    expect(bot).toMatchObject({ roleLine: "SEO do site", title: "Analista", instructions: "SOUL original" })
    const patched = await fetch(`${base}/bots/${bot.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ roleLine: "Touri · Coder", title: null }),
    })
    expect(patched.status).toBe(200)
    await fetch(`${base}/bots/${bot.id}`, { method: "PATCH", headers, body: JSON.stringify({ browserEnabled: false }) })
    const reopened = openDatabase({ filename: fixture.runtime.kernel.paths.db })
    try {
      expect(reopened.query("SELECT role_line, title, instructions FROM bots WHERE id = ?").get(bot.id)).toEqual({
        role_line: "Touri · Coder",
        title: null,
        instructions: "SOUL original",
      })
    } finally {
      reopened.close()
    }
  } finally {
    fixture.close()
  }
})
