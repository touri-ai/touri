import type { Database } from "bun:sqlite"
import { expect, mock, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ApprovalPart, Message, Run } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { init as initNotify } from "../../src/notify"
import { createProjectStore } from "../../src/projects/repository"
import { createSetupTools } from "../../src/projects/setup-tools"
import { continuationMarkers } from "../../src/runtime/continuations"
import { createRuntimeEngine } from "../../src/runtime/engine"
import * as folderAccess from "../../src/runtime/folder-access"
import { createWorkState } from "../../src/runtime/work-state"
import { init as initStore } from "../../src/store"
import { fakeProviderSpawn } from "../fakes/provider-spawn"

type Engine = ReturnType<typeof createRuntimeEngine>
type Runtime = ReturnType<typeof createKernel>

const waitFor = async (predicate: () => boolean, timeout = 10_000): Promise<void> => {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the resumed turn")
    await Bun.sleep(10)
  }
}

const PAUSED = { pauseAfterFirstDelta: "release", ignoreInterrupt: true, deltas: ["INÍCIO", " meio", " FIM"] }

/**
 * A fake Codex on a real store. `crash-once` makes the next provider process exit mid-turn;
 * every other turn follows scenario.json.
 */
const fixture = async ({ resumeBackoffMs = 50 }: { resumeBackoffMs?: number } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "touri-resume-"))
  // Recovery fixtures must not depend on a provider reading touri's private data.
  const assets = mkdtempSync(join(tmpdir(), "touri-resume-provider-"))
  const scenario = join(assets, "scenario.json")
  const crashScenario = join(assets, "crash.json")
  const crashOnce = join(assets, "crash-once")
  const requests = join(assets, "requests.jsonl")
  const command = join(assets, "codex")
  const fake = join(import.meta.dir, "../fakes/fake-codex.ts")
  writeFileSync(
    command,
    `#!/bin/sh
if [ "$1" != "--version" ] && [ -f '${crashOnce}' ]; then rm -f '${crashOnce}'; TOURI_FAKE_SCENARIO='${crashScenario}'; export TOURI_FAKE_SCENARIO; fi
exec '${process.execPath}' '${fake}' "$@"
`,
  )
  chmodSync(command, 0o700)
  const writeScenario = (value: Record<string, unknown>): void =>
    writeFileSync(
      scenario,
      JSON.stringify({
        ...value,
        requestLogPath: requests,
        ...(value.pauseAfterFirstDelta ? { pauseAfterFirstDelta: join(assets, "release") } : {}),
      }),
    )
  writeScenario(PAUSED)
  writeFileSync(
    crashScenario,
    JSON.stringify({ crashAt: 2, deltas: ["parcial ", "perdido"], requestLogPath: requests }),
  )
  const kernels: Array<Runtime> = []
  const engines: Array<Engine> = []
  const open = async (options: { resumeBackoffMs?: number; routineTimeoutMs?: number } = {}) => {
    const runtime = createKernel({ appData: root })
    runtime.kernel.spawnTree = fakeProviderSpawn(runtime.kernel.spawnTree, command, scenario)
    await initStore(runtime.kernel)
    await initNotify(runtime.kernel)
    kernels.push(runtime)
    const engine = createRuntimeEngine({
      kernel: runtime.kernel,
      codexCommand: command,
      environment: { PATH: process.env.PATH ?? "/usr/bin", TOURI_FAKE_SCENARIO: scenario },
      interruptGraceMs: 30,
      ...(options.resumeBackoffMs === undefined ? {} : { resumeBackoffMs: options.resumeBackoffMs }),
      ...(options.routineTimeoutMs === undefined ? {} : { routineTimeoutMs: () => options.routineTimeoutMs ?? 0 }),
    })
    engines.push(engine)
    const store = runtime.kernel.services.use("store.api")
    if (!store) throw new Error("Store missing")
    return { runtime, engine, store, db: runtime.kernel.db as Database }
  }
  const first = await open({ resumeBackoffMs })
  first.db.exec(`INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('b','Teste','codex','/tmp',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('t','b','Conversa',1,1);`)
  const send = (engine: Engine, text = "Tarefa longa"): Run => {
    const store = first.store
    const request = store.insertMessage({
      message: {
        id: first.runtime.kernel.newId(),
        threadId: "t",
        parentId: store.getThread({ threadId: "t" })?.activeLeafId ?? null,
        role: "user",
        kind: "text",
        status: "complete",
        runId: null,
        text,
        parts: [],
        sender: null,
        source: "local",
      },
    })
    if (!request.success) throw new Error(request.error)
    const result = engine.enqueue({ threadId: "t", requestMessageId: request.message.id, trigger: "user" })
    if (!result.success) throw new Error(result.error)
    return result.run
  }
  const runs = (): Array<{ id: string; status: string; error_class: string | null; trigger: string }> =>
    first.db.query("SELECT id, status, error_class, trigger FROM runs ORDER BY queued_at, rowid").all() as Array<{
      id: string
      status: string
      error_class: string | null
      trigger: string
    }>
  const links = (): Array<{ run_id: string; original_run_id: string; previous_run_id: string; reason: string }> =>
    first.db
      .query(
        "SELECT run_id, original_run_id, previous_run_id, reason FROM run_continuations ORDER BY created_at, rowid",
      )
      .all() as Array<{ run_id: string; original_run_id: string; previous_run_id: string; reason: string }>
  const markers = (): Array<Message> =>
    first.store
      .activePath({ threadId: "t" })
      .filter((message) => message.parts.some((part) => part.type === "notice" && part.code === "run_resumed"))
  const frames = (): Array<{ method: string; params: Record<string, unknown> }> =>
    existsSync(requests)
      ? readFileSync(requests, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : []
  const disableResume = (): void => {
    first.db
      .query(
        "INSERT OR REPLACE INTO settings (key, value_json, updated_at) VALUES ('resumeInterruptedTurns', 'false', 1)",
      )
      .run()
  }
  const streamed = (text: string) => () => first.store.activePath({ threadId: "t" }).some((m) => m.text === text)
  return {
    root,
    assets,
    first,
    open,
    send,
    runs,
    links,
    markers,
    frames,
    disableResume,
    streamed,
    writeScenario,
    crashOnce: () => writeFileSync(crashOnce, ""),
    release: () => writeFileSync(join(assets, "release"), ""),
    close: async () => {
      for (const engine of engines.reverse()) await engine.shutdown()
      for (const runtime of kernels.reverse()) runtime.stop()
      rmSync(root, { recursive: true, force: true })
      rmSync(assets, { recursive: true, force: true })
    },
  }
}

test("an approved folder write grant automatically continues with updated Codex writable roots", async () => {
  // The fixture provider only speaks JSON-RPC. Assert the generated sandbox policy
  // separately so this lifecycle test also runs on Linux without Seatbelt.
  const f = await fixture()
  const original = { ...folderAccess }
  mock.module("../../src/runtime/folder-access", () => ({
    ...original,
    spawnFolderProvider: (
      kernel: Parameters<typeof original.spawnFolderProvider>[0],
      args: Parameters<typeof original.spawnFolderProvider>[1],
      input: Parameters<typeof original.spawnFolderProvider>[2],
    ) => {
      const profile = original.localFolderProfile(kernel, args, input.env)
      for (const folder of args.bot.folders ?? [])
        expect(profile.includes(`(deny file-write* (subpath ${JSON.stringify(folder.path)}))`)).toBe(
          folder.access === "read-only",
        )
      return kernel.spawnTree(input)
    },
  }))
  try {
    mkdirSync(join(f.assets, "output"))
    const folder = realpathSync(join(f.assets, "output"))
    const target = join(folder, "images")
    f.first.db
      .query("UPDATE bots SET folders_json=? WHERE id='b'")
      .run(JSON.stringify([{ path: folder, access: "read-only" }]))
    f.first.runtime.kernel.services.provide("approvals.present", f.first.engine.approvalBridge.present)
    f.first.runtime.kernel.services.provide("runtime.continueAfterApproval", f.first.engine.continueAfterApproval)
    f.disableResume()
    const run = f.send(f.first.engine, "Salve as imagens na subpasta solicitada")
    await waitFor(f.streamed("INÍCIO"))
    const tool = createSetupTools({
      kernel: f.first.runtime.kernel,
      store: createProjectStore({ kernel: f.first.runtime.kernel }),
    }).find((tool) => tool.name === "folder_access_request")
    if (!tool) throw new Error("Missing folder tool")
    const call = tool.handler({
      ctx: {
        botId: "b",
        threadId: "t",
        runId: run.id,
        projectId: null,
        cwd: folder,
        signal: new AbortController().signal,
      },
      args: { path: target, mode: "read-write" },
    })
    let card: ApprovalPart | undefined
    await waitFor(() => {
      card = f.first.store
        .activePath({ threadId: "t" })
        .flatMap((message) => message.parts)
        .find((part): part is ApprovalPart => part.type === "approval" && part.decision === "pending")
      return !!card
    })
    if (!card) throw new Error("Missing approval")
    expect(existsSync(target)).toBe(false)
    expect((await f.first.engine.answerApproval({ approvalId: card.approvalId, decision: "approved" })).success).toBe(
      true,
    )
    expect(await call).toMatchObject({ success: true, structured: { automaticContinuation: true } })
    expect(existsSync(target)).toBe(true)
    f.writeScenario({ deltas: ["Imagens salvas."] })
    f.release()
    await waitFor(() => f.runs().length === 2 && f.runs().every((run) => run.status === "succeeded"))
    expect(f.links()).toMatchObject([{ previous_run_id: run.id, reason: "permission_granted" }])
    expect(f.markers()).toMatchObject([{ text: continuationMarkers.permission_granted }])
    const sessions = f.frames().filter((frame) => frame.method === "thread/start")
    expect(sessions).toHaveLength(2)
    // On macOS the grant lives in touri's Seatbelt profile (asserted in the spawn mock above), not in
    // Codex's writable roots, because Codex cannot nest its own sandbox there.
    if (process.platform !== "darwin" && !folderAccess.hostFolderAccessAvailable()) {
      expect(JSON.stringify(sessions[0]?.params.config)).not.toContain(folder)
      expect(JSON.stringify(sessions[1]?.params.config)).toContain(folder)
    }
    expect(
      JSON.stringify(
        f
          .frames()
          .filter((frame) => frame.method === "turn/start")
          .at(-1)?.params.input,
      ),
    ).toContain("The approved configuration is now applied")
  } finally {
    await f.close()
    mock.module("../../src/runtime/folder-access", () => original)
  }
}, 30_000)

test("app restart continues an interrupted turn in the same provider session", async () => {
  const f = await fixture()
  try {
    const original = f.send(f.first.engine)
    await waitFor(f.streamed("INÍCIO"))
    f.writeScenario({ deltas: ["Continuei e terminei."] })
    // A second runtime takes over, as when the app is reopened after a crash.
    const restarted = await f.open()
    await waitFor(() => f.runs().some((run) => run.id !== original.id && run.status === "succeeded"))
    const [interrupted, continuation] = f.runs()
    expect(interrupted).toMatchObject({ id: original.id, status: "interrupted", error_class: "app_restart" })
    expect(continuation).toMatchObject({ status: "succeeded", trigger: "retry" })
    expect(f.links()).toEqual([
      {
        run_id: continuation?.id ?? "",
        original_run_id: original.id,
        previous_run_id: original.id,
        reason: "app_restart",
      },
    ])
    const [marker] = f.markers()
    expect(marker).toMatchObject({ role: "system", kind: "notice", text: continuationMarkers.app_restart })
    const path = restarted.store.activePath({ threadId: "t" })
    expect(path.at(-1)).toMatchObject({ role: "assistant", parentId: marker?.id, text: "Continuei e terminei." })
    const sessions = f.frames().filter((frame) => ["thread/start", "thread/resume"].includes(frame.method))
    expect(sessions.map((frame) => frame.method)).toEqual(["thread/start", "thread/resume"])
    const input = JSON.stringify(
      f
        .frames()
        .filter((frame) => frame.method === "turn/start")
        .at(-1)?.params.input,
    )
    expect(input).toContain("your previous turn was cut off")
    expect(input).toContain("Before repeating any action, check the current state")
    expect(input).not.toContain(continuationMarkers.app_restart)
  } finally {
    await f.close()
  }
}, 30_000)

test("a turn interrupted by quitting touri is continued when it reopens", async () => {
  const f = await fixture()
  try {
    const original = f.send(f.first.engine)
    await waitFor(f.streamed("INÍCIO"))
    await f.first.engine.shutdown()
    expect(f.runs()[0]).toMatchObject({ status: "interrupted", error_class: "app_restart" })
    f.writeScenario({ deltas: ["Retomei."] })
    await f.open()
    await waitFor(() => f.runs().some((run) => run.id !== original.id && run.status === "succeeded"))
    expect(f.links()).toEqual([expect.objectContaining({ original_run_id: original.id, reason: "app_restart" })])
    // Reopening again does not continue the same turn twice.
    await f.open()
    await Bun.sleep(200)
    expect(f.runs()).toHaveLength(2)
  } finally {
    await f.close()
  }
}, 30_000)

test("a provider that exits mid-turn is resumed once after a short backoff", async () => {
  const f = await fixture()
  try {
    f.writeScenario({ deltas: ["Retomado depois da falha."] })
    f.crashOnce()
    const original = f.send(f.first.engine)
    await waitFor(() => f.runs().some((run) => run.status === "succeeded"))
    const [crashed, continuation] = f.runs()
    expect(crashed).toMatchObject({ id: original.id, status: "failed", error_class: "cli_crash" })
    expect(continuation).toMatchObject({ status: "succeeded", trigger: "retry" })
    expect(f.links()).toEqual([expect.objectContaining({ run_id: continuation?.id, reason: "provider_crash" })])
    expect(f.markers().map((marker) => marker.text)).toEqual([continuationMarkers.provider_crash])
    expect(f.frames().filter((frame) => frame.method === "thread/resume")).toHaveLength(1)
    const notifications = f.first.db.query("SELECT kind FROM notifications").all() as Array<{ kind: string }>
    expect(notifications.map((row) => row.kind)).not.toContain("turn-failed")
  } finally {
    await f.close()
  }
}, 30_000)

test("a provider that keeps crashing is resumed only once", async () => {
  const f = await fixture()
  try {
    f.writeScenario({ crashAt: 2, deltas: ["parcial ", "perdido"] })
    f.send(f.first.engine)
    await waitFor(() => f.runs().length === 2 && f.runs().every((run) => run.status === "failed"))
    await Bun.sleep(300)
    expect(f.runs().map((run) => run.error_class)).toEqual(["cli_crash", "cli_crash"])
    expect(f.links()).toHaveLength(1)
  } finally {
    await f.close()
  }
}, 30_000)

test("a canceled turn is not resumed", async () => {
  const f = await fixture()
  try {
    const run = f.send(f.first.engine)
    await waitFor(f.streamed("INÍCIO"))
    f.first.engine.cancel(run.id)
    await waitFor(() => f.runs()[0]?.status === "canceled")
    await Bun.sleep(300)
    expect(f.runs()).toHaveLength(1)
    expect(f.markers()).toEqual([])
  } finally {
    await f.close()
  }
}, 30_000)

test("uncertain work effects block the automatic continuation", async () => {
  const f = await fixture()
  try {
    const run = f.send(f.first.engine)
    await waitFor(f.streamed("INÍCIO"))
    const work = createWorkState({ database: f.first.db })
    work.beginEffect({ turnId: run.id, threadId: "t", key: "process:web", description: "web", effectId: "effect-1" })
    work.recover({ observe: () => ({ kind: "unobservable", reason: "exit not observed before restart" }) })
    await f.open()
    await Bun.sleep(300)
    expect(f.runs()).toEqual([expect.objectContaining({ id: run.id, status: "interrupted" })])
    expect(f.markers()).toEqual([])
  } finally {
    await f.close()
  }
}, 30_000)

test("at most two continuations follow one original turn", async () => {
  const f = await fixture()
  try {
    const original = f.send(f.first.engine)
    await waitFor(f.streamed("INÍCIO"))
    for (const attempt of [1, 2]) {
      rmSync(join(f.assets, "release"), { force: true })
      await f.open()
      await waitFor(() => f.runs().length === attempt + 1 && f.runs().at(-1)?.status === "running")
    }
    await f.open()
    await Bun.sleep(300)
    expect(f.runs().map((run) => run.status)).toEqual(["interrupted", "interrupted", "interrupted"])
    expect(f.links().map((link) => [link.original_run_id, link.reason])).toEqual([
      [original.id, "app_restart"],
      [original.id, "app_restart"],
    ])
    expect(f.links()[1]?.previous_run_id).toBe(f.links()[0]?.run_id)
  } finally {
    f.release()
    await f.close()
  }
}, 30_000)

test("turning the setting off keeps the interrupted turn waiting for the user", async () => {
  const f = await fixture()
  try {
    f.disableResume()
    f.writeScenario({ deltas: ["não deveria rodar"] })
    f.crashOnce()
    f.send(f.first.engine)
    await waitFor(() => f.runs()[0]?.status === "failed")
    await Bun.sleep(300)
    f.writeScenario(PAUSED)
    rmSync(join(f.assets, "release"), { force: true })
    const paused = f.send(f.first.engine, "Outra tarefa")
    await waitFor(f.streamed("INÍCIO"))
    await f.open()
    await Bun.sleep(300)
    expect(f.runs().map((run) => [run.status, run.error_class])).toEqual([
      ["failed", "cli_crash"],
      ["interrupted", "app_restart"],
    ])
    expect(f.runs()[1]?.id).toBe(paused.id)
    expect(f.links()).toEqual([])
    expect(f.markers()).toEqual([])
  } finally {
    f.release()
    await f.close()
  }
}, 30_000)

test("a routine interrupted by a restart continues within its timeout instead of being canceled", async () => {
  const f = await fixture()
  try {
    const created = f.first.engine.createRoutine({
      input: {
        botId: "b",
        name: "Rotina longa",
        prompt: "Faça o relatório",
        cron: "0 9 * * *",
        timezone: "America/Sao_Paulo",
        enabled: false,
        continuity: "main-thread",
        resultsThreadId: "t",
        timeoutMinutes: 30,
        overlap: "skip",
        catchUpMinutes: 30,
      },
      forceDisabled: true,
    })
    if (!created.success) throw new Error(created.error)
    f.first.db.exec("UPDATE bots SET main_thread_id = 't' WHERE id = 'b'")
    const started = f.first.engine.runRoutine({ routineId: created.routine.id, triggerSource: "manual" })
    if (!started.success) throw new Error(started.error)
    await waitFor(f.streamed("INÍCIO"))
    f.writeScenario({ deltas: ["Relatório pronto."] })
    await f.open()
    const routineRun = () =>
      f.first.db.query("SELECT status, run_id FROM routine_runs WHERE id = ?").get(started.routineRun.id) as {
        status: string
        run_id: string
      }
    await waitFor(() => routineRun().status === "succeeded")
    const [interrupted, continuation] = f.runs()
    expect(interrupted).toMatchObject({ status: "interrupted", error_class: "app_restart" })
    expect(continuation).toMatchObject({ status: "succeeded", trigger: "routine" })
    expect(routineRun().run_id).toBe(continuation?.id ?? "")
  } finally {
    await f.close()
  }
}, 30_000)

test("deleting a routine during crash backoff prevents its automatic continuation", async () => {
  const f = await fixture({ resumeBackoffMs: 500 })
  try {
    f.writeScenario({ events: [{ type: "complete" }] })
    f.crashOnce()
    const created = f.first.engine.createRoutine({
      forceDisabled: false,
      input: {
        botId: "b",
        name: "Notes",
        prompt: "Summarize notes",
        cron: "0 9 * * *",
        timezone: "UTC",
        enabled: true,
        continuity: "main-thread",
        resultsThreadId: null,
        timeoutMinutes: 30,
        overlap: "queue",
        catchUpMinutes: 30,
      },
    })
    if (!created.success) throw new Error(created.error)
    f.first.db.exec("UPDATE bots SET main_thread_id = 't' WHERE id = 'b'")
    const started = f.first.engine.runRoutine({ routineId: created.routine.id, triggerSource: "manual" })
    if (!started.success) throw new Error(started.error)
    await waitFor(() => f.runs()[0]?.status === "failed")
    expect(f.first.engine.deleteRoutine(created.routine.id).success).toBe(true)
    await Bun.sleep(700)
    expect(f.runs()).toHaveLength(1)
    expect(f.links()).toHaveLength(0)
    expect(f.first.engine.listRoutines()).toEqual([])
  } finally {
    await f.close()
  }
})

test("a routine past its timeout is canceled after a restart, as before", async () => {
  const f = await fixture()
  try {
    const created = f.first.engine.createRoutine({
      input: {
        botId: "b",
        name: "Rotina curta",
        prompt: "Faça o relatório",
        cron: "0 9 * * *",
        timezone: "America/Sao_Paulo",
        enabled: false,
        continuity: "main-thread",
        resultsThreadId: "t",
        timeoutMinutes: 1,
        overlap: "skip",
        catchUpMinutes: 30,
      },
      forceDisabled: true,
    })
    if (!created.success) throw new Error(created.error)
    f.first.db.exec("UPDATE bots SET main_thread_id = 't' WHERE id = 'b'")
    const started = f.first.engine.runRoutine({ routineId: created.routine.id, triggerSource: "manual" })
    if (!started.success) throw new Error(started.error)
    await waitFor(f.streamed("INÍCIO"))
    f.first.db
      .query("UPDATE routine_runs SET started_at = ? WHERE id = ?")
      .run(Date.now() - 2 * 60_000, started.routineRun.id)
    await f.open()
    await Bun.sleep(300)
    expect(f.runs()).toHaveLength(1)
    expect(
      f.first.db.query("SELECT status FROM routine_runs WHERE id = ?").get(started.routineRun.id) as { status: string },
    ).toEqual({ status: "canceled" })
  } finally {
    f.release()
    await f.close()
  }
}, 30_000)
