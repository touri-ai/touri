import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, Kernel, Message, Run } from "@touri/contracts"
import { setDelegation } from "../../src/groups/security"
import { createKernel } from "../../src/kernel"
import { writeLearningState } from "../../src/learning/settings"
import { createMem0 } from "../../src/mem0/index"
import { createRuntimeEngine } from "../../src/runtime/engine"
import { init as initStore } from "../../src/store"
import { fakeProviderSpawn } from "../fakes/provider-spawn"

setDefaultTimeout(20_000)
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

const until = async (check: () => boolean, timeout = 10_000) => {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error("Timed out")
    await Bun.sleep(10)
  }
}

/** A real engine and store driving the fake Codex CLI, with Mem0 pointed at a recording fake. */
const fixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-mem0-runtime-"))
  const assets = mkdtempSync(join(tmpdir(), "touri-mem0-provider-"))
  const command = join(assets, "fake-codex")
  writeFileSync(
    command,
    `#!/bin/sh\nexec '${process.execPath}' run '${join(import.meta.dir, "../fakes/fake-codex.ts")}' "$@"\n`,
    { mode: 0o700 },
  )
  const scenario = join(assets, "scenario.json")
  const requestLog = join(assets, "requests.jsonl")
  writeFileSync(
    scenario,
    JSON.stringify({
      requestLogPath: requestLog,
      events: [{ type: "delta", delta: "Anotado." }, { type: "complete" }],
    }),
  )
  const runtime = createKernel({ appData: root })
  runtime.kernel.spawnTree = fakeProviderSpawn(runtime.kernel.spawnTree, command, scenario)
  const vault = new Map<string, string>()
  runtime.kernel.callHost = (async (method: string, params: { account: string; value?: string }) => {
    if (method === "keychain.set") vault.set(params.account, params.value ?? "")
    else if (method === "keychain.get") return { success: true, value: { value: vault.get(params.account) ?? null } }
    return { success: true, value: {} }
  }) as Kernel["callHost"]
  const seen: Array<{ path: string; body: Record<string, unknown> }> = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
      seen.push({ path: new URL(request.url).pathname, body })
      return Response.json({
        results: [{ id: "m1", memory: "O usuário mora em Porto Alegre.", score: 0.8 }],
      })
    },
  })
  await initStore(runtime.kernel)
  const mem0 = createMem0(runtime.kernel, { platformUrl: `http://127.0.0.1:${server.port}` })
  runtime.kernel.services.provide("mem0.api", mem0.api)
  runtime.kernel.registerRoutes(mem0.routes)
  const api = async (path: string, body: unknown, method = "POST") =>
    fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1${path}`, {
      method,
      headers: {
        Authorization: "Bearer dev-ui-token",
        Origin: "tauri://localhost",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    })
  const created = await api("/bots", { name: "memoria", provider: "codex", instructions: "Ajude." })
  const { bot } = (await created.json()) as { bot: Bot }
  const store = runtime.kernel.services.use("store.api")
  if (!store) throw new Error("store missing")
  const engine = createRuntimeEngine({
    kernel: runtime.kernel,
    codexCommand: command,
    environment: { PATH: process.env.PATH ?? "", TOURI_FAKE_SCENARIO: scenario },
  })
  cleanups.push(async () => {
    await engine.shutdown()
    server.stop(true)
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
    rmSync(assets, { recursive: true, force: true })
  })
  const send = (text: string, trigger: Run["trigger"] = "user", threadId = bot.mainThreadId ?? "") => {
    const message = store.insertMessage({
      message: {
        id: runtime.kernel.newId(),
        threadId,
        parentId: store.getThread({ threadId })?.activeLeafId ?? null,
        role: "user",
        kind: "text",
        status: "complete",
        runId: null,
        text,
        parts: [{ type: "text", text }],
        sender: null,
        source: "local",
      },
    })
    if (!message.success) throw new Error(message.error)
    const run = engine.enqueue({ threadId, requestMessageId: message.message.id, trigger })
    if (!run.success) throw new Error(run.error)
    return { message: message.message, run: run.run }
  }
  const finished = (run: Run) => ["succeeded", "failed", "canceled", "interrupted"].includes(run.status)
  const turnInputs = (): string[] =>
    existsSync(requestLog)
      ? readFileSync(requestLog, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { method: string; params?: { input?: Array<{ text?: string }> } })
          .filter((frame) => frame.method === "turn/start")
          .map((frame) => frame.params?.input?.[0]?.text ?? "")
      : []
  return { runtime, bot, store, engine, api, seen, send, finished, turnInputs }
}

test("an enabled bot gets recalled facts in the turn input while the stored message stays as typed", async () => {
  const f = await fixture()
  await f.api(`/bots/${f.bot.id}/mem0`, { enabled: true, apiKey: "m0-runtime" }, "PUT")
  const { message, run } = f.send("Que roupa levo para casa amanhã?")
  await until(() => f.finished(run))
  expect(run.status).toBe("succeeded")
  const [input] = f.turnInputs()
  expect(input?.startsWith("<mem0-recall>")).toBe(true)
  expect(input).toContain("- O usuário mora em Porto Alegre.")
  expect(input).toContain("Que roupa levo para casa amanhã?")
  const stored = f.store
    .activePath({ threadId: f.bot.mainThreadId ?? "" })
    .find((candidate: Message) => candidate.id === message.id)
  expect(stored?.text).toBe("Que roupa levo para casa amanhã?")
  await until(() => f.seen.some((request) => request.path === "/v3/memories/add/"))
  const add = f.seen.find((request) => request.path === "/v3/memories/add/")?.body as {
    messages: Array<{ role: string; content: string }>
    infer: boolean
  }
  expect(add.infer).toBe(true)
  expect(add.messages).toEqual([
    { role: "user", content: "Que roupa levo para casa amanhã?" },
    { role: "assistant", content: "Anotado." },
  ])
})

test("routine turns and disabled bots neither recall nor sync", async () => {
  const f = await fixture()
  const first = f.send("Que roupa levo para casa amanhã?")
  await until(() => f.finished(first.run))
  expect(f.turnInputs()[0]?.includes("mem0-recall")).toBe(false)
  await f.api(`/bots/${f.bot.id}/mem0`, { enabled: true, apiKey: "m0-runtime" }, "PUT")
  const routine = f.send("Resumo diário dos e-mails importantes", "routine")
  await until(() => f.finished(routine.run))
  expect(routine.run.status).toBe("succeeded")
  expect(f.turnInputs()[1]?.includes("mem0-recall")).toBe(false)
  await Bun.sleep(50)
  expect(f.seen).toEqual([])
})

test("canceling a turn also cancels recall before the provider starts", async () => {
  const f = await fixture()
  await f.api(`/bots/${f.bot.id}/mem0`, { enabled: true, apiKey: "m0-cancel-runtime" }, "PUT")
  const mem0 = f.runtime.kernel.services.use("mem0.api")
  if (!mem0) throw new Error("memory missing")
  let signal: AbortSignal | undefined
  let recalling = false
  f.runtime.kernel.services.provide("mem0.api", {
    ...mem0,
    recall: async (args) => {
      recalling = true
      signal = args.signal
      return new Promise<null>((resolve) => {
        const timer = setTimeout(() => resolve(null), 1_000)
        args.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer)
            resolve(null)
          },
          { once: true },
        )
      })
    },
  })
  const { run } = f.send("Qual a minha cidade?")
  await until(() => recalling)
  f.engine.cancel(run.id)
  expect(signal?.aborted).toBe(true)
  await until(() => f.finished(run))
  expect(f.turnInputs()).toEqual([])
  expect(f.seen).toEqual([])
})

test("delegation cannot recall or sync personal memory even without group metadata", async () => {
  const f = await fixture()
  await f.api(`/bots/${f.bot.id}/mem0`, { enabled: true, apiKey: "m0-delegated-runtime" }, "PUT")
  setDelegation(f.runtime.kernel, f.bot.mainThreadId ?? "", {
    ceiling: f.bot,
    caller: { id: "peer", name: "Bot de teste" },
    groupThreadId: "delegation-origin",
    secrets: false,
  })
  const { run } = f.send("Qual a minha cidade?")
  await until(() => f.finished(run))
  expect(run.status).toBe("succeeded")
  expect(f.turnInputs()[0]).not.toContain("<mem0-recall>")
  await Bun.sleep(30)
  expect(f.seen).toEqual([])
})

test("automatic learning reviews never recall or sync external memory", async () => {
  const f = await fixture()
  await f.api(`/bots/${f.bot.id}/mem0`, { enabled: true, apiKey: "m0-review-runtime" }, "PUT")
  const review = f.store.createThread({ botId: f.bot.id, kind: "chat", title: "Revisão de teste" })
  if (!review.success) throw new Error(review.error)
  writeLearningState(f.runtime.kernel, f.bot.id, { turns: 0, toolCalls: 0, reviewThreadId: review.thread.id })
  const { run } = f.send("Revise os fatos desta conversa.", "user", review.thread.id)
  await until(() => f.finished(run))
  expect(run.status).toBe("succeeded")
  expect(f.turnInputs()[0]).not.toContain("<mem0-recall>")
  await Bun.sleep(30)
  expect(f.seen).toEqual([])
})
