import type { Database } from "bun:sqlite"
import { expect, setDefaultTimeout, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, Message, StoreApi, Thread } from "@touri/contracts"
import { t } from "../../../ui/src/i18n"
import { createStandingGrantStore } from "../../src/approvals/grants"
import { mcpStartupChecks } from "../../src/doctor/mcp"
import { createKernel } from "../../src/kernel"
import { openDatabase } from "../../src/kernel/db"
import { init as initNotify } from "../../src/notify"
import { createCodexAdapter } from "../../src/runtime/codex/adapter"
import { createRuntimeEngine } from "../../src/runtime/engine"
import { MCP_STARTUP_MESSAGE } from "../../src/runtime/mcp-startup"
import { createRuntimePersistence } from "../../src/runtime/persistence"
import { createRoutineScheduler } from "../../src/runtime/routines/scheduler"
import { init as initStore } from "../../src/store"
import { fakeProviderSpawn } from "../fakes/provider-spawn"
import { createTestStore, type TestStore } from "./fake-store"

const repoRoot = join(import.meta.dir, "..", "..", "..")
setDefaultTimeout(15_000)
const runtimeTest = test as unknown as { serial: typeof test }
runtimeTest.serial ??= test
const fakeCodex = join(repoRoot, "sidecar", "test", "fakes", "fake-codex.ts")
const fakeClaude = join(repoRoot, "sidecar", "test", "fakes", "fake-claude.ts")

type Fixture = {
  root: string
  assets: string
  runtime: ReturnType<typeof createKernel>
  engine: ReturnType<typeof createRuntimeEngine>
  store: TestStore
  bot: Bot
  thread: Thread
  scenario: string
  logPath: string
  fakePath: string
}

const waitFor = async (predicate: () => boolean, timeout = 10_000): Promise<void> => {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error("Timed out waiting for runtime state")
    await Bun.sleep(10)
  }
}

const seedDatabase = ({ database, bot, thread }: { database: Database; bot: Bot; thread: Thread }): void => {
  database
    .query(
      `INSERT INTO bots (id, name, instructions, instructions_hash, provider, access, approvals, home_dir, project_id, cwd, main_thread_id, browser_enabled, computer_use, notifications, paused, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 1, 0, 'all', 0, 'local', ?, ?)`,
    )
    .run(
      bot.id,
      bot.name,
      bot.instructions,
      bot.instructionsHash,
      bot.provider,
      bot.access,
      bot.approvals,
      bot.homeDir,
      bot.cwd,
      bot.mainThreadId,
      bot.createdAt,
      bot.updatedAt,
    )
  database
    .query(
      `INSERT INTO threads (id, bot_id, kind, title, active_leaf_id, unread, usage_json, source, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 0, '{}', 'local', ?, ?)`,
    )
    .run(thread.id, thread.botId, thread.kind, thread.title, thread.createdAt, thread.updatedAt)
}

const fixture = async ({
  provider = "codex" as Bot["provider"],
  scenario: scenarioValue,
  maxConcurrentRuns = 3,
  interruptGraceMs,
  routineTimeoutMs,
}: {
  provider?: Bot["provider"]
  scenario?: Record<string, unknown>
  maxConcurrentRuns?: number
  interruptGraceMs?: number
  routineTimeoutMs?: number
} = {}): Promise<Fixture> => {
  const root = mkdtempSync(join(tmpdir(), "touri-wp3-"))
  // Provider fixtures live outside app data, just like installed user CLIs.
  const assets = mkdtempSync(join(tmpdir(), "touri-provider-fixture-"))
  const fakePath = join(assets, "fake-codex")
  const scenario = join(assets, "scenario.json")
  const logPath = join(assets, "provider.log")
  const fakeSource = provider === "claude" ? fakeClaude : fakeCodex
  const wrapper = `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(fakeSource)} "$@"\n`
  writeFileSync(fakePath, wrapper, { mode: 0o700 })
  chmodSync(fakePath, 0o700)
  writeFileSync(
    scenario,
    JSON.stringify(
      scenarioValue ?? {
        deltas: ["one ", "two ", "three"],
        events: [
          { type: "usage", usage: { inputTokens: 3, outputTokens: 4 } },
          { type: "delta", delta: "hello" },
          { type: "command", command: "echo ok", output: "ok" },
          { type: "complete" },
        ],
      },
    ),
  )
  const runtime = createKernel({ appData: root })
  runtime.kernel.spawnTree = fakeProviderSpawn(runtime.kernel.spawnTree, fakePath, scenario)
  const timestamp = Date.now()
  const bot: Bot = {
    id: "bot-runtime",
    name: "runtime",
    title: null,
    description: null,
    color: null,
    avatarPath: null,
    instructions: "Be useful.",
    instructionsHash: "hash",
    provider,
    model: null,
    reasoningEffort: "medium",
    access: "workspace-write",
    approvals: "on-request",
    projectId: null,
    cwd: process.cwd(),
    homeDir: join(root, "bots", "bot-runtime"),
    mainThreadId: "thread-runtime",
    browserEnabled: true,
    browser: "touri",
    computerUse: false,
    machine: "local",
    machineIdleMinutes: 15,
    vmProviderLogin: false,
    hostComputerUse: false,
    notifications: "all",
    section: null,
    sortOrder: 0,
    paused: false,
    source: "local",
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
  }
  const thread: Thread = {
    id: "thread-runtime",
    botId: bot.id,
    parentThreadId: null,
    kind: "main",
    title: "Runtime test",
    activeLeafId: null,
    routineRunId: null,
    cwdOverride: null,
    unread: 0,
    carryoverNote: null,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costUsd: null,
      turns: 0,
      contextTokens: null,
      contextWindow: null,
    },
    source: "local",
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
  }
  mkdirSync(bot.homeDir, { recursive: true })
  writeFileSync(join(bot.homeDir, "MEMORY.md"), "Memory fixture\n")
  seedDatabase({ database: runtime.kernel.db as Database, bot, thread })
  const store = createTestStore({ bot, thread, publish: runtime.kernel.publish })
  runtime.kernel.services.provide("store.api", store)
  const engine = createRuntimeEngine({
    kernel: runtime.kernel,
    ...(provider === "claude" ? { claudeCommand: fakePath } : { codexCommand: fakePath }),
    environment: {
      PATH: process.env.PATH ?? "/usr/bin",
      SHELL: process.env.SHELL ?? "/bin/zsh",
      TOURI_FAKE_SCENARIO: scenario,
    },
    maxConcurrentRuns,
    ...(interruptGraceMs === undefined ? {} : { interruptGraceMs }),
    ...(routineTimeoutMs === undefined ? {} : { routineTimeoutMs: () => routineTimeoutMs }),
  })
  return { root, assets, runtime, engine, store, bot, thread, scenario, logPath, fakePath }
}

const closeFixture = async (value: Fixture): Promise<void> => {
  await value.engine.shutdown()
  await value.runtime.stop()
  rmSync(value.root, { recursive: true, force: true })
  rmSync(value.assets, { recursive: true, force: true })
}

test("pausing a cached routine prevents cron attempts and survives runtime replacement", async () => {
  const f = await fixture({
    scenario: { slowMs: 50, events: [{ type: "delta", delta: "horário" }, { type: "complete" }] },
  })
  const writerDb = openDatabase({ filename: f.runtime.kernel.paths.db })
  let reopened: ReturnType<typeof createKernel> | undefined
  let replacement: ReturnType<typeof createRuntimeEngine> | undefined
  try {
    const result = f.engine.createRoutine({
      forceDisabled: false,
      input: {
        botId: f.bot.id,
        name: "teste-relogio",
        prompt: "horário",
        cron: "*/5 * * * *",
        timezone: "America/Sao_Paulo",
        enabled: true,
        continuity: "main-thread",
        resultsThreadId: null,
        groupId: null,
        timeoutMinutes: 30,
        overlap: "skip",
        catchUpMinutes: 30,
      },
    })
    if (!result.success) throw new Error(result.error)
    const running = f.engine.runRoutine({ routineId: result.routine.id, triggerSource: "manual" })
    if (!running.success) throw new Error(running.error)
    f.engine.listRoutines()
    const writer = createRuntimePersistence({ database: writerDb })
    writer.updateRoutine({ ...result.routine, enabled: false, nextRunAt: null })
    await f.engine.tick(Date.now() + 600_000)
    expect(f.engine.listRoutineRuns(result.routine.id)).toHaveLength(1)
    expect(f.engine.listRoutines()[0]?.enabled).toBe(false)
    expect(f.engine.runRoutine({ routineId: result.routine.id, triggerSource: "cron" }).success).toBe(false)
    await waitFor(() => f.engine.listRoutineRuns(result.routine.id)[0]?.status === "succeeded")
    await f.engine.shutdown()
    reopened = createKernel({ appData: f.root })
    reopened.kernel.spawnTree = fakeProviderSpawn(reopened.kernel.spawnTree, f.fakePath, f.scenario)
    reopened.kernel.services.provide("store.api", f.store)
    replacement = createRuntimeEngine({ kernel: reopened.kernel, codexCommand: f.fakePath })
    await Promise.all([f.engine.tick(Date.now() + 900_000), replacement.tick(Date.now() + 900_000)])
    expect(replacement.listRoutineRuns(result.routine.id)).toHaveLength(1)
    expect(replacement.listRoutines()[0]).toMatchObject({ enabled: false, nextRunAt: null })
  } finally {
    await replacement?.shutdown()
    reopened?.stop()
    writerDb.close()
    await closeFixture(f)
  }
})

const addUser = (store: StoreApi, thread: Thread, text: string): Message => {
  const parentId = thread.activeLeafId
  const result = store.insertMessage({
    message: {
      id: `user-${Date.now()}-${Math.random()}`,
      threadId: thread.id,
      parentId,
      role: "user",
      kind: "text",
      status: "complete",
      runId: null,
      text,
      parts: [{ type: "text", text }],
      sender: { name: "user", id: "user" },
      source: "local",
    },
  })
  if (!result.success) throw new Error(result.error)
  return result.message
}

const terminal = (status: string): boolean => ["succeeded", "failed", "canceled", "interrupted"].includes(status)

test("an attached CSV reaches the provider as real rows rather than a filename placeholder", async () => {
  const f = await fixture()
  try {
    const requestLogPath = join(f.assets, "csv-requests.jsonl")
    writeFileSync(f.scenario, JSON.stringify({ requestLogPath, events: [{ type: "complete" }] }))
    const path = join(f.runtime.kernel.paths.attachmentsDir, "cadastros.csv")
    mkdirSync(f.runtime.kernel.paths.attachmentsDir, { recursive: true })
    const csv = "cadastro,valor\nregistro-a,12\nregistro-b,30\n"
    writeFileSync(path, csv)
    ;(f.runtime.kernel.db as Database)
      .query("INSERT INTO attachments(id,path,mime,bytes,created_at) VALUES (?,?,?,?,1)")
      .run("table", path, "text/csv", Buffer.byteLength(csv))
    const request = addUser(f.store, f.thread, "Some os valores dos cadastros anexados.")
    request.parts.push({ type: "file", attachmentId: "table", mime: "text/csv", name: "cadastros.csv" })
    const result = f.engine.enqueue({ threadId: f.thread.id, requestMessageId: request.id, trigger: "user" })
    if (!result.success) throw new Error(result.error)
    await waitFor(() => terminal(result.run.status))
    expect(result.run.status).toBe("succeeded")
    const frames = readFileSync(requestLogPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    const text = frames.find((frame) => frame.method === "turn/start").params.input[0].text
    expect(text).toContain(JSON.stringify({ name: "cadastros.csv", content: csv }))
    expect(text).toContain("do not invent records")
    expect(text).not.toContain(path)
  } finally {
    await closeFixture(f)
  }
})

test.each([
  ["codex", "stderr"],
  ["codex", "event"],
  ["codex", "legacy-event"],
  ["claude", "stderr"],
  ["claude", "event"],
] as const)(
  "%s MCP startup failure via %s fails the run, explains it in chat and reaches Doctor",
  async (provider, source) => {
    const frame =
      provider === "claude"
        ? { type: "system", subtype: "init", mcp_servers: [{ name: "touri", status: "failed" }] }
        : source === "legacy-event"
          ? {
              method: "codex/event",
              params: {
                msg: { type: "mcp_startup_complete", failed: [{ server: "touri", error: "initialize closed" }] },
              },
            }
          : {
              method: "mcpServer/startupStatus/updated",
              params: { name: "touri", status: "failed", error: "initialize closed" },
            }
    const f = await fixture({
      provider,
      scenario:
        source === "stderr"
          ? {
              startupStderr:
                'MCP server startup failed server_name="touri" error=handshaking with MCP server failed: connection closed: initialize response',
              events: [{ type: "sleep" }],
              slowMs: 1000,
            }
          : { events: [frame, { type: "sleep" }], slowMs: 1000 },
    })
    try {
      const db = f.runtime.kernel.db as Database
      // The fake store executes locally; Doctor reads VM identity from its isolated database.
      db.query("UPDATE bots SET machine = 'vm' WHERE id = ?").run(f.bot.id)
      const request = addUser(f.store, f.thread, "Abra o navegador")
      const started = f.engine.enqueue({ threadId: f.thread.id, requestMessageId: request.id, trigger: "user" })
      if (!started.success) throw new Error(started.error)
      await waitFor(() => terminal(f.engine.listRuns(f.thread.id)[0]?.status ?? ""))
      expect(f.engine.listRuns(f.thread.id)[0]).toMatchObject({
        status: "failed",
        errorClass: "cli_protocol",
        errorMessage: expect.stringMatching(new RegExp(`^${MCP_STARTUP_MESSAGE} \\[etapa: [a-z_]+\\]$`)),
      })
      const reply = f.store.activePath({ threadId: f.thread.id }).find((item) => item.runId === started.run.id)
      expect(reply?.parts).toContainEqual(
        expect.objectContaining({
          type: "notice",
          code: "run_failed",
          text: expect.stringContaining(MCP_STARTUP_MESSAGE),
        }),
      )
      expect(mcpStartupChecks(db)).toContainEqual(
        expect.objectContaining({
          id: `vm-mcp:${f.bot.id}`,
          status: "fail",
          detail: expect.stringContaining(MCP_STARTUP_MESSAGE),
        }),
      )
      writeFileSync(f.scenario, JSON.stringify({ deltas: ["recuperado"] }))
      const next = f.engine.enqueue({
        threadId: f.thread.id,
        requestMessageId: addUser(f.store, f.thread, "Tente novamente").id,
        trigger: "user",
      })
      if (!next.success) throw new Error(next.error)
      await waitFor(() => f.engine.listRuns(f.thread.id).some((run) => run.id === next.run.id && terminal(run.status)))
      expect(f.engine.listRuns(f.thread.id).find((run) => run.id === next.run.id)?.status).toBe("succeeded")
      expect(mcpStartupChecks(db)[0]?.status).toBe("pass")
    } finally {
      await closeFixture(f)
    }
  },
)

test("an unrelated MCP server failure does not disable touri tools", async () => {
  const f = await fixture({
    scenario: {
      events: [
        { method: "mcpServer/startupStatus/updated", params: { name: "external", status: "failed" } },
        { type: "delta", delta: 'MCP server startup failed server_name="touri" is a quoted diagnostic' },
        { type: "complete" },
      ],
    },
  })
  try {
    const run = f.engine.enqueue({
      threadId: f.thread.id,
      requestMessageId: addUser(f.store, f.thread, "Teste").id,
      trigger: "user",
    })
    if (!run.success) throw new Error(run.error)
    await waitFor(() => terminal(f.engine.listRuns(f.thread.id)[0]?.status ?? ""))
    expect(f.engine.listRuns(f.thread.id)[0]?.status).toBe("succeeded")
  } finally {
    await closeFixture(f)
  }
})

test.each(["claude", "codex"] as const)(
  "%s reasoning reaches the transcript while the reply is streaming",
  async (provider) => {
    const thinking = (index: number, text: string) =>
      provider === "claude"
        ? {
            type: "stream_event",
            event: { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: text } },
          }
        : { method: "item/reasoning/summaryTextDelta", params: { itemId: `reason-${index}`, delta: text } }
    const f = await fixture({
      provider,
      scenario: {
        slowMs: 50,
        events: [
          thinking(0, "Conferi a fila. "),
          thinking(0, "Verificando o lock."),
          provider === "claude"
            ? { type: "tool", callId: "read", name: "Read", input: { file_path: "/project/payout.ts" } }
            : {
                method: "item/started",
                params: {
                  item: {
                    type: "mcpToolCall",
                    id: "read",
                    tool: "Read",
                    arguments: { file_path: "/project/payout.ts" },
                  },
                },
              },
          thinking(2, "Conferindo "),
          thinking(2, "o resultado."),
          { type: "delta", delta: "Pronto." },
          { type: "complete" },
        ],
      },
    })
    try {
      await initStore(f.runtime.kernel)
      const store = f.runtime.kernel.services.use("store.api")
      if (!store) throw new Error("Store missing")
      const snapshots: Message[] = []
      const append = store.appendDelta
      store.appendDelta = (args) => {
        append(args)
        const reply = store.activePath({ threadId: f.thread.id }).find((item) => item.id === args.messageId)
        if (reply?.parts[args.partIndex]?.type === "reasoning") snapshots.push(structuredClone(reply))
      }
      const queued = f.engine.enqueue({
        threadId: f.thread.id,
        requestMessageId: addUser(store, f.thread, "Confira a fila.").id,
        trigger: "user",
      })
      if (!queued.success) throw new Error(queued.error)
      await waitFor(() => terminal(queued.run.status))
      expect(queued.run.status).toBe("succeeded")
      expect(snapshots.length).toBeGreaterThanOrEqual(2)
      expect(snapshots.every((reply) => reply.status === "streaming" && reply.text === "")).toBe(true)
      const reply = store.activePath({ threadId: f.thread.id }).find((item) => item.role === "assistant")
      expect(reply?.parts.filter((part) => part.type === "reasoning")).toEqual([
        { type: "reasoning", text: "Conferi a fila. Verificando o lock." },
        { type: "reasoning", text: "Conferindo o resultado." },
      ])
      expect(reply?.text).toBe("Pronto.")
      const deltas = (f.runtime.kernel.db as Database)
        .query(
          "SELECT event_json FROM transcript_entries WHERE json_extract(event_json, '$.partType') = 'reasoning' ORDER BY id",
        )
        .all() as { event_json: string }[]
      expect(deltas.length).toBeGreaterThanOrEqual(2)
    } finally {
      await closeFixture(f)
    }
  },
)

test("provider hidden thinking estimates reach live parts without inventing reasoning text", async () => {
  const thinking = (estimated_tokens: number) => ({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "", signature: "opaque-signature", estimated_tokens },
    },
  })
  const f = await fixture({
    provider: "claude",
    scenario: {
      slowMs: 25,
      events: [thinking(120), thinking(230), { type: "delta", delta: "Pronto." }, { type: "complete" }],
    },
  })
  const live: Message["parts"][] = []
  const unsubscribe = f.runtime.kernel.subscribe(({ event }) => {
    if (
      (event.type === "message.created" || event.type === "message.updated") &&
      event.message.role === "assistant" &&
      event.message.status === "streaming"
    )
      live.push(event.message.parts)
    if (event.type === "message.parts") live.push(event.parts.map(({ part }) => part))
  })
  try {
    await initStore(f.runtime.kernel)
    const store = f.runtime.kernel.services.use("store.api")
    if (!store) throw new Error("Store missing")
    const queued = f.engine.enqueue({
      threadId: f.thread.id,
      requestMessageId: addUser(store, f.thread, "Confira a fila.").id,
      trigger: "user",
    })
    if (!queued.success) throw new Error(queued.error)
    await waitFor(() => terminal(queued.run.status))
    expect(queued.run.status).toBe("succeeded")
    expect(
      new Set(
        live.flatMap((parts) => parts.flatMap((part) => (part.type === "reasoning" ? [part.estimatedTokens] : []))),
      ),
    ).toEqual(new Set([120, 350]))
    expect(live.every((parts) => parts.every((part) => part.type !== "text" || part.text === ""))).toBe(true)
    const reply = store.activePath({ threadId: f.thread.id }).find((item) => item.role === "assistant")
    expect(reply?.parts).toEqual([
      { type: "reasoning", text: "", estimatedTokens: 350 },
      { type: "text", text: "Pronto." },
    ])
    expect(reply?.text).toBe("Pronto.")
    const rows = (f.runtime.kernel.db as Database).query("SELECT event_json FROM transcript_entries").all()
    expect(JSON.stringify(rows)).not.toContain("opaque-signature")
  } finally {
    unsubscribe()
    await closeFixture(f)
  }
})

test("interleaved text and reasoning keep transcript snapshots and delta offsets intact", async () => {
  const f = await fixture({
    scenario: {
      events: [
        { method: "item/agentMessage/delta", params: { itemId: "intro", delta: "Vou " } },
        { method: "item/agentMessage/delta", params: { itemId: "intro", delta: "conferir." } },
        { type: "reasoning_delta", delta: "Conferindo " },
        { type: "reasoning_delta", delta: "a fila." },
        { method: "item/agentMessage/delta", params: { itemId: "reply", delta: "Pronto" } },
        { method: "item/agentMessage/delta", params: { itemId: "reply", delta: "." } },
        { type: "complete" },
      ],
    },
  })
  try {
    await initStore(f.runtime.kernel)
    const store = f.runtime.kernel.services.use("store.api")
    if (!store) throw new Error("Store missing")
    const snapshots: Message[] = []
    const append = store.appendDelta
    store.appendDelta = (args) => {
      append(args)
      const reply = store.activePath({ threadId: f.thread.id }).find((message) => message.id === args.messageId)
      if (reply) snapshots.push(reply)
    }
    const queued = f.engine.enqueue({
      threadId: f.thread.id,
      requestMessageId: addUser(store, f.thread, "Confira a fila.").id,
      trigger: "user",
    })
    if (!queued.success) throw new Error(queued.error)
    await waitFor(() => terminal(queued.run.status))
    expect(queued.run.status).toBe("succeeded")
    expect(snapshots.map((message) => message.text)).toEqual([
      "Vou ",
      "Vou conferir.",
      "Vou conferir.",
      "Vou conferir.\n\nPronto",
      "Vou conferir.\n\nPronto.",
    ])
    const reply = store.activePath({ threadId: f.thread.id }).find((message) => message.role === "assistant")
    expect(reply?.parts).toEqual([
      { type: "text", text: "Vou conferir." },
      { type: "reasoning", text: "Conferindo a fila." },
      { type: "text", text: "\n\nPronto." },
    ])
    const rows = (f.runtime.kernel.db as Database)
      .query(
        "SELECT event_json FROM transcript_entries WHERE json_extract(event_json, '$.type') = 'message.delta' ORDER BY id",
      )
      .all() as { event_json: string }[]
    expect(
      rows.map((row) => {
        const event = JSON.parse(row.event_json)
        return [event.partIndex, event.offset, event.delta]
      }),
    ).toEqual([
      [0, 0, "Vou "],
      [0, 4, "conferir."],
      [1, 11, "a fila."],
      [2, 0, "\n\nPronto"],
      [2, 8, "."],
    ])
  } finally {
    await closeFixture(f)
  }
})

test("Codex Markdown item boundaries survive deltas, completed-only items and persisted transcript reads", async () => {
  const first = "Vou inspecionar os links públicos e visitar duas rotas reais, capturando cada tela na VM."
  const second = "Os links legais existem, mas o clique automático falhou na verificação do alvo."
  const table =
    "Visitei três rotas reais; as capturas de /terms e /privacy estão inline acima.\n\n| URL | Título | Primeiro botão |\n|---|---|---|\n| https://touri.ai/ | touri.ai | Entrar na waitlist |\n\n- Nenhum formulário foi enviado."
  const delta = (itemId: string, text: string) => ({
    method: "item/agentMessage/delta",
    params: { itemId, delta: text },
  })
  const completed = (id: string, text: string) => ({
    method: "item/completed",
    params: { item: { type: "agentMessage", id, text } },
  })
  const value = await fixture({
    scenario: {
      events: [
        delta("intro", first.slice(0, 60)),
        delta("intro", first.slice(60)),
        completed("intro", first),
        completed("links", second),
        delta("table", table.slice(0, 90)),
        completed("table", table),
        completed("table", table),
        { type: "complete" },
      ],
    },
  })
  try {
    await initStore(value.runtime.kernel)
    const store = value.runtime.kernel.services.use("store.api")
    if (!store) throw new Error("Store missing")
    const request = addUser(store, value.thread, "Confira os links.")
    const queued = value.engine.enqueue({ threadId: value.thread.id, requestMessageId: request.id, trigger: "user" })
    if (!queued.success) throw new Error(queued.error)
    await waitFor(() => terminal(queued.run.status))
    expect(queued.run.status).toBe("succeeded")
    const reply = store.activePath({ threadId: value.thread.id }).find((item) => item.role === "assistant")
    const expected = [first, second, table].join("\n\n")
    expect(reply?.text).toBe(expected)
    expect(reply?.parts.find((part) => part.type === "text")).toEqual({ type: "text", text: expected })
    expect(
      (value.runtime.kernel.db as Database).query("SELECT text FROM messages WHERE id = ?").get(reply?.id ?? ""),
    ).toEqual({ text: expected })
    const events = (value.runtime.kernel.db as Database)
      .query(
        "SELECT event_json FROM transcript_entries WHERE json_extract(event_json, '$.type') = 'message.delta' ORDER BY id",
      )
      .all() as { event_json: string }[]
    expect(events.map((row) => (JSON.parse(row.event_json) as { delta: string }).delta).join("")).toBe(expected)
  } finally {
    await closeFixture(value)
  }
})

test("Codex process failures show coded chat errors with the sanitized provider message and preserve stderr in the run and log", async () => {
  const detail = "The requested model is not available for this account"
  const value = await fixture({
    scenario: { crashAt: 1, stderr: detail, events: [{ type: "delta", delta: "unused" }] },
  })
  try {
    const request = addUser(value.store, value.thread, "hello")
    const result = value.engine.enqueue({ threadId: value.thread.id, requestMessageId: request.id, trigger: "user" })
    if (!result.success) throw new Error(result.error)
    await waitFor(() => terminal(result.run.status))
    expect(result.run.errorMessage).toContain(detail)
    const reply = value.store.messages.get(result.run.replyMessageId ?? "")
    expect(JSON.stringify(reply?.parts)).toContain("TOURI-E3002")
    expect(JSON.stringify(reply?.parts)).toContain(`Detalhe do provedor: Codex exited (17): ${detail}`)
    expect(readFileSync(join(value.root, "logs", "sidecar.log"), "utf8")).toContain(detail)
  } finally {
    await closeFixture(value)
  }
})

test("manual routine completion publishes its final state without a reload", async () => {
  const value = await fixture()
  const events: import("@touri/contracts").UiEvent[] = []
  const unsubscribe = value.runtime.kernel.subscribe(({ event }) => events.push(event))
  try {
    const created = value.engine.createRoutine({
      input: {
        botId: value.bot.id,
        name: "clock",
        prompt: "time",
        cron: "*/5 * * * *",
        timezone: "America/Sao_Paulo",
        enabled: false,
        continuity: "main-thread",
        resultsThreadId: null,
        groupId: null,
        timeoutMinutes: 30,
        overlap: "skip",
        catchUpMinutes: 30,
      },
      forceDisabled: false,
    })
    if (!created.success) throw new Error(created.error)
    const result = value.engine.runRoutine({ routineId: created.routine.id, triggerSource: "manual" })
    if (!result.success) throw new Error(result.error)
    await waitFor(() => value.engine.listRoutineRuns(created.routine.id)[0]?.status === "succeeded")
    expect(
      events.some(
        (event) =>
          event.type === "routine.updated" &&
          event.lastRun?.id === result.routineRun.id &&
          event.lastRun.status === "succeeded",
      ),
    ).toBe(true)
  } finally {
    unsubscribe()
    await closeFixture(value)
  }
})

test.each([
  {
    method: "error",
    params: { error: { message: "401: expired Codex login", additionalDetails: "Refresh the session" } },
  },
  {
    method: "turn/completed",
    params: {
      turn: {
        status: "failed",
        error: { message: "401: expired Codex login", additionalDetails: "Refresh the session" },
      },
    },
  },
])("nested Codex errors keep diagnostics in the run and log and show a coded chat error: %j", async (frame) => {
  const value = await fixture({ scenario: { events: [frame] } })
  try {
    const request = addUser(value.store, value.thread, "hello")
    const result = value.engine.enqueue({ threadId: value.thread.id, requestMessageId: request.id, trigger: "user" })
    if (!result.success) throw new Error(result.error)
    await waitFor(() => terminal(result.run.status))
    expect(result.run).toMatchObject({ status: "failed", errorClass: "cli_auth" })
    expect(result.run.errorMessage).toContain("401: expired Codex login")
    expect(result.run.errorMessage).toContain("Refresh the session")
    const reply = [...value.store.messages.values()].find((message) => message.id === result.run.replyMessageId)
    expect(JSON.stringify(reply?.parts)).toContain("TOURI-E3001")
    expect(JSON.stringify(reply?.parts)).not.toContain("expired Codex login")
    expect(readFileSync(join(value.root, "logs", "sidecar.log"), "utf8")).toContain("expired Codex login")
  } finally {
    await closeFixture(value)
  }
})

test.serial("streaming preserves deltas, command parts, completion and usage", async () => {
  const value = await fixture()
  try {
    const request = addUser(value.store, value.thread, "run the fixture")
    const queued = value.engine.enqueue({ threadId: value.thread.id, requestMessageId: request.id, trigger: "user" })
    expect(queued.success).toBe(true)
    if (!queued.success) return
    await waitFor(() => terminal(queued.run.status))
    expect(queued.run.status).toBe("succeeded")
    const assistant = [...value.store.messages.values()].find((message) => message.role === "assistant")
    expect(assistant?.status).toBe("complete")
    // The fixture ends on a command with no closing text, so the turn gets a confirmed conclusion.
    expect(assistant?.text).toBe("hello\n\nDone.")
    expect(assistant?.parts.some((part) => part.type === "command")).toBe(true)
    expect(queued.run.usage?.inputTokens).toBe(3)
    expect(queued.run.usage?.outputTokens).toBe(4)
    expect(queued.run.replyMessageId).not.toBeNull()
    const tokenPath = join(value.runtime.kernel.paths.runDir, "mcp-tokens", value.thread.id)
    expect(readFileSync(tokenPath, "utf8").trim()).toMatch(/^[0-9a-f]{64}$/)
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600)
  } finally {
    await closeFixture(value)
  }
})

test.serial("the store/runtime integration publishes coalesced deltas once in order", async () => {
  const value = await fixture({
    scenario: {
      events: [
        { type: "delta", delta: "a" },
        { type: "delta", delta: "b" },
        { type: "delta", delta: "c" },
        { type: "complete" },
      ],
    },
  })
  let unsubscribe: (() => void) | null = null
  try {
    await initStore(value.runtime.kernel)
    const store = value.runtime.kernel.services.use("store.api")
    if (!store) throw new Error("store service was not initialized")
    const deltas: Array<string> = []
    unsubscribe = value.runtime.kernel.subscribe((envelope) => {
      if (envelope.event.type === "message.delta") deltas.push(envelope.event.delta)
    })
    const request = addUser(store, value.thread, "stream through the real store")
    const queued = value.engine.enqueue({ threadId: value.thread.id, requestMessageId: request.id, trigger: "user" })
    if (!queued.success) throw new Error(queued.error)
    await waitFor(() => terminal(queued.run.status))
    expect(queued.run.status).toBe("succeeded")
    expect(deltas.join("")).toBe("abc")
    expect(deltas.length).toBeLessThanOrEqual(3)
    expect(store.activePath({ threadId: value.thread.id }).find((message) => message.role === "assistant")?.text).toBe(
      "abc",
    )
  } finally {
    unsubscribe?.()
    await closeFixture(value)
  }
})

test.serial("tool publications persist only changed parts and preserve completed output references", async () => {
  const output = "resultado ".repeat(2000)
  const prose = "prosa ".repeat(4000)
  const value = await fixture({
    scenario: {
      events: [
        { type: "delta", delta: prose },
        { type: "command", callId: "first", command: "echo ok", output: "ok" },
        { type: "command", callId: "second", command: "cat result.txt", output },
        { type: "command", callId: "second", command: "cat result.txt", output: "" },
        { type: "delta", delta: "Pronto." },
        { type: "complete" },
      ],
    },
  })
  try {
    await initStore(value.runtime.kernel)
    const store = value.runtime.kernel.services.use("store.api")
    if (!store?.appendParts) throw new Error("Compact store API missing")
    const patches: Array<Parameters<NonNullable<StoreApi["appendParts"]>>[0]> = []
    const updates: Array<Parameters<StoreApi["updateMessage"]>[0]> = []
    const append = store.appendParts
    const update = store.updateMessage
    store.appendParts = (args) => {
      append(args)
      patches.push(structuredClone(args))
    }
    store.updateMessage = (args) => {
      updates.push(structuredClone(args))
      return update(args)
    }
    const events: import("@touri/contracts").UiEvent[] = []
    const unsubscribe = value.runtime.kernel.subscribe(({ event }) => events.push(event))
    try {
      const queued = value.engine.enqueue({
        threadId: value.thread.id,
        requestMessageId: addUser(store, value.thread, "Confira os resultados.").id,
        trigger: "user",
      })
      if (!queued.success) throw new Error(queued.error)
      await waitFor(() => terminal(queued.run.status))
      expect(queued.run.status).toBe("succeeded")
      expect(
        patches.map((patch) => patch.parts.map(({ part }) => ("callId" in part ? part.callId : part.type))),
      ).toEqual([["first"], ["second"], ["second"]])
      expect(JSON.stringify(patches)).not.toContain(prose)
      expect(JSON.stringify(patches)).not.toContain(output)
      const completed = patches[1]?.parts[0]?.part
      expect(completed).toMatchObject({ outputBytes: Buffer.byteLength(output), outputTail: "" })
      expect(patches[2]?.parts[0]?.part).toMatchObject(completed ?? {})
      expect(updates).toHaveLength(1)
      expect(updates[0]?.patch.status).toBe("complete")
      const reply = store.activePath({ threadId: value.thread.id }).find((row) => row.id === queued.run.replyMessageId)
      expect(reply?.parts.find((part) => "callId" in part && part.callId === "second")).toMatchObject(completed ?? {})
      expect(reply?.text).toBe(`${prose}\n\nPronto.`)
      expect(
        events.filter((event) => event.type === "message.created" && event.message.role === "assistant"),
      ).toHaveLength(1)
      expect(
        events.filter((event) => event.type === "message.updated" && event.message.role === "assistant"),
      ).toHaveLength(1)
    } finally {
      unsubscribe()
    }
  } finally {
    await closeFixture(value)
  }
})

test.serial("crash classifies, retains partial output, carries over, and clears on the next turn", async () => {
  const value = await fixture({ scenario: { crashAt: 2, deltas: ["partial ", "lost"] } })
  try {
    const request = addUser(value.store, value.thread, "first request")
    const first = value.engine.enqueue({ threadId: value.thread.id, requestMessageId: request.id, trigger: "user" })
    if (!first.success) throw new Error(first.error)
    await waitFor(() => terminal(first.run.status))
    expect(first.run.status).toBe("failed")
    expect(first.run.errorClass).toBe("cli_crash")
    expect([...value.store.messages.values()].find((message) => message.role === "assistant")?.text).toBe("partial ")
    expect(value.thread.carryoverNote).toContain("previous turn ended with cli_crash")
    writeFileSync(
      value.scenario,
      JSON.stringify({ deltas: ["recovered"], events: [{ type: "delta", delta: "recovered" }, { type: "complete" }] }),
    )
    const secondRequest = addUser(value.store, value.thread, "second request")
    const second = value.engine.enqueue({
      threadId: value.thread.id,
      requestMessageId: secondRequest.id,
      trigger: "user",
    })
    if (!second.success) throw new Error(second.error)
    await waitFor(() => terminal(second.run.status))
    expect(second.run.status).toBe("succeeded")
    expect(value.thread.carryoverNote).toBeNull()
  } finally {
    await closeFixture(value)
  }
})

test.serial("auth and missing executable errors are classified without spawning a missing CLI", async () => {
  const value = await fixture({ scenario: { authError: true } })
  try {
    const request = addUser(value.store, value.thread, "auth")
    const run = value.engine.enqueue({ threadId: value.thread.id, requestMessageId: request.id, trigger: "user" })
    if (!run.success) throw new Error(run.error)
    await waitFor(() => terminal(run.run.status))
    expect(run.run.errorClass).toBe("cli_auth")
    const missing = createCodexAdapter({ kernel: value.runtime.kernel, command: join(value.root, "missing-cli") })
    const detected = await missing.detect()
    expect(detected).toMatchObject({ success: false, errorCode: "cli_missing" })
  } finally {
    await closeFixture(value)
  }
})

test.serial("slow turns receive provider interrupt and become canceled", async () => {
  const value = await fixture({ scenario: { slowMs: 100, deltas: ["a", "b", "c", "d", "e"] } })
  try {
    const request = addUser(value.store, value.thread, "cancel")
    const run = value.engine.enqueue({ threadId: value.thread.id, requestMessageId: request.id, trigger: "user" })
    if (!run.success) throw new Error(run.error)
    await waitFor(() => run.run.status === "running")
    value.engine.cancel(run.run.id)
    await waitFor(() => terminal(run.run.status), 2_000)
    expect(run.run.status).toBe("canceled")
    expect(run.run.errorClass).toBe("canceled")
    expect(
      value.store.activePath({ threadId: value.thread.id }).find((message) => message.runId === run.run.id)?.parts,
    ).toContainEqual({ type: "notice", code: "run_canceled", level: "info", text: "Cancelado por você" })
  } finally {
    await closeFixture(value)
  }
})

test.serial("draining finishes active turns, keeps queued turns for restart and yields to timers", async () => {
  const value = await fixture({
    maxConcurrentRuns: 1,
    scenario: { slowMs: 100, deltas: ["active reply"] },
  })
  try {
    const activeRequest = addUser(value.store, value.thread, "finish this turn")
    const active = value.engine.enqueue({
      threadId: value.thread.id,
      requestMessageId: activeRequest.id,
      trigger: "user",
    })
    const queuedRequest = addUser(value.store, value.thread, "keep this turn queued")
    const queued = value.engine.enqueue({
      threadId: value.thread.id,
      requestMessageId: queuedRequest.id,
      trigger: "user",
    })
    if (!active.success || !queued.success) throw new Error("Unable to queue fixture turns")
    await waitFor(() => active.run.status === "running")

    value.engine.beginDrain()
    let timerFired = false
    setTimeout(() => {
      timerFired = true
    }, 0)
    const rejected = value.engine.enqueue({
      threadId: value.thread.id,
      requestMessageId: queuedRequest.id,
      trigger: "user",
    })
    const drain = value.engine.waitForDrain()
    await waitFor(() => timerFired, 100)
    await drain

    expect(active.run.status).toBe("succeeded")
    expect(queued.run.status).toBe("queued")
    expect(rejected).toMatchObject({ success: false, errorCode: "RUNTIME_DRAINING" })
  } finally {
    await closeFixture(value)
  }
})

test.serial("a provider that ignores interrupt is killed after the cancellation grace period", async () => {
  const value = await fixture({
    scenario: { ignoreInterrupt: true, slowMs: 100, deltas: ["a", "b", "c"] },
    interruptGraceMs: 25,
  })
  try {
    const request = addUser(value.store, value.thread, "force kill")
    const run = value.engine.enqueue({ threadId: value.thread.id, requestMessageId: request.id, trigger: "user" })
    if (!run.success) throw new Error(run.error)
    await waitFor(() => run.run.status === "running")
    value.engine.cancel(run.run.id)
    await waitFor(() => terminal(run.run.status), 2_000)
    expect(run.run.status).toBe("canceled")
  } finally {
    await closeFixture(value)
  }
})

test.each(["codex", "claude"] as const)(
  "%s cancellation interrupts first and preserves history within the default two-second grace period",
  async (provider) => {
    const value = await fixture({ provider })
    const requestLogPath = join(value.assets, "requests.jsonl")
    const signalLogPath = join(value.assets, "signal.log")
    writeFileSync(
      value.scenario,
      JSON.stringify({
        ignoreInterrupt: true,
        slowMs: 30_000,
        deltas: ["partial reply", "still working"],
        requestLogPath,
        signalLogPath,
      }),
    )
    try {
      const request = addUser(value.store, value.thread, "stop a busy provider")
      const result = value.engine.enqueue({ threadId: value.thread.id, requestMessageId: request.id, trigger: "user" })
      if (!result.success) throw new Error(result.error)
      const run = result.run
      await waitFor(() =>
        value.store.activePath({ threadId: value.thread.id }).some((message) => message.text === "partial reply"),
      )
      const started = performance.now()
      value.engine.cancel(run.id)
      await waitFor(() => terminal(run.status), 2_500)
      expect(performance.now() - started).toBeLessThan(2_500)
      expect(run).toMatchObject({ status: "canceled", errorClass: "canceled" })
      const history = value.store.activePath({ threadId: value.thread.id })
      expect(history).toContainEqual(expect.objectContaining({ id: request.id, text: request.text }))
      expect(history.find((message) => message.runId === run.id)).toMatchObject({
        status: "canceled",
        text: "partial reply",
        parts: expect.arrayContaining([
          { type: "notice", code: "run_canceled", level: "info", text: "Cancelado por você" },
        ]),
      })
      if (provider === "codex") {
        const requests = readFileSync(requestLogPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
        expect(requests.find((request) => request.method === "turn/interrupt")).toMatchObject({
          id: expect.any(Number),
          params: { threadId: "fake-codex-session", turnId: "fake-turn-1" },
        })
      } else expect(readFileSync(signalLogPath, "utf8")).toBe("SIGINT")
    } finally {
      await closeFixture(value)
    }
  },
)

test.each(["interrupt", "completion"] as const)(
  "cancellation kills a tool holding stderr open after provider %s and releases the queue",
  async (exit) => {
    const value = await fixture({ interruptGraceMs: 100 })
    let providerExited = false
    const spawn = value.runtime.kernel.spawnTree
    value.runtime.kernel.spawnTree = (args) => {
      const child = spawn(args)
      if (child.success && args.args.includes("app-server"))
        void child.exited.then(() => {
          providerExited = true
        })
      return child
    }
    const toolPidPath = join(value.assets, "tool.pid")
    writeFileSync(
      value.scenario,
      JSON.stringify({
        exitOnInterrupt: true,
        toolPidPath,
        slowMs: exit === "completion" ? 0 : 30_000,
        deltas: ["partial reply"],
      }),
    )
    let toolPid: number | undefined
    try {
      const result = value.engine.enqueue({
        threadId: value.thread.id,
        requestMessageId: addUser(value.store, value.thread, "start a tool").id,
        trigger: "user",
      })
      if (!result.success) throw new Error(result.error)
      await waitFor(() => existsSync(toolPidPath))
      const pid = Number(readFileSync(toolPidPath, "utf8"))
      toolPid = pid
      if (exit === "completion") await waitFor(() => providerExited)
      value.engine.cancel(result.run.id)
      writeFileSync(value.scenario, JSON.stringify({ deltas: ["next reply"] }))
      const next = value.engine.enqueue({
        threadId: value.thread.id,
        requestMessageId: addUser(value.store, value.thread, "next task").id,
        trigger: "user",
      })
      if (!next.success) throw new Error(next.error)
      expect(next.run.status).toBe("queued")
      await waitFor(() => terminal(result.run.status), 500)
      expect(result.run.status).toBe("canceled")
      await waitFor(() => terminal(next.run.status), 2_000)
      expect(next.run.status).toBe("succeeded")
      if (process.platform === "linux") {
        const path = `/proc/${pid}/stat`
        const stat = existsSync(path) ? readFileSync(path, "utf8") : null
        expect(stat === null || /^[ZX]/.test(stat.slice(stat.lastIndexOf(")") + 2))).toBe(true)
      } else expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      if (toolPid) {
        try {
          process.kill(toolPid, "SIGKILL")
        } catch {}
      }
      await closeFixture(value)
    }
  },
)

test.serial("Codex approval requests create a pending ApprovalPart and receive the decision", async () => {
  const value = await fixture({
    scenario: { waitForApproval: true, events: [{ type: "approval", approvalId: "approval-fixture" }] },
  })
  try {
    const request = addUser(value.store, value.thread, "approve this")
    const run = value.engine.enqueue({ threadId: value.thread.id, requestMessageId: request.id, trigger: "user" })
    if (!run.success) throw new Error(run.error)
    await waitFor(() =>
      [...value.store.messages.values()].some((message) =>
        message.parts.some((part) => part.type === "approval" && part.decision === "pending"),
      ),
    )
    const approvalMessage = [...value.store.messages.values()].find((message) =>
      message.parts.some((part) => part.type === "approval" && part.decision === "pending"),
    )
    const approval = approvalMessage?.parts.find(
      (part): part is Extract<import("@touri/contracts").MessagePart, { type: "approval" }> => part.type === "approval",
    )
    expect(approval?.approvalId).toBeString()
    expect(approval?.approvalId).not.toBe("approval-fixture")
    if (!approval) return
    expect((await value.engine.answerApproval({ approvalId: approval.approvalId, decision: "approved" })).success).toBe(
      true,
    )
    await waitFor(() => terminal(run.run.status))
    expect(run.run.status).toBe("succeeded")
  } finally {
    await closeFixture(value)
  }
})

test.serial("B06 concurrent runs keep reused provider approvals isolated and stale cards cannot answer", async () => {
  const f = await fixture({
    interruptGraceMs: 100,
    scenario: { waitForApproval: true, events: [{ type: "approval", approvalId: "reused-provider-id" }] },
  })
  try {
    const other: Thread = { ...f.thread, id: "thread-second", activeLeafId: null }
    f.store.threads.set(other.id, other)
    ;(f.runtime.kernel.db as Database)
      .query("INSERT INTO threads(id,bot_id,kind,title,created_at,updated_at) VALUES (?,?,'chat','second',1,1)")
      .run(other.id, f.bot.id)
    const first = f.engine.enqueue({
      threadId: f.thread.id,
      requestMessageId: addUser(f.store, f.thread, "first").id,
      trigger: "user",
    })
    const second = f.engine.enqueue({
      threadId: other.id,
      requestMessageId: addUser(f.store, other, "second").id,
      trigger: "user",
    })
    if (!first.success || !second.success) throw new Error("Missing runs")
    const card = (threadId: string) =>
      [...f.store.messages.values()]
        .filter((message) => message.threadId === threadId)
        .flatMap((message) => message.parts)
        .find((part) => part.type === "approval" && part.decision === "pending")
    await waitFor(() => !!card(f.thread.id) && !!card(other.id))
    const a = card(f.thread.id)
    const b = card(other.id)
    if (a?.type !== "approval" || b?.type !== "approval") throw new Error("Missing cards")
    expect(a.approvalId === b.approvalId).toBe(false)
    expect((await f.engine.answerApproval({ approvalId: a.approvalId, decision: "approved" })).success).toBe(true)
    await waitFor(() => terminal(first.run.status))
    expect(second.run.status).toBe("running")
    expect((await f.engine.answerApproval({ approvalId: a.approvalId, decision: "approved" })).success).toBe(false)
    f.engine.cancel(second.run.id)
    expect((await f.engine.answerApproval({ approvalId: b.approvalId, decision: "approved" })).success).toBe(false)
    await waitFor(() => terminal(second.run.status))
  } finally {
    await closeFixture(f)
  }
})

test.serial("B07 late registered text and reasoning credentials are redacted before store deltas", async () => {
  const secret = "synthetic-durable-stream-credential"
  const f = await fixture({
    scenario: {
      slowMs: 50,
      events: [
        { type: "delta", delta: "ready " },
        { type: "sleep" },
        { type: "delta", delta: secret.slice(0, 14) },
        { type: "delta", delta: secret.slice(14) },
        { method: "item/reasoning/summaryTextDelta", params: { itemId: "reason", delta: secret.slice(0, 14) } },
        { method: "item/reasoning/summaryTextDelta", params: { itemId: "reason", delta: secret.slice(14) } },
        { type: "complete" },
      ],
    },
  })
  const persisted: string[] = []
  const append = f.store.appendDelta
  f.store.appendDelta = (args) => {
    persisted.push(args.delta)
    append(args)
  }
  try {
    const started = f.engine.enqueue({
      threadId: f.thread.id,
      requestMessageId: addUser(f.store, f.thread, "redaction").id,
      trigger: "user",
    })
    if (!started.success) throw new Error("Missing run")
    await waitFor(() => persisted.join("").includes("ready"))
    f.runtime.kernel.addRedactionValue(secret)
    await waitFor(() => terminal(started.run.status))
    expect(persisted.join("").includes(secret)).toBe(false)
    expect(persisted.join("").includes(secret.slice(0, 14))).toBe(false)
    const reply = f.store.messages.get(started.run.replyMessageId ?? "")
    expect(JSON.stringify(reply).includes(secret)).toBe(false)
    expect(
      reply?.parts
        .filter((part) => part.type === "reasoning")
        .map((part) => part.text)
        .join(""),
    ).toBe("[REDACTED]")
  } finally {
    await closeFixture(f)
  }
})

test.serial(
  "resumes the stored native session and replaces it with a bounded handoff when the fingerprint changes",
  async () => {
    const value = await fixture({ scenario: { logPath: "PLACEHOLDER", deltas: ["ok"] } })
    try {
      writeFileSync(
        value.scenario,
        JSON.stringify({
          logPath: value.logPath,
          deltas: ["ok"],
          events: [{ type: "delta", delta: "ok" }, { type: "complete" }],
        }),
      )
      const firstRequest = addUser(value.store, value.thread, "first")
      const first = value.engine.enqueue({
        threadId: value.thread.id,
        requestMessageId: firstRequest.id,
        trigger: "user",
      })
      if (!first.success) throw new Error(first.error)
      await waitFor(() => terminal(first.run.status))
      const secondRequest = addUser(value.store, value.thread, "second")
      const second = value.engine.enqueue({
        threadId: value.thread.id,
        requestMessageId: secondRequest.id,
        trigger: "user",
      })
      if (!second.success) throw new Error(second.error)
      await waitFor(() => terminal(second.run.status))
      const log = readFileSync(value.logPath, "utf8")
      expect(log).toContain("thread/resume")
      const updatedBot = value.store.bots.get(value.bot.id)
      if (!updatedBot) throw new Error("Fixture bot missing")
      updatedBot.access = "full"
      const thirdRequest = addUser(value.store, value.thread, "third")
      const third = value.engine.enqueue({
        threadId: value.thread.id,
        requestMessageId: thirdRequest.id,
        trigger: "user",
      })
      if (!third.success) throw new Error(third.error)
      await waitFor(() => terminal(third.run.status))
      expect(third.run.status).toBe("succeeded")
      expect(
        [...value.store.messages.values()].some((message) =>
          message.parts.some((part) => part.type === "notice" && part.code === "session_replaced"),
        ),
      ).toBe(true)
      const packetLength = [...value.store.messages.values()]
        .filter((message) => message.role === "system")
        .map((message) => message.text.length)
        .reduce((sum, length) => sum + length, 0)
      expect(packetLength).toBeLessThanOrEqual(32_000)
    } finally {
      await closeFixture(value)
    }
  },
)

test.serial("Claude stream-json adapter completes a fake turn", async () => {
  const value = await fixture({
    provider: "claude",
    scenario: { events: [{ type: "delta", delta: "claude reply" }, { type: "complete" }] },
  })
  try {
    const request = addUser(value.store, value.thread, "claude turn")
    const run = value.engine.enqueue({ threadId: value.thread.id, requestMessageId: request.id, trigger: "user" })
    if (!run.success) throw new Error(run.error)
    await waitFor(() => terminal(run.run.status))
    expect(run.run.status).toBe("succeeded")
    expect([...value.store.messages.values()].find((message) => message.role === "assistant")?.text).toBe(
      "claude reply",
    )
  } finally {
    await closeFixture(value)
  }
})

test.serial("Claude permission frames share approval cards and standing grants across turns", async () => {
  const value = await fixture({ provider: "claude" })
  const marker = join(value.assets, "permission-executed")
  const outcome = join(value.assets, "permission-outcome")
  writeFileSync(
    value.scenario,
    JSON.stringify({ permissionCommand: "save fixture", executionMarker: marker, permissionOutcome: outcome }),
  )
  const pendingApproval = () =>
    [...value.store.messages.values()]
      .flatMap((message) => message.parts)
      .find((part) => part.type === "approval" && part.decision === "pending")
  try {
    for (const standing of [false, true]) {
      const request = addUser(value.store, value.thread, "salvar")
      const run = value.engine.enqueue({ threadId: value.thread.id, requestMessageId: request.id, trigger: "user" })
      if (!run.success) throw new Error(run.error)
      await waitFor(() => !!pendingApproval())
      const card = pendingApproval()
      if (card?.type !== "approval") throw new Error("Missing permission card")
      expect(card.scope).toMatchObject({ source: "claude", tool: "Bash", destination: expect.any(String) })
      expect(card.allowStanding).toBe(true)
      if (!standing) expect(() => readFileSync(marker)).toThrow()
      expect(
        (await value.engine.answerApproval({ approvalId: card.approvalId, decision: "approved", standing })).success,
      ).toBe(true)
      await waitFor(() => terminal(run.run.status))
      expect(run.run.status).toBe("succeeded")
      expect(readFileSync(marker, "utf8")).toBe("save fixture")
      expect(readFileSync(outcome, "utf8")).toBe(
        standing ? "Aprovado: sempre para esta ferramenta neste bot." : "Aprovado pelo usuário (uma vez).",
      )
      expect(createStandingGrantStore(value.runtime.kernel).list(value.bot.id)).toHaveLength(standing ? 1 : 0)
    }
    const request = addUser(value.store, value.thread, "salvar novamente")
    const run = value.engine.enqueue({ threadId: value.thread.id, requestMessageId: request.id, trigger: "user" })
    if (!run.success) throw new Error(run.error)
    await waitFor(() => terminal(run.run.status))
    expect(run.run.status).toBe("succeeded")
    expect(pendingApproval()).toBeUndefined()
    expect(readFileSync(outcome, "utf8")).toBe(
      "Aprovado automaticamente pela permissão permanente desta ferramenta neste bot.",
    )
    expect(
      [...value.store.messages.values()].flatMap((message) => message.parts).filter((part) => part.type === "approval"),
    ).toHaveLength(2)
  } finally {
    await closeFixture(value)
  }
})

for (const canceled of [false, true]) {
  test.serial(
    `run ${canceled ? "cancellation" : "completion"} settles egress cards before publishing the final message`,
    async () => {
      const value = await fixture({
        scenario: { slowMs: 150, events: [{ type: "delta", delta: "parcial" }, { type: "complete" }] },
        interruptGraceMs: 30,
      })
      try {
        const request = addUser(value.store, value.thread, "iniciar")
        const run = value.engine.enqueue({ threadId: value.thread.id, requestMessageId: request.id, trigger: "user" })
        if (!run.success) throw new Error(run.error)
        await waitFor(() => run.run.status === "running")
        const decision = value.engine.approvalBridge.present({
          ctx: {
            botId: value.bot.id,
            threadId: value.thread.id,
            runId: run.run.id,
            signal: new AbortController().signal,
          },
          scope: { source: "mcp", server: "fixture", tool: "save" },
          toolName: "Salvar",
          input: {},
        })
        const card = [...value.store.messages.values()]
          .flatMap((message) => message.parts)
          .find((part) => part.type === "approval" && part.decision === "pending")
        if (card?.type !== "approval") throw new Error("Missing egress card")
        if (canceled) value.engine.cancel(run.run.id)
        expect(await decision).toMatchObject({ success: true, behavior: "deny" })
        await waitFor(() => terminal(run.run.status))
        const reply = value.store.messages.get(run.run.replyMessageId ?? "")
        expect(reply?.status).toBe(canceled ? "canceled" : "complete")
        expect(reply?.parts.find((part) => part.type === "approval")).toMatchObject({ decision: "denied" })
        expect(
          (await value.engine.answerApproval({ approvalId: card.approvalId, decision: "approved", standing: true }))
            .success,
        ).toBe(false)
        expect(createStandingGrantStore(value.runtime.kernel).list(value.bot.id)).toEqual([])
      } finally {
        await closeFixture(value)
      }
    },
  )
}

test.serial("a four-run queue respects the cap and serializes two turns on one thread", async () => {
  const value = await fixture({ scenario: { slowMs: 20, deltas: ["a", "b", "c"] }, maxConcurrentRuns: 3 })
  try {
    const requests = [addUser(value.store, value.thread, "one")]
    const secondMessage = addUser(value.store, value.thread, "two")
    const extra: Array<ReturnType<typeof addUser>> = []
    for (let index = 0; index < 3; index += 1) {
      const threadId = `thread-extra-${index}`
      const thread: Thread = { ...value.thread, id: threadId, title: `Extra ${index}`, activeLeafId: null }
      value.store.threads.set(threadId, thread)
      ;(value.runtime.kernel.db as Database)
        .query(
          `INSERT INTO threads (id, bot_id, kind, title, active_leaf_id, unread, usage_json, source, created_at, updated_at) VALUES (?, ?, 'chat', ?, NULL, 0, '{}', 'local', ?, ?)`,
        )
        .run(threadId, value.bot.id, thread.title, Date.now(), Date.now())
      extra.push(addUser(value.store, thread, `extra ${index}`))
    }
    const first = value.engine.enqueue({
      threadId: value.thread.id,
      requestMessageId: requests[0]?.id ?? "missing-request",
      trigger: "user",
    })
    if (!first.success) throw new Error(first.error)
    const second = value.engine.enqueue({
      threadId: value.thread.id,
      requestMessageId: secondMessage.id,
      trigger: "user",
    })
    if (!second.success) throw new Error(second.error)
    const extras = extra.map((message) =>
      value.engine.enqueue({ threadId: message.threadId, requestMessageId: message.id, trigger: "user" }),
    )
    // Observe the queue before yielding: a short fake turn may finish while another CLI starts.
    expect(second.run.status).toBe("queued")
    expect(extras.filter((result) => result.success && result.run.status === "queued").length).toBeGreaterThan(0)
    await waitFor(() => terminal(first.run.status) && terminal(second.run.status), 8_000)
  } finally {
    await closeFixture(value)
  }
})

for (const rolloutPath of ["/fixture/rollout.jsonl", null]) {
  test.serial(
    `a Codex session that cannot resume falls back to a fresh handoff (rollout: ${rolloutPath})`,
    async () => {
      const value = await fixture({
        scenario: {
          badResume: true,
          rolloutPath,
          events: [{ type: "delta", delta: "fallback" }, { type: "complete" }],
        },
      })
      try {
        ;(value.runtime.kernel.db as Database)
          .query(
            "INSERT INTO provider_sessions (id, thread_id, provider, external_session_id, rollout_path, fingerprint, state, model, created_at, last_used_at) VALUES ('imported-session', ?, 'codex', 'imported-external', ?, 'imported', 'active', NULL, ?, ?)",
          )
          .run(value.thread.id, rolloutPath, Date.now(), Date.now())
        const request = addUser(value.store, value.thread, "continue imported")
        const run = value.engine.enqueue({ threadId: value.thread.id, requestMessageId: request.id, trigger: "user" })
        if (!run.success) throw new Error(run.error)
        await waitFor(() => terminal(run.run.status))
        expect(run.run.status).toBe("succeeded")
        expect(
          (value.runtime.kernel.db as Database)
            .query("SELECT state FROM provider_sessions WHERE id = 'imported-session'")
            .get(),
        ).toEqual({ state: "failed" })
      } finally {
        await closeFixture(value)
      }
    },
  )
}

test.serial(
  "routine creation is disabled for agents, scheduler slots are unique, overlap skips, and stale catch-up is skipped",
  async () => {
    const value = await fixture({
      scenario: { slowMs: 100, events: [{ type: "delta", delta: "routine result" }, { type: "complete" }] },
    })
    const secondEngine = createRuntimeEngine({
      kernel: value.runtime.kernel,
      codexCommand: value.fakePath,
      environment: {
        PATH: process.env.PATH ?? "/usr/bin",
        SHELL: process.env.SHELL ?? "/bin/zsh",
        TOURI_FAKE_SCENARIO: value.scenario,
      },
      maxConcurrentRuns: 3,
    })
    try {
      const input = {
        botId: value.bot.id,
        name: "Fixture routine",
        prompt: "check fixture",
        cron: "*/5 * * * *",
        timezone: "America/Sao_Paulo",
        enabled: true,
        continuity: "main-thread" as const,
        resultsThreadId: null,
        groupId: null,
        timeoutMinutes: 30,
        overlap: "skip" as const,
        catchUpMinutes: 30,
      }
      const disabled = value.engine.createRoutine({ input, forceDisabled: true })
      if (!disabled.success) throw new Error(disabled.error)
      expect(disabled.routine.enabled).toBe(false)
      expect(
        value.engine.updateRoutine({
          routineId: disabled.routine.id,
          patch: { enabled: true },
          fromTool: true,
          botId: value.bot.id,
        }),
      ).toMatchObject({ success: false, errorCode: "INVALID_ARGS" })
      const enabled = value.engine.createRoutine({
        input: { ...input, name: "Scheduled routine" },
        forceDisabled: false,
      })
      if (!enabled.success) throw new Error(enabled.error)
      const at = Date.UTC(2026, 9, 12, 14, 0)
      value.engine.updateRoutine({ routineId: enabled.routine.id, patch: { nextRunAt: at }, fromTool: false })
      await Promise.all([value.engine.tick(at), secondEngine.tick(at)])
      const db = value.runtime.kernel.db as Database
      await waitFor(
        () =>
          Number(
            (
              db.query("SELECT count(*) AS count FROM routine_runs WHERE routine_id = ?").get(enabled.routine.id) as {
                count: number
              }
            ).count,
          ) >= 1,
      )
      expect(
        Number(
          (
            db.query("SELECT count(*) AS count FROM routine_runs WHERE routine_id = ?").get(enabled.routine.id) as {
              count: number
            }
          ).count,
        ),
      ).toBe(1)
      const overlap = value.engine.runRoutine({
        routineId: enabled.routine.id,
        triggerSource: "manual",
        scheduledFor: at + 60_000,
      })
      if (!overlap.success) throw new Error(overlap.error)
      const skipped = value.engine.runRoutine({
        routineId: enabled.routine.id,
        triggerSource: "manual",
        scheduledFor: at + 120_000,
      })
      expect(skipped.success).toBe(true)
      if (skipped.success) expect(skipped.routineRun.status).toBe("skipped")
      const stale = value.engine.updateRoutine({
        routineId: enabled.routine.id,
        patch: { nextRunAt: at - 60 * 60_000 },
        fromTool: false,
      })
      if (!stale.success) throw new Error(stale.error)
      await value.engine.tick(at)
      expect(
        Number(
          (
            db
              .query("SELECT count(*) AS count FROM routine_runs WHERE routine_id = ? AND status = 'skipped'")
              .get(enabled.routine.id) as { count: number }
          ).count,
        ),
      ).toBeGreaterThan(0)
    } finally {
      await secondEngine.shutdown()
      await closeFixture(value)
    }
  },
)

test.serial("routine updates reject a caller from another bot", async () => {
  const value = await fixture()
  try {
    const created = value.engine.createRoutine({
      input: {
        botId: value.bot.id,
        name: "Owned routine",
        prompt: "owned prompt",
        cron: "*/5 * * * *",
        timezone: "America/Sao_Paulo",
        enabled: false,
        continuity: "new-thread",
        resultsThreadId: null,
        groupId: null,
        timeoutMinutes: 30,
        overlap: "skip",
        catchUpMinutes: 30,
      },
      forceDisabled: true,
    })
    if (!created.success) throw new Error(created.error)
    const crossBot = value.engine.updateRoutine({
      routineId: created.routine.id,
      patch: { name: "hijacked" },
      fromTool: true,
      botId: "another-bot",
    })
    expect(crossBot).toMatchObject({ success: false, errorCode: "NOT_OWNED" })
    expect(value.engine.listRoutines(value.bot.id).find((routine) => routine.id === created.routine.id)?.name).toBe(
      "Owned routine",
    )
    const ownerUpdate = value.engine.updateRoutine({
      routineId: created.routine.id,
      patch: { name: "renamed by owner" },
      fromTool: true,
      botId: value.bot.id,
    })
    expect(ownerUpdate).toMatchObject({ success: true, routine: { name: "renamed by owner" } })
  } finally {
    await closeFixture(value)
  }
})

test.serial("routine timeout fails both the turn and routine run with a bounded summary", async () => {
  const value = await fixture({
    scenario: { slowMs: 50, events: [{ type: "delta", delta: "partial result" }, { type: "complete" }] },
    interruptGraceMs: 25,
    routineTimeoutMs: 20,
  })
  try {
    const created = value.engine.createRoutine({
      input: {
        botId: value.bot.id,
        name: "Timeout routine",
        prompt: "take too long",
        cron: "*/5 * * * *",
        timezone: "America/Sao_Paulo",
        enabled: false,
        continuity: "main-thread",
        resultsThreadId: null,
        groupId: null,
        timeoutMinutes: 1,
        overlap: "skip",
        catchUpMinutes: 30,
      },
      forceDisabled: true,
    })
    if (!created.success) throw new Error(created.error)
    const started = value.engine.runRoutine({
      routineId: created.routine.id,
      triggerSource: "manual",
      scheduledFor: Date.now(),
    })
    if (!started.success) throw new Error(started.error)
    const database = value.runtime.kernel.db as Database
    await waitFor(() => {
      const row = database
        .query("SELECT status, finished_at FROM routine_runs WHERE id = ?")
        .get(started.routineRun.id) as {
        status: string
        finished_at: number | null
      } | null
      return row?.status === "failed" && row.finished_at !== null
    })
    expect(database.query("SELECT status, error_class FROM runs WHERE id = ?").get(started.routineRun.runId)).toEqual({
      status: "failed",
      error_class: "timeout",
    })
    const routineRun = database
      .query("SELECT status, summary, finished_at FROM routine_runs WHERE id = ?")
      .get(started.routineRun.id) as { status: string; summary: string | null; finished_at: number | null }
    expect(routineRun.status).toBe("failed")
    expect(routineRun.finished_at).not.toBeNull()
    expect(routineRun.summary).toBeTruthy()
    expect(routineRun.summary?.length ?? 0).toBeLessThanOrEqual(500)
  } finally {
    await closeFixture(value)
  }
})

test.serial("scheduled results-thread routines keep the same thread across slots", async () => {
  const value = await fixture({ scenario: { events: [{ type: "delta", delta: "result" }, { type: "complete" }] } })
  try {
    await initStore(value.runtime.kernel)
    const created = value.engine.createRoutine({
      input: {
        botId: value.bot.id,
        name: "Results routine",
        prompt: "append result",
        cron: "*/5 * * * *",
        timezone: "America/Sao_Paulo",
        enabled: true,
        continuity: "results-thread",
        resultsThreadId: null,
        groupId: null,
        timeoutMinutes: 30,
        overlap: "skip",
        catchUpMinutes: 30,
      },
      forceDisabled: false,
    })
    if (!created.success) throw new Error(created.error)
    const firstSlot = Date.UTC(2026, 9, 12, 14, 0)
    const prepared = value.engine.updateRoutine({
      routineId: created.routine.id,
      patch: { nextRunAt: firstSlot },
      fromTool: false,
    })
    if (!prepared.success) throw new Error(prepared.error)
    const database = value.runtime.kernel.db as Database
    await value.engine.tick(firstSlot)
    await waitFor(
      () =>
        Number(
          (
            database
              .query("SELECT count(*) AS count FROM routine_runs WHERE routine_id = ?")
              .get(created.routine.id) as { count: number }
          ).count,
        ) === 1,
    )
    await waitFor(() => {
      const row = database.query("SELECT status FROM routine_runs WHERE routine_id = ?").get(created.routine.id) as {
        status: string
      } | null
      return row?.status === "succeeded" || row?.status === "failed"
    })
    const afterFirst = value.engine.listRoutines(value.bot.id).find((routine) => routine.id === created.routine.id)
    expect(afterFirst?.resultsThreadId).not.toBeNull()
    const secondSlot = afterFirst?.nextRunAt
    if (secondSlot === null || secondSlot === undefined) throw new Error("scheduler did not produce a next slot")
    await value.engine.tick(secondSlot)
    await waitFor(
      () =>
        Number(
          (
            database
              .query("SELECT count(*) AS count FROM routine_runs WHERE routine_id = ?")
              .get(created.routine.id) as { count: number }
          ).count,
        ) === 2,
    )
    await waitFor(() => {
      const rows = database
        .query("SELECT status FROM routine_runs WHERE routine_id = ? ORDER BY scheduled_for")
        .all(created.routine.id) as Array<{ status: string }>
      return rows.length === 2 && rows.every((row) => row.status === "succeeded")
    })
    const threads = database
      .query("SELECT thread_id FROM routine_runs WHERE routine_id = ? ORDER BY scheduled_for")
      .all(created.routine.id) as Array<{ thread_id: string | null }>
    expect(threads).toHaveLength(2)
    expect(threads[0]?.thread_id).toBe(threads[1]?.thread_id)
  } finally {
    await closeFixture(value)
  }
})

test.serial("restart interrupts an in-flight routine run and does not block the next slot", async () => {
  const value = await fixture({
    scenario: { events: [{ type: "delta", delta: "after restart" }, { type: "complete" }] },
  })
  let restarted: ReturnType<typeof createRuntimeEngine> | null = null
  try {
    const created = value.engine.createRoutine({
      input: {
        botId: value.bot.id,
        name: "Restart routine",
        prompt: "continue after restart",
        cron: "*/5 * * * *",
        timezone: "America/Sao_Paulo",
        enabled: true,
        continuity: "main-thread",
        resultsThreadId: null,
        groupId: null,
        timeoutMinutes: 30,
        overlap: "skip",
        catchUpMinutes: 30,
      },
      forceDisabled: false,
    })
    if (!created.success) throw new Error(created.error)
    const database = value.runtime.kernel.db as Database
    const oldRunId = "run-restart-fixture"
    const oldRoutineRunId = "routine-run-restart-fixture"
    const startedAt = Date.now()
    database
      .query(
        "INSERT INTO runs (id, thread_id, bot_id, provider, trigger, request_message_id, reply_message_id, status, routine_run_id, queued_at, started_at) VALUES (?, ?, ?, 'codex', 'routine', NULL, NULL, 'running', ?, ?, ?)",
      )
      .run(oldRunId, value.thread.id, value.bot.id, oldRoutineRunId, startedAt, startedAt)
    database
      .query(
        "INSERT INTO routine_runs (id, routine_id, scheduled_for, status, thread_id, run_id, trigger_source, summary, started_at) VALUES (?, ?, ?, 'running', ?, ?, 'cron', NULL, ?)",
      )
      .run(oldRoutineRunId, created.routine.id, startedAt, value.thread.id, oldRunId, startedAt)
    restarted = createRuntimeEngine({
      kernel: value.runtime.kernel,
      codexCommand: value.fakePath,
      environment: {
        PATH: process.env.PATH ?? "/usr/bin",
        SHELL: process.env.SHELL ?? "/bin/zsh",
        TOURI_FAKE_SCENARIO: value.scenario,
      },
    })
    expect(database.query("SELECT status, error_class FROM runs WHERE id = ?").get(oldRunId)).toEqual({
      status: "interrupted",
      error_class: "app_restart",
    })
    const recoveredRoutineRun = database
      .query("SELECT status, finished_at, summary FROM routine_runs WHERE id = ?")
      .get(oldRoutineRunId) as { status: string; finished_at: number | null; summary: string | null }
    expect(recoveredRoutineRun.status).toBe("canceled")
    expect(recoveredRoutineRun.finished_at).not.toBeNull()
    expect(recoveredRoutineRun.summary).toContain("restarted")
    const nextSlot = startedAt + 300_000
    const prepared = restarted.updateRoutine({
      routineId: created.routine.id,
      patch: { nextRunAt: nextSlot },
      fromTool: false,
    })
    if (!prepared.success) throw new Error(prepared.error)
    await restarted.tick(nextSlot)
    await waitFor(
      () =>
        Number(
          (
            database
              .query("SELECT count(*) AS count FROM routine_runs WHERE routine_id = ?")
              .get(created.routine.id) as { count: number }
          ).count,
        ) === 2,
    )
    await waitFor(() => {
      const row = database
        .query("SELECT status FROM routine_runs WHERE routine_id = ? AND scheduled_for = ?")
        .get(created.routine.id, nextSlot) as {
        status: string
      } | null
      return row?.status === "succeeded"
    })
    expect(database.query("SELECT status FROM routine_runs WHERE id = ?").get(oldRoutineRunId)).toMatchObject({
      status: "canceled",
    })
  } finally {
    if (restarted) await restarted.shutdown()
    await closeFixture(value)
  }
})

const notificationKinds = (value: Fixture): Array<string> =>
  (value.runtime.kernel.db as Database)
    .query("SELECT kind FROM notifications ORDER BY id")
    .all()
    .map((row) => (row as { kind: string }).kind)

test.serial("a Codex approval notifies with its request id and the decision resolves it", async () => {
  const value = await fixture({
    scenario: { waitForApproval: true, events: [{ type: "approval", approvalId: "approval-notify" }] },
  })
  try {
    await initNotify(value.runtime.kernel)
    value.runtime.kernel.services.provide("runtime.answerApproval", (args) => value.engine.answerApproval(args))
    const request = addUser(value.store, value.thread, "approve this")
    const run = value.engine.enqueue({ threadId: value.thread.id, requestMessageId: request.id, trigger: "user" })
    if (!run.success) throw new Error(run.error)
    await waitFor(() => notificationKinds(value).includes("approval"))
    const database = value.runtime.kernel.db as Database
    const notification = database.query("SELECT request_id, bot_id, thread_id FROM notifications").get() as {
      request_id: string
      bot_id: string
      thread_id: string
    }
    expect(notification).toEqual({
      request_id: expect.any(String),
      bot_id: value.bot.id,
      thread_id: value.thread.id,
    })
    const response = await fetch(
      `http://127.0.0.1:${(value.runtime.handshake as { port: number }).port}/api/threads/${value.thread.id}/respond`,
      {
        method: "POST",
        headers: { Authorization: "Bearer dev-ui-token", "X-Touri-Client": "test" },
        body: JSON.stringify({ requestId: notification.request_id, behavior: "allow" }),
      },
    )
    expect(response.status).toBe(200)
    await waitFor(() => terminal(run.run.status))
    expect(database.query("SELECT resolution FROM notifications WHERE kind = 'approval'").get()).toEqual({
      resolution: "allow",
    })
    expect(notificationKinds(value)).toContain("done")
  } finally {
    await closeFixture(value)
  }
})

test.serial("a failed turn notifies turn-failed, a canceled turn notifies nothing", async () => {
  const value = await fixture({ scenario: { crashAt: 2, deltas: ["partial ", "lost"] } })
  try {
    await initNotify(value.runtime.kernel)
    // With automatic resume on, a crash is continued instead of reported (resume-interrupted.test.ts).
    ;(value.runtime.kernel.db as Database).exec(
      "INSERT INTO settings (key, value_json, updated_at) VALUES ('resumeInterruptedTurns', 'false', 1)",
    )
    const request = addUser(value.store, value.thread, "fail please")
    const run = value.engine.enqueue({ threadId: value.thread.id, requestMessageId: request.id, trigger: "user" })
    if (!run.success) throw new Error(run.error)
    await waitFor(() => terminal(run.run.status))
    expect(notificationKinds(value)).toEqual(["turn-failed"])
    expect((value.runtime.kernel.db as Database).query("SELECT level, bot_id FROM notifications").get()).toEqual({
      level: "error",
      bot_id: value.bot.id,
    })
  } finally {
    await closeFixture(value)
  }
})

test.serial("a finished turn notifies done with the reply text", async () => {
  const value = await fixture()
  try {
    await initNotify(value.runtime.kernel)
    const request = addUser(value.store, value.thread, "say hi")
    const run = value.engine.enqueue({ threadId: value.thread.id, requestMessageId: request.id, trigger: "user" })
    if (!run.success) throw new Error(run.error)
    await waitFor(() => terminal(run.run.status))
    expect(notificationKinds(value)).toEqual(["done"])
    const row = (value.runtime.kernel.db as Database).query("SELECT body FROM notifications").get() as { body: string }
    expect(row.body).toContain("hello")
  } finally {
    await closeFixture(value)
  }
})

test.serial(
  "a failed routine notifies routine-failed and an overlapping routine run notifies routine-deferred",
  async () => {
    const value = await fixture({
      scenario: { slowMs: 80, events: [{ type: "delta", delta: "partial result" }, { type: "complete" }] },
      interruptGraceMs: 25,
      routineTimeoutMs: 20,
    })
    try {
      await initNotify(value.runtime.kernel)
      const created = value.engine.createRoutine({
        input: {
          botId: value.bot.id,
          name: "Notify routine",
          prompt: "slow",
          cron: "*/5 * * * *",
          timezone: "America/Sao_Paulo",
          enabled: true,
          continuity: "main-thread",
          resultsThreadId: null,
          groupId: null,
          timeoutMinutes: 1,
          overlap: "skip",
          catchUpMinutes: 30,
        },
        forceDisabled: false,
      })
      if (!created.success) throw new Error(created.error)
      const first = value.engine.runRoutine({
        routineId: created.routine.id,
        triggerSource: "manual",
        scheduledFor: Date.now(),
      })
      if (!first.success) throw new Error(first.error)
      const second = value.engine.runRoutine({
        routineId: created.routine.id,
        triggerSource: "cron",
        scheduledFor: Date.now() + 1,
      })
      expect(second.success).toBe(true)
      await waitFor(() => notificationKinds(value).includes("routine-failed"))
      expect(notificationKinds(value)).toContain("routine-deferred")
      expect(second.success && second.routineRun.summary).toBe(
        "Rotina “Notify routine” adiada: a execução anterior ainda está em andamento.",
      )
      expect(
        (value.runtime.kernel.db as Database)
          .query("SELECT title, body FROM notifications WHERE kind = 'routine-deferred'")
          .get(),
      ).toEqual({
        title: "Rotina adiada: Notify routine",
        body: "A rotina “Notify routine” foi adiada porque a execução anterior ainda está em andamento.",
      })
    } finally {
      await closeFixture(value)
    }
  },
)

for (const provider of ["claude", "codex"] as const) {
  test.serial(`r2: ${provider} tools reconcile parameters/results by call ID and redact secrets`, async () => {
    const events =
      provider === "claude"
        ? [
            {
              type: "stream_event",
              event: {
                type: "content_block_start",
                index: 0,
                content_block: { type: "tool_use", id: "bash-r2", name: "Bash", input: {} },
              },
            },
            {
              type: "stream_event",
              event: {
                type: "content_block_delta",
                index: 0,
                delta: { type: "input_json_delta", partial_json: '{"command":"ls src/app","token":"hidden-token"}' },
              },
            },
            { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
            { type: "tool", callId: "bash-r2", name: "Bash", input: { command: "ls src/app", token: "hidden-token" } },
            {
              type: "user",
              message: {
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "bash-r2",
                    content: "23 routes; project secret: private-project-value",
                    is_error: false,
                  },
                ],
              },
            },
            { type: "complete" },
          ]
        : [
            {
              method: "item/started",
              params: {
                item: {
                  type: "mcpToolCall",
                  id: "mcp-r2",
                  tool: "list_routes",
                  arguments: { path: "src/app", token: "hidden-token" },
                  status: "inProgress",
                },
              },
            },
            {
              method: "item/completed",
              params: {
                item: {
                  type: "mcpToolCall",
                  id: "mcp-r2",
                  tool: "list_routes",
                  arguments: { path: "src/app", token: "hidden-token" },
                  result: { content: [{ type: "text", text: "23 routes private-project-value" }] },
                  status: "completed",
                },
              },
            },
            {
              method: "item/started",
              params: {
                item: {
                  type: "commandExecution",
                  id: "cmd-r2",
                  command: "cat README.md",
                  cwd: "/tmp",
                  status: "inProgress",
                },
              },
            },
            {
              method: "item/completed",
              params: {
                item: {
                  type: "commandExecution",
                  id: "cmd-r2",
                  command: "cat README.md",
                  cwd: "/tmp",
                  aggregatedOutput: "real README",
                  exitCode: 0,
                  status: "completed",
                },
              },
            },
            { type: "complete" },
          ]
    const value = await fixture({ provider, scenario: { events } })
    value.runtime.kernel.addRedactionValue("private-project-value")
    try {
      const request = addUser(value.store, value.thread, "inspect tools")
      const queued = value.engine.enqueue({ threadId: value.thread.id, requestMessageId: request.id, trigger: "user" })
      if (!queued.success) throw new Error(queued.error)
      await waitFor(() => terminal(queued.run.status))
      expect(queued.run.status).toBe("succeeded")
      const reply = [...value.store.messages.values()].find((item) => item.role === "assistant")
      const tools = reply?.parts.filter((part) => part.type === "tool_call") ?? []
      expect(tools).toHaveLength(1)
      expect(tools[0]?.inputJson).toContain(provider === "claude" ? "ls src/app" : "src/app")
      expect(tools[0]?.outputJson).toContain("23 routes")
      expect(tools[0]?.ok).toBe(true)
      expect(JSON.stringify(reply?.parts)).not.toMatch(/hidden-token|private-project-value/)
      expect(JSON.stringify(reply?.parts)).toContain("[REDACTED]")
      expect(queued.run.usage?.toolCalls).toBe(1)
      if (provider === "codex") {
        const commands = reply?.parts.filter((part) => part.type === "command") ?? []
        expect(commands).toHaveLength(1)
        expect(commands[0]?.outputTail).toBe("real README")
        expect(commands[0]?.exitCode).toBe(0)
      }
    } finally {
      await closeFixture(value)
    }
  })
}

test.serial("r2: system context describes actual capabilities and preserves SOUL verbatim", async () => {
  const { composeDeveloperInstructions } = await import("../../src/runtime/instructions")
  const { sessionFingerprint } = await import("../../src/runtime/session")
  const value = await fixture()
  try {
    const soul = "I use browser for visual QA.\nDo not rewrite this SOUL."
    const bot = { ...value.bot, instructions: soul, browserEnabled: false, computerUse: false }
    const disabled = await composeDeveloperInstructions({
      kernel: value.runtime.kernel,
      bot,
      thread: value.thread,
      cwd: bot.homeDir,
    })
    expect(disabled).toContain(`Bot SOUL:\n${soul}`)
    expect(disabled).toContain("Browser: disabled; do not claim browser access")
    expect(disabled).toContain("Computer use: disabled")
    const enabled = await composeDeveloperInstructions({
      kernel: value.runtime.kernel,
      bot: { ...bot, browserEnabled: true, computerUse: true },
      thread: value.thread,
      cwd: bot.homeDir,
    })
    expect(enabled).toContain("Browser: enabled")
    expect(enabled).toContain("Computer use: enabled; actions still require a valid user grant")
    const fingerprint = (browserEnabled: boolean) =>
      sessionFingerprint({ bot: { ...bot, browserEnabled }, cwd: bot.homeDir, mcpCommand: "bun", mcpArgs: [] }).hash
    expect(fingerprint(false)).not.toBe(fingerprint(true))
    expect(bot.instructions).toBe(soul)
  } finally {
    await closeFixture(value)
  }
})

test.serial(
  "R6: coordination guidance uses the current Bots UI and names instead of historical rooms and handles",
  async () => {
    const { composeDeveloperInstructions } = await import("../../src/runtime/instructions")
    const value = await fixture()
    try {
      const db = value.runtime.kernel.db as Database
      db.query("UPDATE bots SET name = 'pm-v2' WHERE id = ?").run(value.bot.id)
      db.query(
        "INSERT INTO bots (id, name, provider, home_dir, created_at, updated_at, archived_at) VALUES (?, ?, 'codex', ?, 1, 1, ?)",
      ).run("coder", "coder-v2", value.bot.homeDir, null)
      db.query(
        "INSERT INTO bots (id, name, provider, home_dir, created_at, updated_at, archived_at) VALUES (?, ?, 'codex', ?, 1, 1, ?)",
      ).run("old", "old-coder", value.bot.homeDir, 1)
      const soul = "Coordinate in the old team room with @old-coder."
      const instructions = await composeDeveloperInstructions({
        kernel: value.runtime.kernel,
        bot: { ...value.bot, instructions: soul },
        thread: value.thread,
        cwd: value.bot.homeDir,
      })
      expect(instructions).toContain(`Bot SOUL:\n${soul}`)
      const guidance = instructions.slice(instructions.indexOf("Actual enabled capabilities"))
      expect(guidance).toContain('"pm-v2"')
      expect(guidance).toContain('"coder-v2"')
      expect(guidance).not.toContain('"old-coder"')
      expect(guidance).toContain("Bots tab")
      expect(guidance).toContain("open or create a conversation and send the task there")
      expect(guidance).toContain(
        "The UI has Grupos with group conversations, optional coordinators and @member mentions",
      )
      expect(guidance).toContain("Do not claim to send tasks yourself")
    } finally {
      await closeFixture(value)
    }
  },
)

test.serial("R6: line limits and enabled capabilities survive long SOUL context and govern introductions", async () => {
  const { composeDeveloperInstructions } = await import("../../src/runtime/instructions")
  const value = await fixture()
  try {
    const soul = `Always introduce yourself with a long capability list.\n${"background\n".repeat(4000)}`
    const instructions = await composeDeveloperInstructions({
      kernel: value.runtime.kernel,
      bot: { ...value.bot, instructions: soul, browserEnabled: false },
      thread: value.thread,
      cwd: value.bot.homeDir,
    })
    expect(instructions.length).toBeLessThanOrEqual(24_000)
    expect(instructions).toStartWith("You are a touri AI teammate.")
    expect(instructions).toContain("Secrets are names only")
    expect(instructions).toContain("Browser: disabled")
    expect(instructions).toContain("current request takes priority")
    expect(instructions).toContain("exactly N short lines separated by literal newlines")
    expect(instructions).toContain("at most 15 words per line")
    expect(instructions).toContain("Markdown hard line breaks")
    expect(instructions).toContain("exactly N brief bullets")
    expect(instructions).toContain("add no extra introduction or footer")
    expect(instructions).toContain("within the requested length")
  } finally {
    await closeFixture(value)
  }
})

test.serial("P3 r3: first streamed delta is appended once, including before the final snapshot", async () => {
  const value = await fixture({
    provider: "claude",
    scenario: {
      slowMs: 150,
      events: [{ type: "delta", delta: "Sou" }, { type: "delta", delta: " o bot" }, { type: "complete" }],
    },
  })
  try {
    const request = addUser(value.store, value.thread, "identify")
    const result = value.engine.enqueue({ threadId: value.thread.id, requestMessageId: request.id, trigger: "user" })
    if (!result.success) throw new Error(result.error)
    await waitFor(() =>
      [...value.store.messages.values()].some((message) => message.role === "assistant" && !!message.text),
    )
    const first = [...value.store.messages.values()].find((message) => message.role === "assistant")
    expect(first?.text).toBe("Sou")
    expect(first?.parts.find((part) => part.type === "text")?.text).toBe("Sou")
    await waitFor(() => terminal(result.run.status))
    expect(first?.text).toBe("Sou o bot")
  } finally {
    await closeFixture(value)
  }
})

test.serial(
  "P1-4 r3: manual run-now deduplicates during start and its two-second window, including queue overlap",
  async () => {
    const value = await fixture({ scenario: { events: [{ type: "delta", delta: "done" }, { type: "complete" }] } })
    try {
      const created = value.engine.createRoutine({
        input: {
          botId: value.bot.id,
          name: "teste-relogio",
          prompt: "time",
          cron: "*/5 * * * *",
          timezone: "America/Sao_Paulo",
          enabled: false,
          continuity: "main-thread",
          resultsThreadId: null,
          groupId: null,
          timeoutMinutes: 1,
          overlap: "queue",
          catchUpMinutes: 30,
        },
        forceDisabled: true,
      })
      if (!created.success) throw new Error(created.error)
      const first = value.engine.runRoutine({ routineId: created.routine.id, triggerSource: "manual" })
      const second = value.engine.runRoutine({ routineId: created.routine.id, triggerSource: "manual" })
      if (!first.success || !second.success) throw new Error("Routine failed to start")
      expect(first.routineRun.id).toBe(second.routineRun.id)
      expect(value.engine.listRoutineRuns(created.routine.id)).toHaveLength(1)
      await waitFor(() => value.engine.listRoutineRuns(created.routine.id)[0]?.status === "succeeded")
      const replay = value.engine.runRoutine({ routineId: created.routine.id, triggerSource: "manual" })
      if (!replay.success) throw new Error(replay.error)
      expect(replay.routineRun.id).toBe(first.routineRun.id)
      await Bun.sleep(2100)
      const third = value.engine.runRoutine({ routineId: created.routine.id, triggerSource: "manual" })
      if (!third.success) throw new Error(third.error)
      expect(third.routineRun.id).not.toBe(first.routineRun.id)
      await waitFor(() => value.engine.listRoutineRuns(created.routine.id).every((run) => run.status === "succeeded"))
      expect(value.engine.listRoutineRuns(created.routine.id)).toHaveLength(2)
    } finally {
      await closeFixture(value)
    }
  },
)

test.serial(
  "P2 r3: Claude full access retains per-tool approval and default effort, with only attached MCP servers",
  async () => {
    const value = await fixture({
      provider: "claude",
      scenario: { events: [{ type: "delta", delta: "ok" }, { type: "complete" }] },
    })
    try {
      value.bot.access = "full"
      value.bot.approvals = "on-request"
      value.bot.reasoningEffort = null
      const calls: Array<Parameters<typeof value.runtime.kernel.spawnTree>[0]> = []
      const spawn = value.runtime.kernel.spawnTree
      value.runtime.kernel.spawnTree = (input) => {
        calls.push(input)
        return spawn(input)
      }
      const request = addUser(value.store, value.thread, "ok")
      const result = value.engine.enqueue({ threadId: value.thread.id, requestMessageId: request.id, trigger: "user" })
      if (!result.success) throw new Error(result.error)
      await waitFor(() => terminal(result.run.status))
      const args =
        calls.find(
          (call) =>
            call.cmd === value.fakePath ||
            (call.cmd === "/usr/bin/sandbox-exec" && call.args[2] === value.fakePath) ||
            (/\/bwrap$/.test(call.cmd) && call.args.includes(value.fakePath)),
        )?.args ?? []
      expect(args).toContain("--permission-prompt-tool")
      expect(args).toContain("mcp__touri__approval_prompt")
      expect(args).not.toContain("bypassPermissions")
      expect(args).not.toContain("--effort")
      const config = JSON.parse(
        readFileSync(join(value.root, "run/claude", `${value.thread.id}.mcp.json`), "utf8"),
      ) as { mcpServers: object }
      expect(Object.keys(config.mcpServers)).toEqual(["touri"])
    } finally {
      await closeFixture(value)
    }
  },
)

test.serial("transcript: Stop resolves pending provider tools before the interrupt grace period", async () => {
  const value = await fixture({
    scenario: {
      ignoreInterrupt: true,
      events: [
        {
          method: "item/started",
          params: { item: { type: "mcpToolCall", id: "open-call", tool: "inspect", arguments: {} } },
        },
        { method: "item/started", params: { item: { type: "fileChange", id: "open-change", paths: ["README.md"] } } },
        { type: "sleep" },
      ],
    },
    interruptGraceMs: 100,
  })
  try {
    const request = addUser(value.store, value.thread, "inspect")
    const queued = value.engine.enqueue({ threadId: value.thread.id, requestMessageId: request.id, trigger: "user" })
    if (!queued.success) throw new Error(queued.error)
    await waitFor(() =>
      value.store
        .activePath({ threadId: value.thread.id })
        .some((message) => message.parts.some((part) => part.type === "tool_call" && part.callId === "open-call")),
    )
    value.engine.cancel(queued.run.id)
    const reply = value.store.activePath({ threadId: value.thread.id }).find((message) => message.role === "assistant")
    expect(reply?.parts.find((part) => part.type === "tool_call")).toMatchObject({
      resolution: "cancelled_by_user",
      ok: null,
    })
    expect(reply?.parts.find((part) => part.type === "file_change")).toMatchObject({ resolution: "cancelled_by_user" })
    expect(
      (value.runtime.kernel.db as Database)
        .query("SELECT resolution FROM tool_resolutions WHERE run_id = ? AND call_id = 'open-call'")
        .get(queued.run.id),
    ).toEqual({ resolution: "cancelled_by_user" })
    await waitFor(() => terminal(queued.run.status), 2000)
    expect(queued.run.status).toBe("canceled")
  } finally {
    await closeFixture(value)
  }
})

test.serial("transcript: a late tool start during cancellation remains resolved", async () => {
  const value = await fixture({
    scenario: {
      ignoreInterrupt: true,
      slowMs: 100,
      events: [
        {
          method: "item/started",
          params: { item: { type: "mcpToolCall", id: "first-call", tool: "inspect", arguments: {} } },
        },
        { type: "sleep" },
        {
          method: "item/started",
          params: { item: { type: "mcpToolCall", id: "late-call", tool: "inspect", arguments: {} } },
        },
        { type: "sleep" },
      ],
    },
    interruptGraceMs: 1000,
  })
  try {
    const request = addUser(value.store, value.thread, "inspect")
    const queued = value.engine.enqueue({ threadId: value.thread.id, requestMessageId: request.id, trigger: "user" })
    if (!queued.success) throw new Error(queued.error)
    const tool = (callId: string) =>
      value.store
        .activePath({ threadId: value.thread.id })
        .flatMap((message) => message.parts)
        .find((part) => part.type === "tool_call" && part.callId === callId)
    await waitFor(() => tool("first-call") !== undefined)
    value.engine.cancel(queued.run.id)
    await waitFor(() => tool("late-call") !== undefined)
    expect(tool("late-call")).toMatchObject({ resolution: "cancelled_by_user", ok: null })
    await waitFor(() => terminal(queued.run.status), 2000)
  } finally {
    await closeFixture(value)
  }
})

test.serial("transcript: cancellation during environment loading never launches the queued turn", async () => {
  const value = await fixture()
  await value.engine.ready
  let release: (environment: Record<string, string>) => void = () => undefined
  const environment = new Promise<Record<string, string>>((resolve) => {
    release = resolve
  })
  value.runtime.kernel.shellEnv = () => environment
  try {
    const request = addUser(value.store, value.thread, "cancel before launch")
    const queued = value.engine.enqueue({ threadId: value.thread.id, requestMessageId: request.id, trigger: "user" })
    if (!queued.success) throw new Error(queued.error)
    await waitFor(() => value.engine.activeRun({ threadId: value.thread.id })?.id === queued.run.id)
    expect(value.engine.activeRun({ threadId: value.thread.id })?.id).toBe(queued.run.id)
    value.engine.cancel(queued.run.id)
    release({ PATH: process.env.PATH ?? "" })
    await waitFor(() => value.engine.activeRun({ threadId: value.thread.id }) === null, 2000)
    expect(queued.run.status).toBe("canceled")
    expect(value.engine.activeRun({ threadId: value.thread.id })).toBeNull()
    expect(existsSync(value.logPath)).toBe(false)
  } finally {
    release({ PATH: process.env.PATH ?? "" })
    await closeFixture(value)
  }
})

test.serial("local Claude profiles follow grant-free and full-access bookkeeping policy", async () => {
  const value = await fixture({ provider: "claude" })
  try {
    const envLog = join(value.assets, "claude-home.log")
    const fakeSource = readFileSync(value.fakePath, "utf8")
    writeFileSync(
      value.fakePath,
      fakeSource.replace(
        "exec ",
        `printf '%s\\n' "\${CLAUDE_CONFIG_DIR:-default}" >> ${JSON.stringify(envLog)}\nexec `,
      ),
      { mode: 0o700 },
    )
    const run = async (text: string) => {
      const request = addUser(value.store, value.thread, text)
      const queued = value.engine.enqueue({ threadId: value.thread.id, requestMessageId: request.id, trigger: "user" })
      if (!queued.success) throw new Error(queued.error)
      await waitFor(() => terminal(queued.run.status))
      expect(queued.run.status).toBe("succeeded")
    }
    await run("default home")
    const bot = value.store.bots.get(value.bot.id)
    if (!bot) throw new Error("Fixture bot missing")
    const profile = join(value.runtime.kernel.paths.appData, "provider-profiles", "selected", "claude")
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, "settings.json"), JSON.stringify({ forceLoginOrgUUID: "selected-profile" }))
    value.store.bots.set(bot.id, Object.assign({}, bot, { providerProfile: "selected" }))
    await run("profile home")
    value.store.bots.set(bot.id, Object.assign({}, bot, { providerProfile: "selected", access: "full" as const }))
    await run("full-access profile home")
    const homes = readFileSync(envLog, "utf8").trim().split("\n")
    expect(homes[0]).not.toContain("provider-profiles")
    expect(homes.slice(1)).toEqual([profile, profile])
    expect(
      JSON.parse(
        readFileSync(join(value.runtime.kernel.paths.runDir, "claude", `${value.thread.id}.settings.json`), "utf8"),
      ),
    ).toMatchObject({ forceLoginOrgUUID: "selected-profile" })
  } finally {
    await closeFixture(value)
  }
})

test("retry acknowledgements identify one persisted attempt, including after the attempt finishes", async () => {
  const f = await fixture({ scenario: { crashAt: 1, events: [{ type: "delta", delta: "unused" }] } })
  try {
    const request = addUser(f.store, f.thread, "Mensagem salva")
    const initial = f.engine.enqueue({ threadId: f.thread.id, requestMessageId: request.id, trigger: "user" })
    if (!initial.success) throw new Error(initial.error)
    await waitFor(() => terminal(initial.run.status))
    const retry = f.engine.retry(initial.run.id)
    if (!retry.success) throw new Error(retry.error)
    expect(f.engine.retry(initial.run.id)).toMatchObject({ success: true, run: { id: retry.run.id } })
    await waitFor(() => terminal(retry.run.status))
    expect(f.engine.retry(initial.run.id)).toMatchObject({ success: true, run: { id: retry.run.id } })
    expect(f.engine.listRuns(f.thread.id)).toHaveLength(2)
    expect([...f.store.messages.values()].filter((message) => message.role === "user")).toHaveLength(1)
  } finally {
    await closeFixture(f)
  }
})

test("a crash after a recorded write waits for review and never repeats the write", async () => {
  const f = await fixture({
    scenario: {
      crashAt: 2,
      events: [{ type: "command", command: "save notes.md", output: "saved" }, { type: "complete" }],
    },
  })
  const destination = join(f.assets, "notes.md")
  // The simulated provider commits a real write before emitting its tool acknowledgement.
  const wrapper = readFileSync(f.fakePath, "utf8")
  writeFileSync(
    f.fakePath,
    wrapper.replace("exec ", `if [ "$1" != "--version" ]; then printf 'saved\\n' >> '${destination}'; fi\nexec `),
  )
  try {
    const request = addUser(f.store, f.thread, "Salve minhas notas")
    const result = f.engine.enqueue({ threadId: f.thread.id, requestMessageId: request.id, trigger: "user" })
    if (!result.success) throw new Error(result.error)
    await waitFor(() => terminal(result.run.status))
    await Bun.sleep(250)
    expect(f.engine.retry(result.run.id)).toMatchObject({ success: false, errorCode: "CONFLICT" })
    expect(f.engine.listRuns(f.thread.id)).toHaveLength(1)
    expect(readFileSync(destination, "utf8")).toBe("saved\n")
    expect(f.store.activePath({ threadId: f.thread.id }).flatMap((message) => message.parts)).toContainEqual(
      expect.objectContaining({ type: "command", exitCode: 0 }),
    )
  } finally {
    await closeFixture(f)
  }
})

test.serial("server routines run without browser clients and persist late-slot and catch-up history", async () => {
  const value = await fixture({
    scenario: { events: [{ type: "delta", delta: "Notas organizadas" }, { type: "complete" }] },
  })
  try {
    const created = value.engine.createRoutine({
      input: {
        botId: value.bot.id,
        name: "Organizar notas",
        prompt: "Organize minhas notas",
        cron: "0 9 * * 1-5",
        timezone: "America/Sao_Paulo",
        enabled: true,
        continuity: "results-thread",
        resultsThreadId: value.thread.id,
        groupId: null,
        timeoutMinutes: 30,
        overlap: "skip",
        catchUpMinutes: 30,
      },
      forceDisabled: false,
    })
    if (!created.success) throw new Error(created.error)
    const due = Date.now() + 24 * 60 * 60_000
    value.engine.updateRoutine({ routineId: created.routine.id, patch: { nextRunAt: due }, fromTool: false })
    // No browser or UI is connected to this host. Its scheduler still executes.
    const scheduler = createRoutineScheduler({ kernel: value.runtime.kernel, engine: value.engine, intervalMs: 10 })
    const liveDue = Math.floor(Date.now() / 60_000) * 60_000
    value.engine.updateRoutine({ routineId: created.routine.id, patch: { nextRunAt: liveDue }, fromTool: false })
    try {
      await waitFor(() => value.engine.listRoutineRuns(created.routine.id)[0]?.status === "succeeded")
    } finally {
      scheduler.stop()
    }
    value.engine.updateRoutine({ routineId: created.routine.id, patch: { nextRunAt: due }, fromTool: false })
    await value.engine.tick(due + 5 * 60_000)
    await waitFor(() => value.engine.listRoutineRuns(created.routine.id)[0]?.status === "succeeded")
    expect(value.engine.listRoutineRuns(created.routine.id)[0]).toMatchObject({
      triggerSource: "catch-up",
      threadId: value.thread.id,
      scheduledFor: due,
    })
    const missed = due + 24 * 60 * 60_000
    value.engine.updateRoutine({ routineId: created.routine.id, patch: { nextRunAt: missed }, fromTool: false })
    await value.engine.tick(missed + 60 * 60_000)
    expect(value.engine.listRoutineRuns(created.routine.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "skipped",
          triggerSource: "catch-up",
          scheduledFor: missed,
          summary: expect.stringContaining("o atraso ultrapassou a janela de recuperação"),
        }),
      ]),
    )
    await value.engine.tick(missed + 60 * 60_000)
    expect(value.engine.listRoutineRuns(created.routine.id).filter((run) => run.scheduledFor === missed)).toHaveLength(
      1,
    )
  } finally {
    await closeFixture(value)
  }
})

test.serial("editing a routine task or destination pauses it until a new explicit activation", async () => {
  const value = await fixture()
  try {
    const created = value.engine.createRoutine({
      input: {
        botId: value.bot.id,
        name: "Organizar notas",
        prompt: "Organize minhas notas",
        cron: "0 9 * * 1-5",
        timezone: "America/Sao_Paulo",
        enabled: true,
        continuity: "main-thread",
        resultsThreadId: null,
        groupId: null,
        timeoutMinutes: 30,
        overlap: "skip",
        catchUpMinutes: 30,
      },
      forceDisabled: false,
    })
    if (!created.success) throw new Error(created.error)
    for (const patch of [{ prompt: "Organize outras notas" }, { continuity: "new-thread" as const }]) {
      const edited = value.engine.updateRoutine({
        routineId: created.routine.id,
        patch,
        fromTool: true,
        botId: value.bot.id,
      })
      expect(edited).toMatchObject({ success: true, routine: { enabled: false, nextRunAt: null } })
      const activated = value.engine.updateRoutine({
        routineId: created.routine.id,
        patch: { enabled: true },
        fromTool: false,
      })
      expect(activated).toMatchObject({ success: true, routine: { enabled: true } })
    }
  } finally {
    await closeFixture(value)
  }
})

test.serial("newly activated routines wait for a future slot instead of replaying unreviewed past work", async () => {
  const f = await fixture()
  try {
    const before = Date.now()
    const created = f.engine.createRoutine({
      forceDisabled: false,
      input: {
        botId: f.bot.id,
        name: "Organizar notas",
        prompt: "Organize minhas notas",
        cron: "0 9 * * 1-5",
        timezone: "America/Sao_Paulo",
        enabled: true,
        continuity: "main-thread",
        resultsThreadId: null,
        groupId: null,
        timeoutMinutes: 30,
        overlap: "skip",
        catchUpMinutes: 30,
      },
    })
    if (!created.success) throw new Error(created.error)
    expect(created.routine.nextRunAt).toBeGreaterThan(before)
    await f.engine.tick(before)
    expect(f.engine.listRoutineRuns(created.routine.id)).toEqual([])
  } finally {
    await closeFixture(f)
  }
})

const routineForDeletion = (value: Fixture) => {
  const result = value.engine.createRoutine({
    input: {
      botId: value.bot.id,
      name: "Organizar notas",
      prompt: "Organize minhas notas",
      cron: "*/5 * * * *",
      timezone: "UTC",
      enabled: true,
      continuity: "main-thread",
      resultsThreadId: null,
      groupId: null,
      timeoutMinutes: 30,
      overlap: "queue",
      catchUpMinutes: 30,
    },
    forceDisabled: false,
  })
  if (!result.success) throw new Error(result.error)
  return result.routine
}

test.serial("deleting a running routine lets its turn finish and preserves conversation and run history", async () => {
  const value = await fixture({
    scenario: { slowMs: 100, events: [{ type: "delta", delta: "Notas organizadas" }, { type: "complete" }] },
  })
  try {
    const routine = routineForDeletion(value)
    const started = value.engine.runRoutine({ routineId: routine.id, triggerSource: "manual" })
    if (!started.success || !started.routineRun.runId) throw new Error("Missing run")
    const runId = started.routineRun.runId
    await waitFor(() =>
      value.engine.listRuns(value.thread.id).some((run) => run.id === runId && run.status === "running"),
    )
    expect(value.engine.deleteRoutine(routine.id).success).toBe(true)
    expect(value.engine.listRoutines()).toEqual([])
    await waitFor(() =>
      value.engine.listRuns(value.thread.id).some((run) => run.id === runId && run.status === "succeeded"),
    )
    expect(
      value.store
        .activePath({ threadId: value.thread.id })
        .some((message) => message.text.includes("Notas organizadas")),
    ).toBe(true)
    const persistence = createRuntimePersistence({ database: value.runtime.kernel.db })
    expect(persistence.getRun(runId)?.status).toBe("succeeded")
    expect(persistence.getRoutine(routine.id)).toBeNull()
    expect((value.runtime.kernel.db as Database).query("PRAGMA foreign_key_check").all()).toEqual([])
  } finally {
    await closeFixture(value)
  }
})

test.serial("deletion drops queued catch-up work and a cached due schedule stays deleted after reopening", async () => {
  const value = await fixture({ maxConcurrentRuns: 0 })
  let reopened: ReturnType<typeof createKernel> | undefined
  let replacement: ReturnType<typeof createRuntimeEngine> | undefined
  try {
    const routine = routineForDeletion(value)
    const due = Date.now() - 180_000
    value.engine.updateRoutine({ routineId: routine.id, patch: { nextRunAt: due }, fromTool: false })
    await value.engine.tick()
    const queuedRun = value.engine.listRuns(value.thread.id)[0]
    expect(queuedRun?.status).toBe("queued")
    expect(value.engine.listRoutineRuns(routine.id)[0]?.triggerSource).toBe("catch-up")
    // Populate both caches before deletion, then verify a later tick cannot revive it.
    value.engine.listRoutines()
    value.engine.listRoutineRuns(routine.id)
    expect(value.engine.deleteRoutine(routine.id).success).toBe(true)
    expect(value.engine.listRuns(value.thread.id)[0]?.status).toBe("canceled")
    await value.engine.tick(Date.now() + 600_000)
    expect(value.engine.listRuns(value.thread.id)).toHaveLength(1)
    expect(value.engine.listRoutineRuns(routine.id)).toEqual([])
    expect(value.engine.runRoutine({ routineId: routine.id, triggerSource: "manual" }).success).toBe(false)
    await value.engine.shutdown()
    reopened = createKernel({ appData: value.root })
    reopened.kernel.spawnTree = fakeProviderSpawn(reopened.kernel.spawnTree, value.fakePath, value.scenario)
    reopened.kernel.services.provide("store.api", value.store)
    replacement = createRuntimeEngine({ kernel: reopened.kernel, codexCommand: value.fakePath })
    await replacement.tick(Date.now() + 900_000)
    expect(replacement.listRoutines()).toEqual([])
    expect(replacement.listRuns(value.thread.id)).toHaveLength(1)
    expect(replacement.listRuns(value.thread.id)[0]?.status).toBe("canceled")
  } finally {
    await replacement?.shutdown()
    reopened?.stop()
    await closeFixture(value)
  }
})

runtimeTest.serial("first notes example completes in Portuguese without a connected project or folder", async () => {
  const response = "- Comprar café\n- Revisar orçamento\n- Marcar reunião"
  const f = await fixture({ scenario: { events: [{ type: "delta", delta: response }, { type: "complete" }] } })
  const requestLogPath = join(f.assets, "requests.jsonl")
  try {
    f.bot.cwd = null
    f.bot.folders = []
    ;(f.runtime.kernel.db as Database).query("UPDATE bots SET cwd=NULL WHERE id=?").run(f.bot.id)
    writeFileSync(
      f.scenario,
      JSON.stringify({ requestLogPath, events: [{ type: "delta", delta: response }, { type: "complete" }] }),
    )
    const prompt = t("onboarding.examplePrompt")
    const request = addUser(f.store, f.thread, prompt)
    const queued = f.engine.enqueue({ threadId: f.thread.id, requestMessageId: request.id, trigger: "user" })
    if (!queued.success) throw new Error(queued.error)
    await waitFor(() => terminal(queued.run.status))
    expect(queued.run.status).toBe("succeeded")
    expect(f.bot.projectId).toBeNull()
    expect(f.bot.folders).toEqual([])
    const replies = f.store.activePath({ threadId: f.thread.id }).filter((item) => item.role === "assistant")
    expect(replies.at(-1)?.text).toBe(response)
    const requests = readFileSync(requestLogPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    const starts = requests.filter((item) => item.method === "turn/start")
    expect(starts).toHaveLength(1)
    expect(JSON.stringify(starts[0])).toContain("lista em português do Brasil")
    expect(JSON.stringify(starts[0])).toContain("Comprar café; revisar orçamento; marcar reunião.")
  } finally {
    await closeFixture(f)
  }
})
