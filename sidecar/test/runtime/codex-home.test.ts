import { afterEach, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, Kernel, Thread, UiEvent } from "@touri/contracts"
import { openDatabase } from "../../src/kernel/db"
import { createAppPaths } from "../../src/kernel/paths"
import { createServices } from "../../src/kernel/services"
import { createRuntimeEngine } from "../../src/runtime/engine"
import { localFolderProfile } from "../../src/runtime/folder-access"
import { providerLoginSourceKey } from "../../src/vm/provider-login"
import { createTestStore } from "./fake-store"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})

type RpcRequest = { id: number; method: string; params: { input?: Array<{ text?: string }> } }
type TurnFailure = { message: string; started?: boolean; direct?: boolean; text?: string }

const getTurnFrames = (failure?: TurnFailure) => {
  const started = { method: "turn/started", params: { turnId: "managed-turn" } }
  if (failure) {
    const completion = failure.direct
      ? { method: "error", params: { message: failure.message } }
      : { method: "turn/completed", params: { status: "failed", error: { message: failure.message } } }

    return [
      ...(failure.started ? [started] : []),
      ...(failure.text
        ? [{ method: "item/agentMessage/delta", params: { itemId: "reply", delta: failure.text } }]
        : []),
      completion,
    ]
  }

  return [
    started,
    { method: "item/agentMessage/delta", params: { itemId: "reply", delta: "ok" } },
    { method: "turn/completed", params: { status: "succeeded" } },
  ]
}

const getProviderProcess = (
  requests: RpcRequest[],
  resumeError?: string,
  failure?: TurnFailure,
): ReturnType<Kernel["spawnTree"]> => {
  let output: ReadableStreamDefaultController<Uint8Array>
  const stdout = new ReadableStream<Uint8Array>({
    start: (controller) => {
      output = controller
    },
  })
  const emit = (value: unknown) => output.enqueue(new TextEncoder().encode(`${JSON.stringify(value)}\n`))
  let finish: (result: { code: number; signal: null }) => void = () => {}
  const exited = new Promise<{ code: number; signal: null }>((resolve) => {
    finish = resolve
  })
  let closed = false
  return {
    success: true,
    target: "remote",
    pid: 0,
    pgid: 0,
    extra: [],
    stdout,
    stderr: new ReadableStream({ start: (controller) => controller.close() }),
    stdin: new WritableStream({
      write: (chunk) => {
        const request = JSON.parse(new TextDecoder().decode(chunk)) as RpcRequest
        requests.push(request)
        if (request.method === "thread/resume" && resumeError) {
          emit({ id: request.id, error: { message: resumeError } })
          return
        }
        emit({
          id: request.id,
          result: request.method.startsWith("thread/") ? { thread: { id: "managed-thread" } } : {},
        })
        if (request.method === "turn/start") getTurnFrames(failure).forEach(emit)
      },
    }),
    exited,
    kill: () => {
      if (closed) return
      closed = true
      output.close()
      finish({ code: 0, signal: null })
    },
  }
}

const getFixture = (resumeError?: string, failures: ReadonlyArray<TurnFailure> = []) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "touri-codex-home-")))
  const host = join(root, "host")
  const paths = createAppPaths({ appData: join(root, "data") })
  const db = openDatabase({ filename: paths.db })
  const bot = {
    id: "bot-home",
    name: "Home",
    instructions: "Be useful.",
    instructionsHash: "test-hash",
    provider: "codex",
    machine: "local",
    access: "workspace-write",
    approvals: "on-request",
    homeDir: join(paths.botsDir, "bot-home"),
    cwd: join(root, "workspace"),
    notifications: "all",
    source: "local",
    folders: [],
    anyFolderAccess: false,
    paused: false,
  } as unknown as Bot
  const thread = { id: "thread-home", botId: bot.id, title: "Home", activeLeafId: null, kind: "main" } as Thread
  for (const directory of [bot.homeDir, bot.cwd ?? bot.homeDir, join(host, ".codex/sessions")])
    mkdirSync(directory, { recursive: true })
  writeFileSync(join(host, ".codex/auth.json"), '{"tokens":{"access_token":"synthetic-access"}}')
  writeFileSync(join(host, ".codex/config.toml"), 'model_provider = "openai"\nnotify = ["unsafe-notify"]\n')
  db.query(
    "INSERT INTO bots (id,name,instructions,instructions_hash,provider,access,approvals,home_dir,cwd,notifications,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,1)",
  ).run(
    bot.id,
    bot.name,
    bot.instructions,
    bot.instructionsHash,
    bot.provider,
    bot.access,
    bot.approvals,
    bot.homeDir,
    bot.cwd,
    bot.notifications,
    bot.source,
  )
  db.query(
    "INSERT INTO threads (id,bot_id,kind,title,usage_json,source,created_at,updated_at) VALUES (?,?,?,?,'{}','local',1,1)",
  ).run(thread.id, bot.id, thread.kind, thread.title)
  db.query("INSERT INTO settings (key,value_json,updated_at) VALUES (?, ?, 1)").run(
    providerLoginSourceKey(bot),
    '"host-file"',
  )
  const rollout = join(host, ".codex/sessions/old.jsonl")
  if (resumeError) {
    writeFileSync(rollout, "synthetic host session")
    db.query(
      "INSERT INTO provider_sessions (id,thread_id,provider,external_session_id,rollout_path,fingerprint,state,created_at,last_used_at) VALUES ('old-session',?,'codex','old-external',?,'imported','active',1,1)",
    ).run(thread.id, rollout)
  }
  const requests: RpcRequest[] = []
  const calls: Array<Parameters<Kernel["spawnTree"]>[0]> = []
  const events: UiEvent[] = []
  const environment = {
    HOME: host,
    CODEX_HOME: join(host, ".codex"),
    PATH: process.env.PATH ?? "",
  }
  const kernel = {
    db,
    paths,
    services: createServices(),
    newId: randomUUID,
    shellEnv: async () => environment,
    log: () => {},
    redact: (value: string) => value,
    publish: (event: UiEvent) => events.push(event),
    subscribe: () => () => {},
    spawnTree: (input: Parameters<Kernel["spawnTree"]>[0]) => {
      calls.push(input)
      return getProviderProcess(requests, resumeError, failures[calls.length - 1])
    },
  } as unknown as Kernel
  const store = createTestStore({ bot, thread, publish: kernel.publish })
  kernel.services.provide("store.api", store)
  const engine = createRuntimeEngine({ kernel, codexCommand: process.execPath, environment })
  cleanups.push(async () => {
    await engine.shutdown()
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  const send = (text: string) => {
    const request = store.insertMessage({
      message: {
        id: randomUUID(),
        threadId: thread.id,
        parentId: thread.activeLeafId,
        role: "user",
        kind: "text",
        status: "complete",
        runId: null,
        text,
        parts: [{ type: "text", text }],
        sender: { id: "user", name: "User" },
        source: "local",
      },
    })
    if (!request.success) throw new Error(request.error)
    const queued = engine.enqueue({ threadId: thread.id, requestMessageId: request.message.id, trigger: "user" })
    if (!queued.success) throw new Error(queued.error)
    return queued.run
  }
  return {
    root,
    host,
    paths,
    bot,
    thread,
    calls,
    events,
    kernel,
    db,
    engine,
    send,
    store,
    requests,
  }
}

const waitForRun = async (run: { status: string }, timeout = 5000) => {
  const start = Date.now()
  while (!["succeeded", "failed", "canceled"].includes(run.status)) {
    if (Date.now() - start > timeout) throw new Error("Timed out waiting for turn")
    await Bun.sleep(10)
  }
}

test("a host-login local turn overrides the inherited Codex home with linked auth and minimal config", async () => {
  const f = getFixture()
  const run = f.send("Responda só: ok")
  await waitForRun(run)
  expect(run.status).toBe("succeeded")
  const home = join(f.paths.appData, "provider-homes/codex", f.bot.id)
  expect(f.calls[0]?.env.CODEX_HOME).toBe(home)
  expect(readlinkSync(join(home, "auth.json"))).toBe(join(f.host, ".codex/auth.json"))
  expect(Bun.TOML.parse(readFileSync(join(home, "config.toml"), "utf8"))).toEqual({
    cli_auth_credentials_store: "file",
    model_provider: "openai",
  })
  const next = f.send("Continue in the same managed home")
  await waitForRun(next)
  expect(next.status).toBe("succeeded")
  expect(f.requests.filter((request) => request.method === "thread/resume")).toHaveLength(1)
  // The outer macOS sandbox permits the link target, including in a read-only turn.
  const args = {
    bot: { ...f.bot, access: "read-only" },
    thread: f.thread,
    fingerprint: { cwd: f.bot.cwd },
  } as Parameters<typeof localFolderProfile>[1]
  const profile = localFolderProfile(f.kernel, args, { CODEX_HOME: home }, f.host)
  expect(profile).toContain(`(subpath ${JSON.stringify(join(f.host, ".codex/auth.json"))})`)
  if (process.platform === "darwin") {
    const child = Bun.spawn(
      ["/usr/bin/sandbox-exec", "-p", profile, "/bin/sh", "-c", 'printf refreshed > "$CODEX_HOME/auth.json"'],
      { env: { CODEX_HOME: home }, stdout: "ignore", stderr: "pipe" },
    )
    expect(await child.exited).toBe(0)
    expect(readFileSync(join(f.host, ".codex/auth.json"), "utf8")).toBe("refreshed")
  }
})

for (const error of ["rollout not found", "Unable to load session"])
  test(`a host session missing from the managed home restarts with history and no visible error: ${error}`, async () => {
    const f = getFixture(error)
    const run = f.send("Continue the synthetic task")
    await waitForRun(run)
    expect(run.status).toBe("succeeded")
    const requests = f.requests
    expect(requests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "thread/resume",
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
    ])
    const input = requests.find((request) => request.method === "turn/start")?.params.input ?? []
    expect(input[0]?.text).toContain("[touri handoff]")
    expect(input[0]?.text).toContain("Continue the synthetic task")
    expect(input[0]?.text).toContain("native session could not be resumed")
    expect(
      f.calls.every((call) => call.env.CODEX_HOME === join(f.paths.appData, "provider-homes/codex", f.bot.id)),
    ).toBe(true)
    expect(f.db.query("SELECT state FROM provider_sessions WHERE id = 'old-session'").get()).toEqual({
      state: "failed",
    })
    expect(
      [...f.store.messages.values()]
        .flatMap((message) => message.parts)
        .some((part) => part.type === "notice" && part.level === "error"),
    ).toBe(false)
    expect(
      f.events
        .filter((event) => event.type === "run.updated")
        .some((event) => event.type === "run.updated" && event.run.status === "failed"),
    ).toBe(false)
  })

test("a Codex authentication failure during resume still asks for login", async () => {
  const f = getFixture("login required")
  const run = f.send("Continue the synthetic task")
  await waitForRun(run)
  expect(run.status).toBe("failed")
  expect(f.requests.map((request) => request.method)).toEqual(["initialize", "initialized", "thread/resume"])
})

test.each(["database is locked", "SQLITE_BUSY", "database table is locked"])(
  "a failed completion before turn startup retries a transient lock: %s",
  async (message) => {
    const runtime = getFixture(undefined, [{ message }])
    const request = "Continue the synthetic task"

    const run = runtime.send(request)
    await waitForRun(run)
    const turns = runtime.requests.filter((item) => item.method === "turn/start")

    expect(run.status).toBe("succeeded")
    expect(runtime.calls).toHaveLength(2)
    expect(turns).toHaveLength(2)
    expect(turns.every((turn) => turn.params.input?.some((item) => item.text?.includes(request)))).toBe(true)
    expect(
      runtime.store.activePath({ threadId: runtime.thread.id }).filter((item) => item.role === "assistant"),
    ).toMatchObject([{ status: "complete", text: "ok" }])
    expect(runtime.engine.listRuns(runtime.thread.id)).toMatchObject([{ id: run.id, status: "succeeded" }])
    expect(runtime.db.query("SELECT state FROM provider_sessions").all()).toEqual([{ state: "active" }])
  },
)

test("a lock reported in every pre-start completion stops after the bounded retries", async () => {
  const failures = Array.from({ length: 5 }, () => ({ message: "database is locked" }))
  const runtime = getFixture(undefined, failures)

  const run = runtime.send("Continue the synthetic task")
  await waitForRun(run, 10_000)

  expect(run).toMatchObject({ status: "failed", errorClass: "cli_protocol", errorMessage: "database is locked" })
  expect(runtime.calls).toHaveLength(4)
}, 15_000)

test("a database lock after turn startup never replays the request", async () => {
  const runtime = getFixture(undefined, [{ message: "database is locked", started: true }])

  const run = runtime.send("Continue the synthetic task")
  await waitForRun(run)

  expect(run).toMatchObject({ status: "failed", errorClass: "cli_protocol" })
  expect(runtime.calls).toHaveLength(1)
  expect(runtime.requests.filter((request) => request.method === "turn/start")).toHaveLength(1)
})

test("a lock after partial output never replays a turn with a missing startup notification", async () => {
  const runtime = getFixture(undefined, [{ message: "database is locked", text: "Partial reply" }])

  const run = runtime.send("Continue the synthetic task")
  await waitForRun(run)

  expect(run).toMatchObject({ status: "failed", errorClass: "cli_protocol" })
  expect(runtime.calls).toHaveLength(1)
  expect(
    runtime.store.activePath({ threadId: runtime.thread.id }).find((item) => item.role === "assistant")?.text,
  ).toBe("Partial reply")
})

test("a later authentication failure keeps its own cause after a retried lock completion", async () => {
  const runtime = getFixture(undefined, [
    { message: "database is locked" },
    { message: "login required", direct: true },
  ])

  const run = runtime.send("Continue the synthetic task")
  await waitForRun(run)

  expect(run).toMatchObject({ status: "failed", errorClass: "cli_auth", errorMessage: "login required" })
  expect(runtime.calls).toHaveLength(2)
})
