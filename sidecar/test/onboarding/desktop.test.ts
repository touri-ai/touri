import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, BotGroup, Kernel, Run, Thread } from "@touri/contracts"
import type { RunCommand } from "../../src/cli/tailscale"
import { init as initGroups } from "../../src/groups"
import { init as initStore } from "../../src/store"
import { createRuntimePersistence } from "../../src/runtime/persistence"
import { createKernel, type KernelRuntime } from "../../src/kernel"
import { createDesktopWeb } from "../../src/onboarding/desktop"

const fixtures = new Set<{
  runtime: KernelRuntime
  stop: () => Promise<void>
  close: () => Promise<void>
  directory: string
}>()
afterEach(async () => {
  for (const fixture of fixtures) {
    await fixture.stop()
    await fixture.runtime.stop()
    await fixture.close()
    await rm(fixture.directory, { recursive: true, force: true })
  }
  fixtures.clear()
})

const start = async (host?: Kernel["callHost"], prepare?: (kernel: Kernel) => void) => {
  const directory = await mkdtemp(join(tmpdir(), "touri-onboarding-test-"))
  const run: RunCommand = async () => ({ code: 127, stdout: "", stderr: "" })
  const desktop = await createDesktopWeb(directory, { run, localServerUrl: null })
  const runtime = createKernel({ appData: directory, web: { ...desktop.web, ...(host ? { host: () => host } : {}) } })
  const fixture = { runtime, stop: desktop.stop, close: desktop.close, directory }
  fixtures.add(fixture)
  prepare?.(runtime.kernel)
  await desktop.init(runtime.kernel, runtime.handshake.port)
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    token = process.env.TOURI_UI_TOKEN || "dev-ui-token",
  ) =>
    fetch(`http://127.0.0.1:${runtime.handshake.port}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "X-Touri-Client": "test", "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5000),
    })
  return { request, runtime, directory }
}

test("native first run completes without installing tools and persists completion", async () => {
  const fixture = await start()

  const initial = await (await fixture.request("/api/v1/onboarding")).json()
  const completed = await fixture.request("/api/v1/onboarding", "POST", { remote: false })
  const saved = await (await fixture.request("/api/v1/onboarding")).json()

  expect(initial).toMatchObject({ completed: false, hasData: false })
  expect(completed.status).toBe(200)
  expect(saved.completed).toBe(true)
  expect(await Bun.file(join(fixture.directory, "onboarding.json")).json()).toMatchObject({
    completed: true,
    remoteUrl: null,
  })
})

test("requires native authentication, rejects arbitrary outbound probes and remote devices", async () => {
  const fixture = await start()
  const pairingResponse = await fixture.request("/api/v1/onboarding/pair-code", "POST", {})
  const pairing = await pairingResponse.json()
  const claim = await fixture.request("/pair", "POST", { code: pairing.code, client: true, name: "Test device" }, "")
  const device = await claim.json()

  expect((await fixture.request("/api/v1/onboarding", "GET", undefined, "bad-token")).status).toBe(401)
  expect((await fixture.request("/api/v1/onboarding/probe", "POST", { url: "http://metadata.internal" })).status).toBe(
    403,
  )
  expect(claim.status).toBe(200)
  expect((await fixture.request("/api/v1/onboarding", "GET", undefined, device.token)).status).toBe(403)
  expect((await fixture.request("/api/v1/onboarding/pair-code", "POST", {}, device.token)).status).toBe(403)
})

test("paired administrators save credentials through the desktop vault and receive vault failures", async () => {
  const calls: Array<string> = []
  const host: Kernel["callHost"] = async (method) => {
    calls.push(method)
    return { success: false, errorCode: "VAULT_CANCELLED", error: "Vault access canceled" }
  }
  const fixture = await start(host)
  const pairing = await (await fixture.request("/api/v1/onboarding/pair-code", "POST", {})).json()
  const device = await (
    await fixture.request("/pair", "POST", { code: pairing.code, client: true, name: "Test device" }, "")
  ).json()

  const saved = await fixture.request(
    "/api/v1/host/secret",
    "POST",
    { account: "synthetic-account", value: "synthetic-value" },
    device.token,
  )

  expect(calls).toEqual(["keychain.set"])
  expect(saved.status).toBeGreaterThanOrEqual(400)
  expect(await Bun.file(join(fixture.directory, "secrets.enc")).exists()).toBe(false)
})

test("recognizes an existing data directory even when it has settings but no bots", async () => {
  const fixture = await start(undefined, (kernel) => {
    const database = kernel.db as Database
    database
      .query("INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)")
      .run("existing-preference", "true", 1_700_000_000_000)
  })

  const status = await (await fixture.request("/api/v1/onboarding")).json()

  expect(status).toMatchObject({ completed: true, hasData: true })
})

test("maintenance checkpoints never dismiss the welcome on a fresh installation", async () => {
  const fixture = await start(undefined, (kernel) => {
    const database = kernel.db as Database
    database
      .query("INSERT OR REPLACE INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)")
      .run("storage.maintenance.progress", '{"cursor":0,"total":0}', 1_700_000_000_000)
    database
      .query("INSERT OR REPLACE INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)")
      .run("storage.upgrade.22", '{"cursor":0,"total":0}', 1_700_000_000_000)
  })

  const status = await (await fixture.request("/api/v1/onboarding")).json()

  expect(status).toMatchObject({ completed: false, hasData: false })
})

test("forwarded requests cannot use the privileged desktop credential", async () => {
  const fixture = await start()

  const response = await fetch(`http://127.0.0.1:${fixture.runtime.handshake.port}/api/v1/onboarding`, {
    headers: {
      Authorization: `Bearer ${process.env.TOURI_UI_TOKEN || "dev-ui-token"}`,
      "X-Touri-Client": "test",
      "X-Forwarded-Proto": "https",
      "X-Forwarded-Host": "studio.example.ts.net",
    },
    signal: AbortSignal.timeout(5000),
  })

  expect(response.status).toBe(401)
})

test("native owner can read invites, open the real channel and send the first task", async () => {
  const fixture = await start(async () => ({ success: true, value: {} }))
  await initStore(fixture.runtime.kernel)
  await initGroups(fixture.runtime.kernel)
  const kernel = fixture.runtime.kernel
  kernel.services.provide("runtime.enqueue", ({ threadId, requestMessageId, trigger }) => {
    const run: Run = {
      id: kernel.newId(),
      threadId,
      requestMessageId,
      trigger,
      botId: null,
      provider: "codex",
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
    createRuntimePersistence({ database: kernel.db }).saveRun(run)
    return { success: true, run }
  })
  const created = await fixture.request("/api/v1/bots", "POST", { name: "guia", provider: "codex" })
  const { bot } = (await created.json()) as { bot: Bot }
  const channel = await fixture.request("/api/v1/groups", "POST", {
    name: "geral",
    color: "#dc2626",
    memberIds: [bot.id],
  })
  const { group } = (await channel.json()) as { group: BotGroup }

  const session = await fixture.request("/api/v1/session")
  const invites = await fixture.request("/api/v1/invites")
  const conversations = await fixture.request(`/api/v1/groups/${group.id}/threads`)
  const { threads } = (await conversations.json()) as { threads: Thread[] }
  const thread = threads[0]
  if (!thread) throw new Error("Missing synthetic channel thread")
  const sent = await fixture.request(`/api/v1/threads/${thread.id}/messages`, "POST", {
    threadId: thread.id,
    text: "@guia Organize três prioridades.",
    parentId: null,
    attachmentIds: [],
    clientNonce: "first-task",
    sender: { id: "forged", name: "Forged", kind: "person", avatarSeed: "forged" },
  })

  expect(session.status).toBe(200)
  expect(await session.json()).toMatchObject({ person: { id: "owner", role: "admin" } })
  expect(invites.status).toBe(200)
  expect(conversations.status).toBe(200)
  expect(sent.status).toBe(201)
  expect(await sent.json()).toMatchObject({
    message: { sender: { id: "owner", kind: "person" }, delivery: { status: "acked" } },
  })
  expect((await fixture.request("/api/v1/invites", "GET", undefined, "bad-token")).status).toBe(401)
  expect((await fixture.request("/api/v1/onboarding")).status).toBe(200)
  const integration = await fixture.request(`/api/v1/threads/${thread.id}/messages`, "POST", {
    asBotId: bot.id,
    text: "Escopo ausente",
  })
  expect(integration.status).toBe(403)
  const ticketResponse = await fixture.request("/api/v1/ws-ticket", "POST", { path: "/api/v1/events" })
  const ticket = (await ticketResponse.json()) as { ticket: string }
  const socket = new WebSocket(
    `ws://127.0.0.1:${fixture.runtime.handshake.port}/api/v1/events?ticket=${ticket.ticket}`,
    { headers: { "X-Touri-Client": "test" } },
  )
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close()
      reject(new Error("Native socket deadline"))
    }, 5000)
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timeout)
        resolve()
      },
      { once: true },
    )
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timeout)
        reject(new Error("Native socket rejected"))
      },
      { once: true },
    )
  })
  socket.close()
})
