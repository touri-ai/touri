import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Run } from "@touri/contracts"
import { createRateLimiter } from "../../src/cli/auth/rateLimit"
import { openAuthStore } from "../../src/cli/auth/store"
import { readClientConfig } from "../../src/cli/commands"
import { createHeadlessHost } from "../../src/cli/host/headlessHost"
import { createSecretStore } from "../../src/cli/host/secretStore"
import { createWebGate } from "../../src/cli/web/gate"
import { createKernel } from "../../src/kernel"
import { init as initNotify } from "../../src/notify"
import { createRuntimePersistence } from "../../src/runtime/persistence"
import { init as initStore } from "../../src/store"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const harness = async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-native-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const auth = await openAuthStore({ filename: join(root, "auth.db") })
  cleanups.push(() => auth.close())
  const secrets = createSecretStore({ dir: root, env: { TOURI_SECRETS_KEY: "test" } })
  const runtime = createKernel({
    appData: root,
    web: {
      hostname: "127.0.0.1",
      port: 0,
      host: createHeadlessHost({ secrets }),
      intercept: createWebGate({
        store: auth,
        secrets,
        limiter: createRateLimiter({ maxFailures: 8, windowMs: 60_000 }),
        ui: { source: "none", get: () => null },
      }),
    },
  })
  cleanups.push(() => runtime.stop())
  await initStore(runtime.kernel)
  await initNotify(runtime.kernel)
  const base = `http://127.0.0.1:${runtime.handshake.port}`
  const { code } = await auth.createPairingCode()
  const response = await fetch(`${base}/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, name: "island", client: true }),
  })
  expect(response.status).toBe(200)
  const { token, deviceId } = (await response.json()) as { token: string; deviceId: string }
  const call = (path: string, body?: unknown, bearer = token) =>
    fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${bearer}`, "X-Touri-Client": "island", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  return { root, auth, runtime, base, token, deviceId, call }
}

test("a paired native device streams events, responds, dismisses notifications and sends messages through headless serve", async () => {
  const h = await harness()
  const answers: Array<string> = []
  const runs: Array<string> = []
  h.runtime.kernel.services.provide("runtime.answerApproval", async ({ approvalId }) => {
    answers.push(approvalId)
    return { success: true }
  })
  h.runtime.kernel.services.provide("runtime.enqueue", ({ threadId, requestMessageId, trigger }) => {
    runs.push(threadId)
    const store = h.runtime.kernel.services.use("store.api")
    const thread = store?.getThread({ threadId })
    if (!thread) throw new Error("Thread missing")
    const run: Run = {
      id: "run-native",
      threadId,
      botId: thread.botId,
      provider: "codex",
      trigger,
      requestMessageId,
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
  const created = await h.call("/api/v1/bots", { name: "Native", provider: "codex" })
  expect(created.status).toBe(201)
  const { bot } = (await created.json()) as { bot: { id: string; mainThreadId: string } }
  const emit = h.runtime.kernel.services.use("notify.emit")
  if (!emit) throw new Error("notify.emit missing")
  const approval = emit({
    kind: "approval",
    botId: bot.id,
    threadId: bot.mainThreadId,
    requestId: "req-native",
    title: "Approve",
    body: "Test command",
  })
  const events = await h.call("/api/events")
  expect(events.status).toBe(200)
  expect(events.headers.get("content-type")).toContain("text/event-stream")
  const reader = events.body?.getReader()
  if (!reader) throw new Error("events body missing")
  try {
    let frames = ""
    while (!frames.includes("event: ready")) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error("stream closed before ready")
      frames += new TextDecoder().decode(chunk.value)
    }
    expect(frames).toContain('"requestId":"req-native"')
  } finally {
    await reader.cancel()
  }
  expect((await h.call("/api/notifications/pending")).status).toBe(200)
  expect(
    (await h.call(`/api/threads/${bot.mainThreadId}/respond`, { requestId: approval.requestId, behavior: "allow" }))
      .status,
  ).toBe(200)
  expect(answers).toEqual(["req-native"])
  const failed = emit({
    kind: "turn-failed",
    botId: bot.id,
    threadId: bot.mainThreadId,
    title: "Failed",
    body: "Retry",
  })
  expect((await h.call(`/api/notifications/${failed.id}/dismiss`, {})).status).toBe(200)
  expect((await h.call("/api/notifications/dismiss-all", {})).status).toBe(200)
  const sent = await h.call(`/api/bots/${bot.id}/messages`, { text: "hello", sendId: "native-send" })
  expect(sent.status).toBe(201)
  expect(await sent.json()).toMatchObject({
    message: { id: "send:native-send", runId: "run-native", delivery: { status: "acked" } },
    run: { id: "run-native", requestMessageId: "send:native-send" },
  })
  expect((await h.call(`/api/bots/${bot.id}/messages`, { text: "hello", sendId: "native-send" })).status).toBe(200)
  expect(runs).toEqual([bot.mainThreadId])
  const db = h.runtime.kernel.db as Database
  expect(db.query("SELECT status, run_id FROM send_journal").get()).toEqual({ status: "acked", run_id: "run-native" })
  expect(db.query("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 1 })
  expect(db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 1 })
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([])
  const endpoints: Array<[string, unknown?]> = [
    ["/api/events"],
    ["/api/notifications/pending"],
    ["/api/notifications/dismiss-all", {}],
    [`/api/notifications/${failed.id}/dismiss`, {}],
    [`/api/threads/${bot.mainThreadId}/respond`, { requestId: "req-native", behavior: "allow" }],
    [`/api/bots/${bot.id}/messages`, { text: "hello" }],
  ]
  for (const [path, body] of endpoints) expect((await h.call(path, body, "dev-ui-token")).status).toBe(401)
  await h.auth.revokeDevice(h.deviceId)
  for (const [path, body] of endpoints) expect((await h.call(path, body)).status).toBe(401)
})

for (const failure of ["missing-run", "exception"] as const) {
  test(`headless sends return a coded failure when enqueue reports ${failure} and keep that nonce terminal`, async () => {
    const h = await harness()
    let attempts = 0
    h.runtime.kernel.services.provide("runtime.enqueue", ({ threadId }) => {
      attempts += 1
      if (failure === "exception") throw new Error("private runtime failure")
      return { success: true, run: { id: "missing-run", threadId } as Run }
    })
    const created = await h.call("/api/v1/bots", { name: "Native", provider: "codex" })
    const { bot } = (await created.json()) as { bot: { id: string } }
    const path = `/api/bots/${bot.id}/messages`
    for (let retry = 0; retry < 2; retry++) {
      const response = await h.call(path, { text: "hello", sendId: "failed-send" })
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ errorCode: "TOURI-E1010", code: "TOURI-E1010", retryable: false })
    }
    h.runtime.kernel.services.use("store.api")?.drainSendQueue?.()
    expect(attempts).toBe(1)
    const db = h.runtime.kernel.db as Database
    expect(db.query("SELECT status, run_id, error_code FROM send_journal").get()).toEqual({
      status: "failed",
      run_id: null,
      error_code: "TOURI-E1010",
    })
    expect(db.query("SELECT delivery_status, run_id FROM messages").get()).toEqual({
      delivery_status: "failed",
      run_id: null,
    })
    expect(db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 1 })
    expect(db.query("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 0 })
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([])
  })
}

test("pair --client --print-token emits only a usable device token and saves a private client config", async () => {
  const h = await harness()
  const dataDir = join(h.root, "client")
  const { code } = await h.auth.createPairingCode()
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      join(import.meta.dir, "../../src/cli/main.ts"),
      "pair",
      "--client",
      "--print-token",
      "--url",
      h.base,
      "--code",
      code,
      "--data-dir",
      dataDir,
    ],
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exit).toBe(0)
    expect(stderr).toBe("")
    const config = readClientConfig(dataDir)
    expect(config?.url).toBe(h.base)
    expect(stdout).toBe(`${config?.token}\n`)
    expect(h.auth.verifyDeviceToken(stdout.trim())?.name).toBe("touri CLI")
    expect(statSync(join(dataDir, "client.json")).mode & 0o777).toBe(0o600)
    expect((await h.call("/api/notifications/pending", undefined, stdout.trim())).status).toBe(200)
  } finally {
    child.kill()
    await child.exited
  }
})
