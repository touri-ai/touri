import type { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { NotificationRecord, Run } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { init as initNotify } from "../../src/notify"
import { createSseHub, parseSince } from "../../src/notify/sse"
import { createNotificationStore } from "../../src/notify/store"
import { createRuntimePersistence } from "../../src/runtime/persistence"
import { init as initStore } from "../../src/store"

const TOKEN = "notify-test-token"

type Harness = {
  root: string
  runtime: ReturnType<typeof createKernel>
  base: string
  call: (method: string, path: string, body?: unknown, auth?: boolean) => Promise<Response>
  close: () => void
}

const harness = async ({ withStore = false } = {}): Promise<Harness> => {
  const root = mkdtempSync(join(tmpdir(), "touri-notify-"))
  const previous = process.env.TOURI_UI_TOKEN
  process.env.TOURI_UI_TOKEN = TOKEN
  const runtime = createKernel({ appData: root })
  if (previous === undefined) delete process.env.TOURI_UI_TOKEN
  else process.env.TOURI_UI_TOKEN = previous
  if (withStore) await initStore(runtime.kernel)
  await initNotify(runtime.kernel)
  const base = `http://127.0.0.1:${runtime.handshake.port}`
  const call: Harness["call"] = (method, path, body, auth = true) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}),
        "X-Touri-Client": "test",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  return {
    root,
    runtime,
    base,
    call,
    close: () => {
      runtime.stop()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

const emitter = (value: Harness) => {
  const fn = value.runtime.kernel.services.use("notify.emit")
  if (!fn) throw new Error("notify.emit missing")
  return fn
}

const readFrames = async ({
  response,
  until,
  timeoutMs = 2000,
}: {
  response: Response
  until: (text: string) => boolean
  timeoutMs?: number
}): Promise<string> => {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  const state = { text: "" }
  const deadline = Date.now() + timeoutMs
  while (!until(state.text) && Date.now() < deadline) {
    const chunk = await Promise.race([reader.read(), Bun.sleep(timeoutMs).then(() => null)])
    if (chunk === null || chunk.done) break
    state.text += decoder.decode(chunk.value)
  }
  await reader.cancel()
  return state.text
}

test("events stream resumes after the last seen id and ends the backlog with ready", async () => {
  const h = await harness()
  try {
    const send = emitter(h)
    send({ kind: "turn-failed", botId: null, threadId: "t1", title: "one", body: "first" })
    send({ kind: "incident", botId: null, threadId: null, title: "two", body: "second" })
    send({ kind: "question", botId: null, threadId: "t1", title: "three", body: "third?", requestId: "req-3" })
    const response = await h.call("GET", "/api/events?since=1")
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const text = await readFrames({ response, until: (value) => value.includes("event: ready") })
    expect(text).not.toContain('"title":"one"')
    expect(text).toContain("id: 2\nevent: notify")
    expect(text).toContain("id: 3\nevent: notify")
    expect(text).toContain('"requestId":"req-3"')
    expect(text).toContain("id: 3\nevent: ready")
  } finally {
    h.close()
  }
})

test("a fresh stream hydrates unresolved attention items from the last 48 hours and skips old, resolved and done ones", async () => {
  const h = await harness()
  try {
    const send = emitter(h)
    const db = h.runtime.kernel.db as Database
    send({ kind: "turn-failed", botId: null, threadId: "t1", title: "recent", body: "x" })
    send({ kind: "turn-failed", botId: null, threadId: "t1", title: "ancient", body: "x" })
    send({ kind: "incident", botId: null, threadId: null, title: "resolved", body: "x" })
    send({ kind: "done", botId: null, threadId: "t1", title: "finished", body: "x" })
    db.query("UPDATE notifications SET created_at = ? WHERE title = 'ancient'").run(Date.now() - 49 * 3600_000)
    const resolvedId = (db.query("SELECT id FROM notifications WHERE title = 'resolved'").get() as { id: number }).id
    expect((await h.call("POST", `/api/notifications/${resolvedId}/dismiss`)).status).toBe(200)
    const text = await readFrames({
      response: await h.call("GET", "/api/events"),
      until: (value) => value.includes("event: ready"),
    })
    expect(text).toContain('"title":"recent"')
    expect(text).not.toContain('"title":"ancient"')
    expect(text).not.toContain('"title":"resolved"')
    expect(text).not.toContain('"title":"finished"')
    const pending = (await (await h.call("GET", "/api/notifications/pending")).json()) as {
      notifications: Array<NotificationRecord>
    }
    expect(pending.notifications.map((item) => item.title)).toEqual(["recent"])
  } finally {
    h.close()
  }
})

test("live notifications and resolutions are pushed on an open stream and heartbeats keep it alive", async () => {
  const h = await harness()
  try {
    const db = h.runtime.kernel.db as Database
    const hub = createSseHub({ store: createNotificationStore({ db }), heartbeatMs: 15 })
    const stream = hub.open({ since: null, signal: new AbortController().signal })
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    const seen = { text: "" }
    const pump = (async () => {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) return
        seen.text += decoder.decode(chunk.value)
      }
    })()
    await Bun.sleep(60)
    expect(seen.text).toContain(": ping")
    expect(hub.size()).toBe(1)
    await reader.cancel()
    await pump
    expect(hub.size()).toBe(0)
  } finally {
    h.close()
  }
})

test("a live subscriber over HTTP receives notify then resolved frames", async () => {
  const h = await harness()
  try {
    const response = await h.call("GET", "/api/events")
    const collected = readFrames({ response, until: (value) => value.includes("event: resolved") })
    await Bun.sleep(50)
    const record = emitter(h)({ kind: "takeover", botId: null, threadId: "t9", title: "help", body: "need you" })
    expect((await h.call("POST", `/api/notifications/${record.id}/dismiss`)).status).toBe(200)
    const text = await collected
    expect(text).toContain("event: notify")
    expect(text).toContain('"kind":"takeover"')
    expect(text).toContain('event: resolved\ndata: {"type":"resolved"')
    expect(text).toContain('"resolution":"dismissed"')
  } finally {
    h.close()
  }
})

test("aborting an SSE connection closes the reader and removes its heartbeat and subscription", async () => {
  const h = await harness()
  try {
    const hub = createSseHub({
      store: createNotificationStore({ db: h.runtime.kernel.db as Database }),
      heartbeatMs: 15,
    })
    const abort = new AbortController()
    const reader = hub.open({ since: null, signal: abort.signal }).getReader()
    try {
      // Drain retry and ready frames before testing the end of the stream.
      await reader.read()
      await reader.read()
      expect(hub.size()).toBe(1)
      abort.abort()
      expect(hub.size()).toBe(0)
      expect(await Promise.race([reader.read(), Bun.sleep(100).then(() => null)])).toEqual({
        done: true,
        value: undefined,
      })
    } finally {
      await reader.cancel()
    }
    const alreadyAborted = hub.open({ since: null, signal: abort.signal }).getReader()
    expect(await alreadyAborted.read()).toEqual({ done: true, value: undefined })
    expect(hub.size()).toBe(0)
  } finally {
    h.close()
  }
})

test("parseSince accepts the query value, falls back to Last-Event-ID, and rejects junk", () => {
  expect(parseSince({ query: "12", header: null })).toBe(12)
  expect(parseSince({ query: undefined, header: "7" })).toBe(7)
  expect(parseSince({ query: "abc", header: null })).toBeNull()
  expect(parseSince({ query: "-1", header: null })).toBeNull()
  expect(parseSince({ query: undefined, header: null })).toBeNull()
})

test("respond requires the bearer token, the owning thread, a valid behavior and an unresolved request", async () => {
  const h = await harness()
  try {
    const calls: Array<Record<string, unknown>> = []
    h.runtime.kernel.services.provide("runtime.answerApproval", async (args) => {
      calls.push(args)
      if (args.approvalId === "req-team" && args.source !== "card")
        return { success: false, errorCode: "DENIED", error: "Open the full card." }
      return { success: true }
    })
    emitter(h)({
      kind: "approval",
      botId: null,
      threadId: "thread-a",
      title: "Approve command",
      body: "rm -rf x",
      requestId: "req-a",
    })
    emitter(h)({
      kind: "question",
      botId: null,
      threadId: "thread-a",
      title: "Question",
      body: "Ship it?",
      requestId: "req-q",
    })
    const teamRequest = emitter(h)({
      kind: "approval",
      botId: null,
      threadId: "thread-a",
      title: "Create team",
      body: "Review each proposed bot before creating the team.",
      requestId: "req-team",
    })
    const url = "/api/threads/thread-a/respond"
    expect((await h.call("POST", url, { requestId: "req-a", behavior: "allow" }, false)).status).toBe(401)
    expect((await h.call("POST", "/api/threads/other/respond", { requestId: "req-a", behavior: "allow" })).status).toBe(
      404,
    )
    expect((await h.call("POST", url, { requestId: "req-a", behavior: "maybe" })).status).toBe(400)
    expect((await h.call("POST", url, { requestId: "req-a", behavior: "answer" })).status).toBe(400)
    expect((await h.call("POST", url, { requestId: "req-a", behavior: "allow" })).status).toBe(200)
    expect(calls[0]).toEqual({ approvalId: "req-a", decision: "approved", source: "notification" })
    expect((await h.call("POST", url, { requestId: "req-a", behavior: "allow" })).status).toBe(409)
    expect((await h.call("POST", url, { requestId: "req-q", behavior: "answer", message: "yes, ship" })).status).toBe(
      200,
    )
    expect(calls[1]).toEqual({
      approvalId: "req-q",
      decision: "denied",
      message: "User answered: yes, ship",
      source: "notification",
    })
    const deniedTeam = await h.call("POST", url, { requestId: "req-team", behavior: "allow" })
    expect(deniedTeam.status).toBe(403)
    expect(calls[2]).toEqual({ approvalId: "req-team", decision: "approved", source: "notification" })
    expect(
      (h.runtime.kernel.db as Database).query("SELECT resolved_at FROM notifications WHERE id = ?").get(teamRequest.id),
    ).toEqual({ resolved_at: null })
    const pending = (await (await h.call("GET", "/api/notifications/pending")).json()) as {
      notifications: Array<unknown>
    }
    expect(pending.notifications).toEqual([expect.objectContaining({ requestId: "req-team" })])
  } finally {
    h.close()
  }
})

test("respond marks the request expired when the runtime no longer holds it", async () => {
  const h = await harness()
  try {
    h.runtime.kernel.services.provide("runtime.answerApproval", async () => ({
      success: false,
      errorCode: "NOT_FOUND",
      error: "gone",
    }))
    const record = emitter(h)({
      kind: "approval",
      botId: null,
      threadId: "thread-b",
      title: "x",
      body: "y",
      requestId: "req-b",
    })
    const response = await h.call("POST", "/api/threads/thread-b/respond", { requestId: "req-b", behavior: "deny" })
    expect(response.status).toBe(410)
    const row = (h.runtime.kernel.db as Database)
      .query("SELECT resolution FROM notifications WHERE id = ?")
      .get(record.id)
    expect(row).toEqual({ resolution: "expired" })
  } finally {
    h.close()
  }
})

test("a user reply resolves questions but preserves interrupted failures", async () => {
  const h = await harness()
  try {
    const send = emitter(h)
    send({ kind: "question", botId: null, threadId: "thread-c", title: "q", body: "ok?" })
    send({ kind: "turn-failed", botId: null, threadId: "thread-c", title: "f", body: "boom" })
    send({ kind: "incident", botId: null, threadId: "thread-c", title: "i", body: "keep" })
    h.runtime.kernel.publish({
      type: "message.created",
      message: {
        id: "m1",
        threadId: "thread-c",
        parentId: null,
        role: "user",
        kind: "text",
        status: "complete",
        runId: null,
        text: "answer",
        parts: [],
        sender: null,
        source: "local",
        createdAt: 1,
        updatedAt: 1,
      },
    })
    const pending = (await (await h.call("GET", "/api/notifications/pending")).json()) as {
      notifications: Array<NotificationRecord>
    }
    expect(pending.notifications.map((item) => item.kind)).toEqual(["turn-failed", "incident"])
  } finally {
    h.close()
  }
})

test("bot messages enqueue a run on the main thread and replay the same result for a repeated sendId", async () => {
  const h = await harness({ withStore: true })
  try {
    const queued: Array<string> = []
    h.runtime.kernel.services.provide("runtime.enqueue", ({ threadId }) => {
      queued.push(threadId)
      const botId = (
        (h.runtime.kernel.db as Database).query("SELECT bot_id FROM threads WHERE id = ?").get(threadId) as {
          bot_id: string
        }
      ).bot_id
      const run: Run = {
        id: `run-${queued.length}`,
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
      }
      createRuntimePersistence({ database: h.runtime.kernel.db }).saveRun(run)
      return { success: true, run }
    })
    const created = (await (await h.call("POST", "/api/v1/bots", { name: "Reply", provider: "codex" })).json()) as {
      bot: { id: string; mainThreadId: string }
    }
    const url = `/api/bots/${created.bot.id}/messages`
    expect((await h.call("POST", url, { text: "hello" }, false)).status).toBe(401)
    expect((await h.call("POST", url, { text: "  " })).status).toBe(400)
    const first = (await (await h.call("POST", url, { text: "hello", sendId: "s1" })).json()) as {
      message: { id: string }
    }
    const again = (await (await h.call("POST", url, { text: "hello", sendId: "s1" })).json()) as {
      message: { id: string }
    }
    expect(again.message.id).toBe(first.message.id)
    expect(queued).toEqual([created.bot.mainThreadId])
    expect((await h.call("POST", url, { text: "x", threadId: "nope" })).status).toBe(404)
    expect((await h.call("POST", "/api/bots/missing/messages", { text: "x" })).status).toBe(404)
  } finally {
    h.close()
  }
})

test("the handshake file is private and removed on stop", async () => {
  const h = await harness()
  const file = join(h.runtime.kernel.paths.runDir, "handshake.json")
  const parsed = JSON.parse(await Bun.file(file).text()) as { port: number; token: string }
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(parsed).toMatchObject({ port: h.runtime.handshake.port, token: TOKEN })
  h.close()
  expect(await Bun.file(file).exists()).toBe(false)
})

test("an AskUserQuestion prompt becomes a question notification and other tools become approvals", async () => {
  const { createRuntimeNotices } = await import("../../src/runtime/notices")
  const h = await harness()
  try {
    const notices = createRuntimeNotices({ kernel: h.runtime.kernel })
    notices.prompt({
      botId: "b",
      threadId: "t",
      requestId: "r1",
      toolName: "AskUserQuestion",
      input: { questions: [{ question: "Which env?" }] },
      detail: "ignored",
    })
    notices.prompt({ botId: "b", threadId: "t", requestId: "r2", toolName: "Bash", input: {}, detail: "Bash: ls" })
    const rows = (h.runtime.kernel.db as Database)
      .query("SELECT kind, body, request_id FROM notifications ORDER BY id")
      .all()
    expect(rows).toEqual([
      { kind: "question", body: "Which env?", request_id: "r1" },
      { kind: "approval", body: "Executar comando no terminal", request_id: "r2" },
    ])
  } finally {
    h.close()
  }
})

test("a repeated request emits once and resolution clears older duplicate records", async () => {
  const h = await harness()
  try {
    const input = {
      kind: "approval" as const,
      botId: null,
      threadId: "thread-repeat",
      title: "Approve command",
      body: "pwd",
      requestId: "same-request",
    }
    const first = emitter(h)(input)
    expect(emitter(h)(input).id).toBe(first.id)
    const db = h.runtime.kernel.db as Database
    expect(db.query("SELECT COUNT(*) AS count FROM notifications WHERE request_id = ?").get(input.requestId)).toEqual({
      count: 1,
    })
    const legacy = createNotificationStore({ db }).insert(input).notification
    h.runtime.kernel.services.use("notify.resolve")?.({ requestId: input.requestId, resolution: "allow" })
    const rows = db.query("SELECT resolution FROM notifications WHERE id IN (?, ?)").all(first.id, legacy.id)
    expect(rows).toEqual([{ resolution: "allow" }, { resolution: "allow" }])
    expect((await (await h.call("GET", "/api/notifications/pending")).json()).notifications).toEqual([])
  } finally {
    h.close()
  }
})

test("dismissing an approval reminder never answers the runtime request", async () => {
  const h = await harness()
  try {
    const decisions: unknown[] = []
    h.runtime.kernel.services.provide("runtime.answerApproval", async (decision) => {
      decisions.push(decision)
      return { success: true }
    })
    const record = emitter(h)({
      kind: "approval",
      botId: null,
      threadId: "thread-dismiss",
      requestId: "pending-after-dismiss",
      title: "Approve command",
      body: "pwd",
    })
    expect((await h.call("POST", `/api/notifications/${record.id}/dismiss`)).status).toBe(200)
    expect(decisions).toEqual([])
  } finally {
    h.close()
  }
})
