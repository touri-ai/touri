import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, Routine, RoutineRun } from "@touri/contracts"
import { createGroupStore } from "../../src/groups/store"
import { createKernel } from "../../src/kernel"
import { bindDeviceSession } from "../../src/kernel/device-session"
import { createNotificationStore } from "../../src/notify/store"
import { init as initRuntime, isScriptOwner } from "../../src/runtime"
import { createRuntimeEngine } from "../../src/runtime/engine"
import { createRuntimePersistence } from "../../src/runtime/persistence"
import { createScriptRoutines, executeScript } from "../../src/runtime/routines/scripts"
import { init as initStore } from "../../src/store"

const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  for (const close of cleanups) await close()
  cleanups.clear()
})

test.each([
  ["printf completed", "done"],
  ["printf ''", null],
  ["printf '  [SILENT]\\n'", null],
  ["printf bad >&2; exit 7", "routine-failed"],
] as const)("notifies script results without a model run: %s", async (command, kind) => {
  const fixture = await makeFixture(command)
  const notifications = createNotificationStore({ db: fixture.db })
  fixture.runtime.kernel.services.provide("notify.emit", (input) => notifications.insert(input).notification)
  const finished = fixture.finished()

  fixture.engine.runRoutine({ routineId: fixture.routine.id, triggerSource: "manual" })
  const run = await finished

  const recorded = notifications.recent(10)
  expect(recorded.map((notification) => notification.kind)).toEqual(kind ? [kind] : [])
  if (kind) expect(recorded[0]?.threadId).toBe(run.threadId)
  if (kind === "routine-failed") expect(notifications.byRequestId(`recovery:routine:${run.id}`)?.kind).toBe(kind)
})

test.each(["printf 'completed'", "printf ''", "printf '  [SILENT]\\n'", "printf 'bad' >&2; exit 7"])(
  "script runs without a provider and applies output rules: %s",
  async (command) => {
    const fixture = await makeFixture(command)
    const finished = fixture.finished()

    const result = fixture.engine.runRoutine({ routineId: fixture.routine.id, triggerSource: "manual" })
    expect(result.success).toBe(true)
    const run = await finished

    expect(run.runId).toBeNull()
    expect(fixture.db.query("SELECT id FROM runs").all()).toEqual([])
    const messages = fixture.db.query("SELECT role,text,sender_json FROM messages WHERE role='assistant'").all() as {
      text: string
      sender_json: string
    }[]
    if (command.includes("exit 7")) {
      expect(run.status).toBe("failed")
      expect(messages[0]?.text).toContain("exit 7")
      expect(messages[0]?.text).toContain("bad")
    } else {
      expect(run.status).toBe("succeeded")
      expect(messages.map((message) => message.text)).toEqual(command.includes("completed") ? ["completed"] : [])
    }
    expect(createRuntimePersistence({ database: fixture.db }).getRoutine(fixture.routine.id)).toMatchObject({
      kind: "script",
      command,
    })
  },
)

test("env file values are loaded at execution time and sensitive values are redacted", async () => {
  const fixture = await makeFixture('printf "%s %s" "$GREETING" "$API_TOKEN"')
  const envFile = join(fixture.root, "example.env")
  await writeFile(envFile, 'GREETING="hello world"\nAPI_TOKEN=synthetic-credential\n')
  fixture.engine.updateRoutine({ routineId: fixture.routine.id, patch: { envFile }, fromTool: false })
  const finished = fixture.finished()

  fixture.engine.runRoutine({ routineId: fixture.routine.id, triggerSource: "manual" })
  const run = await finished

  expect(run.status).toBe("succeeded")
  expect(fixture.db.query("SELECT text FROM messages WHERE role='assistant'").get()).toEqual({
    text: "hello world [REDACTED]",
  })
  expect(JSON.stringify(fixture.engine.listRoutines())).not.toContain("synthetic-credential")
})

test.each([
  ["stdout", "printf '%65524s' ''; printf '%s' \"$API_TOKEN\""],
  ["stderr", "printf '%s' \"$API_TOKEN\" >&2; printf '%4084s' '' >&2; exit 7"],
] as const)("redacts credentials before truncating %s", async (_pipe, command) => {
  const fixture = await makeFixture(command)
  const envFile = join(fixture.root, "example.env")
  await writeFile(envFile, "API_TOKEN=example-sensitive-credential\n")
  fixture.engine.updateRoutine({ routineId: fixture.routine.id, patch: { envFile }, fromTool: false })
  const finished = fixture.finished()

  fixture.engine.runRoutine({ routineId: fixture.routine.id, triggerSource: "manual" })
  const run = await finished

  const messages = fixture.db.query("SELECT text FROM messages WHERE role='assistant'").all()
  const stored = JSON.stringify({ messages, summary: run.summary })
  expect(stored).not.toContain("example-sens")
  expect(stored).not.toContain("e-credential")
})

test("agents cannot create, convert or edit script routines", async () => {
  const fixture = await makeFixture("printf ready")

  expect(fixture.engine.createRoutine({ input: fixture.routine, forceDisabled: true }).success).toBe(false)
  expect(
    fixture.engine.updateRoutine({
      routineId: fixture.routine.id,
      patch: { command: "printf changed" },
      fromTool: true,
      botId: fixture.bot.id,
    }).success,
  ).toBe(false)

  expect(fixture.engine.listRoutines()[0]?.command).toBe("printf ready")
})

test("changing groupId clears the previous resultsThreadId without a generic validation failure", async () => {
  const fixture = await makeFixture("printf ready")
  const store = fixture.runtime.kernel.services.use("store.api")
  const thread = store?.createThread({ botId: fixture.bot.id, kind: "chat", title: "Old result" })
  if (!thread?.success) throw new Error("Missing thread")
  fixture.engine.updateRoutine({
    routineId: fixture.routine.id,
    patch: { kind: "bot", groupId: null, resultsThreadId: thread.thread.id },
    fromTool: false,
  })

  const changed = fixture.engine.updateRoutine({
    routineId: fixture.routine.id,
    patch: { groupId: fixture.group.id },
    fromTool: false,
  })

  expect(changed).toMatchObject({ success: true, routine: { groupId: fixture.group.id, resultsThreadId: null } })
})

test("drains both pipes and retains a bounded stderr tail", async () => {
  const fixture = await makeFixture("printf ready; sleep 30")
  const controller = new AbortController()
  const killed: string[] = []
  const result = executeScript(
    {
      spawnTree: () => ({
        success: true,
        pid: 1,
        pgid: 1,
        stdout: new ReadableStream({
          start(stream) {
            stream.enqueue(new TextEncoder().encode("ready"))
            stream.close()
          },
        }),
        stderr: new ReadableStream({
          start(stream) {
            stream.enqueue(new TextEncoder().encode(`${"x".repeat(8000)}tail`))
            stream.close()
          },
        }),
        stdin: new WritableStream(),
        extra: [],
        exited: Promise.resolve({ code: 0, signal: null }),
        kill: (signal) => {
          killed.push(signal)
        },
      }),
    },
    fixture.routine,
    controller.signal,
  )

  const output = await result

  expect(killed).toContain("SIGKILL")
  expect(output.stderr.length).toBe(4096)
  expect(output.stderr.endsWith("tail")).toBe(true)
})

test("restart marks interrupted script executions failed without replaying commands", async () => {
  const fixture = await makeFixture("printf ready")
  const persistence = createRuntimePersistence({ database: fixture.db })
  persistence.updateRoutine({ ...fixture.routine, enabled: true })
  persistence.insertRoutineRun({
    id: "interrupted",
    routineId: fixture.routine.id,
    scheduledFor: 1000,
    status: "running",
    threadId: null,
    runId: null,
    triggerSource: "cron",
    summary: null,
    startedAt: 1000,
    finishedAt: null,
  })

  const scripts = createScriptRoutines({ kernel: fixture.runtime.kernel, persistence })

  expect(persistence.getRoutineRun("interrupted")).toMatchObject({ status: "failed" })
  expect(scripts.hasWork()).toBe(false)
  expect(persistence.getRoutine(fixture.routine.id)?.enabled).toBe(false)
})

const makeFixture = async (command: string) => {
  const root = await mkdtemp(join(tmpdir(), "touri-script-test-"))
  const runtime = createKernel({ appData: root })
  await initStore(runtime.kernel)
  const response = await fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1/bots`, {
    method: "POST",
    headers: {
      Authorization: "Bearer dev-ui-token",
      "Content-Type": "application/json",
      "x-touri-client": "routine-test",
    },
    body: JSON.stringify({ name: "Script QA", provider: "codex", machine: "local" }),
  })
  expect(response.status).toBe(201)
  const { bot } = (await response.json()) as { bot: Bot }
  const group = createGroupStore(runtime.kernel).save({
    name: "Reports",
    color: "blue",
    avatarShape: "cercle",
    memberIds: [bot.id],
    coordinatorBotId: null,
  })
  const engine = createRuntimeEngine({ kernel: runtime.kernel })
  await engine.ready
  cleanups.add(async () => {
    await engine.shutdown()
    runtime.stop()
    await rm(root, { recursive: true, force: true })
  })
  const created = engine.createRoutine({
    input: {
      botId: bot.id,
      kind: "script",
      command,
      cwd: root,
      envFile: null,
      name: "Script QA",
      prompt: "",
      cron: "*/5 * * * *",
      timezone: "UTC",
      enabled: false,
      continuity: "results-thread",
      groupId: group.id,
      resultsThreadId: null,
      timeoutMinutes: 1,
      overlap: "skip",
      catchUpMinutes: 30,
    },
    forceDisabled: false,
  })
  if (!created.success) throw new Error(created.error)
  const finished = () =>
    new Promise<RoutineRun>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe()
        reject(new Error("Script did not finish"))
      }, 5000)
      const unsubscribe = runtime.kernel.subscribe(({ event }) => {
        if (event.type !== "routine.updated" || event.routine.id !== created.routine.id || !event.lastRun?.finishedAt)
          return
        clearTimeout(timeout)
        unsubscribe()
        resolve(event.lastRun)
      })
    })
  return { root, runtime, engine, bot, group, routine: created.routine, finished, db: runtime.kernel.db as Database }
}

test.each(["owner", "other-admin", "member"])(
  "script routes authorize the owner identity, not merely admin role: %s",
  (id) => {
    const signal = new AbortController().signal
    bindDeviceSession(signal, {
      deviceId: "synthetic-device",
      active: () => true,
      person: { id, role: id === "member" ? "member" : "admin", name: "Example", email: null, avatarSeed: "example" },
    })

    expect(isScriptOwner(signal)).toBe(id === "owner")
  },
)

test.each(["skip", "queue"] as const)("script overlap %s keeps concurrent slots serialized", async (overlap) => {
  const fixture = await makeFixture("while [ ! -f release ]; do sleep 0.01; done; printf complete")
  fixture.engine.updateRoutine({ routineId: fixture.routine.id, patch: { enabled: true, overlap }, fromTool: false })
  const firstFinished = fixture.finished()

  const first = fixture.engine.runRoutine({ routineId: fixture.routine.id, triggerSource: "cron", scheduledFor: 1000 })
  const second = fixture.engine.runRoutine({ routineId: fixture.routine.id, triggerSource: "cron", scheduledFor: 2000 })
  expect(first.success).toBe(true)
  expect(second.success).toBe(true)
  expect(fixture.engine.listRoutineRuns(fixture.routine.id).find((run) => run.scheduledFor === 2000)?.status).toBe(
    overlap === "skip" ? "skipped" : "scheduled",
  )
  await writeFile(join(fixture.root, "release"), "ready")
  await firstFinished
  await fixture.engine.waitForDrain()

  const runs = fixture.engine.listRoutineRuns(fixture.routine.id)
  expect(runs.filter((run) => run.status === "succeeded")).toHaveLength(overlap === "skip" ? 1 : 2)
  expect(fixture.db.query("SELECT id FROM runs").all()).toEqual([])
})

test("HTTP script creation needs no bot or prompt and channel PATCH clears a stale conversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-script-api-"))
  const runtime = createKernel({ appData: root })
  cleanups.add(async () => {
    await runtime.kernel.services.use("runtime.shutdown")?.()
    runtime.stop()
    await rm(root, { recursive: true, force: true })
  })
  await initStore(runtime.kernel)
  await initRuntime(runtime.kernel)
  const request = (method: string, path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1${path}`, {
      method,
      headers: {
        Authorization: "Bearer dev-ui-token",
        "Content-Type": "application/json",
        "x-touri-client": "routine-test",
      },
      body: JSON.stringify(body),
    })
  const { bot } = (await (
    await request("POST", "/bots", { name: "Script API", provider: "codex", machine: "local" })
  ).json()) as { bot: Bot }
  const groups = createGroupStore(runtime.kernel)
  const group = groups.save({
    name: "API reports",
    color: "blue",
    avatarShape: "cercle",
    memberIds: [bot.id],
    coordinatorBotId: null,
  })

  const response = await request("POST", "/routines", {
    kind: "script",
    command: "printf result",
    cwd: root,
    groupId: group.id,
    name: "API script",
    cron: "*/5 * * * *",
    timezone: "UTC",
  })
  expect(response.status).toBe(201)
  const { routine } = (await response.json()) as { routine: Routine }
  const store = runtime.kernel.services.use("store.api")
  const oldThread = store?.createThread({ botId: bot.id, kind: "chat", title: "Old destination" })
  if (!oldThread?.success) throw new Error("Missing thread")
  const botRoutine = await request("POST", "/routines", {
    botId: bot.id,
    name: "Bot routine",
    prompt: "Report",
    cron: "0 9 * * *",
    timezone: "UTC",
    resultsThreadId: oldThread.thread.id,
  })
  const previous = (await botRoutine.json()) as { routine: Routine }
  const changed = await request("PATCH", `/routines/${previous.routine.id}`, { groupId: group.id })

  expect(routine).toMatchObject({ kind: "script", botId: bot.id, prompt: "", command: "printf result" })
  expect(changed.status).toBe(200)
  expect(await changed.json()).toMatchObject({ routine: { groupId: group.id, resultsThreadId: null } })
  expect((await request("POST", `/routines/${routine.id}/run`, {})).status).toBe(201)
})

test("script deadline stops a real child and publishes the timeout failure", async () => {
  const fixture = await makeFixture("sleep 30; printf late")
  const persistence = createRuntimePersistence({ database: fixture.db })
  const scripts = createScriptRoutines({ kernel: fixture.runtime.kernel, persistence, getTimeoutMs: () => 30 })
  const slot: RoutineRun = {
    id: "deadline-slot",
    routineId: fixture.routine.id,
    scheduledFor: 1000,
    status: "scheduled",
    threadId: null,
    runId: null,
    triggerSource: "cron",
    summary: null,
    startedAt: null,
    finishedAt: null,
  }
  persistence.insertRoutineRun(slot)
  const finished = fixture.finished()

  scripts.start(fixture.routine, slot)
  const run = await finished
  await scripts.wait()

  expect(run.status).toBe("failed")
  expect(run.summary).toContain("tempo esgotado")
  expect(fixture.db.query("SELECT text FROM messages WHERE role='assistant'").get()).toMatchObject({
    text: expect.stringContaining("tempo esgotado"),
  })
  expect(scripts.hasWork()).toBe(false)
})

test("script catch-up uses the shared scheduler and does not start a model run", async () => {
  const fixture = await makeFixture("printf caught-up")
  const now = Date.now()
  fixture.engine.updateRoutine({
    routineId: fixture.routine.id,
    patch: { enabled: true },
    fromTool: false,
  })
  fixture.engine.updateRoutine({ routineId: fixture.routine.id, patch: { nextRunAt: now - 30_000 }, fromTool: false })
  const finished = fixture.finished()

  await fixture.engine.tick(now)
  const run = await finished
  await fixture.engine.tick(now)

  expect(run).toMatchObject({ triggerSource: "catch-up", status: "succeeded", runId: null })
  expect(fixture.engine.listRoutineRuns(fixture.routine.id)).toHaveLength(1)
  expect(fixture.db.query("SELECT id FROM runs").all()).toEqual([])
})

test("abort cancels output pipes which remain open after the shell exits", async () => {
  const fixture = await makeFixture("printf ready")
  const controller = new AbortController()
  const canceled: string[] = []
  const stream = (name: string) =>
    new ReadableStream<Uint8Array>({
      cancel() {
        canceled.push(name)
      },
    })
  const result = executeScript(
    {
      spawnTree: () => ({
        success: true,
        pid: 1,
        pgid: 1,
        stdout: stream("stdout"),
        stderr: stream("stderr"),
        stdin: new WritableStream(),
        extra: [],
        exited: Promise.resolve({ code: 0, signal: null }),
        kill: () => {},
      }),
    },
    fixture.routine,
    controller.signal,
  )

  controller.abort()
  await result

  expect(canceled).toHaveLength(2)
  expect(canceled).toEqual(expect.arrayContaining(["stderr", "stdout"]))
})
