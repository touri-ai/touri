import { Database } from "bun:sqlite"
import { afterEach, expect, mock, setDefaultTimeout, test } from "bun:test"
import type { ProviderAdapter, RunErrorClass, StartTurnArgs, StartTurnResult } from "@touri/contracts"
import { createGroupRuntime } from "../../src/groups/runtime"
import { createGroupStore } from "../../src/groups/store"
import { canAutomaticallyResumeFailure, hasUnsafeResumeActions } from "../../src/runtime/automatic-resume"
import { createRuntimeEngine } from "../../src/runtime/engine"
import { init as initStore } from "../../src/store"
import { testKernel } from "../kernel/test-kernel"

setDefaultTimeout(15_000)

const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  for (const cleanup of [...cleanups].reverse()) await cleanup()
  cleanups.clear()
})

const waitFor = async (predicate: () => boolean, getCheckpoint?: () => unknown): Promise<void> => {
  const deadline = Date.now() + 10_000
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error(`Recovery did not reach its checkpoint: ${JSON.stringify(getCheckpoint?.())}`)
    await Bun.sleep(5)
  }
}

const makeFixture = async (
  errors: RunErrorClass[],
  diagnostic = "Provider interrupted",
  backoff = 150,
  action?: "approval" | "completed_action",
) => {
  const fixture = testKernel()
  await initStore(fixture.kernel)
  fixture.db
    .query("INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('b','Demo','codex',?,1,1)")
    .run(fixture.kernel.paths.appData)
  fixture.db.exec("INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('t','b','Demo',1,1)")
  const store = fixture.kernel.services.use("store.api")
  if (!store) throw new Error("Missing store")
  const request = store.insertMessage({
    message: {
      id: "request",
      threadId: "t",
      parentId: null,
      role: "user",
      kind: "text",
      status: "complete",
      runId: null,
      text: "Termine o relatório sem repetir as ações concluídas.",
      parts: [],
      sender: null,
      source: "local",
    },
  })
  if (!request.success) throw new Error(request.error)
  const startTurn = mock(async (args: StartTurnArgs): Promise<StartTurnResult> => {
    const index = startTurn.mock.calls.length - 1
    args.onEvent({ type: "session", externalSessionId: "demo-session", rolloutPath: null })
    args.onEvent({ type: "turn_started", externalTurnId: `turn-${index}` })
    args.onEvent({ type: "text_delta", itemId: `reply-${index}`, delta: `Etapa ${index}.` })
    if (index === 0 && action === "approval")
      args.onEvent({
        type: "approval_request",
        approvalId: "consent",
        part: {
          type: "approval",
          approvalId: "consent",
          botId: "b",
          request: "permission",
          detail: "Ação sintética",
          decision: "pending",
          createdAt: Date.now(),
        },
      })
    if (index === 0 && action === "completed_action")
      args.onEvent({
        type: "item",
        part: {
          type: "tool_call",
          callId: "completed",
          tool: "Read",
          summary: "Leitura concluída",
          inputJson: "{}",
          outputJson: "{}",
          ok: true,
        },
      })
    const error = errors[index]
    if (error) return { success: false, errorCode: error, error: diagnostic }
    return { success: true, externalSessionId: "demo-session", rolloutPath: null, status: "succeeded" }
  })
  const adapter: ProviderAdapter = {
    provider: "codex",
    startTurn,
    detect: async () => ({ success: true, path: "/tmp/demo-provider", version: "1", loggedIn: true }),
    answerApproval: async () => ({ success: true }),
    shutdown: async () => {},
  }
  const open = () =>
    createRuntimeEngine({
      kernel: fixture.kernel,
      providerAdapters: { codex: adapter },
      environment: { PATH: "/usr/bin" },
      resumeBackoffMs: backoff,
    })
  const engine = open()
  const engines = new Set([engine])
  cleanups.add(async () => {
    for (const instance of engines) await instance.shutdown()
    fixture.close()
  })
  const restart = () => {
    const next = open()
    engines.add(next)
    return next
  }
  return { ...fixture, engine, restart, startTurn, store }
}

const send = (engine: ReturnType<typeof createRuntimeEngine>) => {
  const result = engine.enqueue({
    threadId: "t",
    requestMessageId: "request",
    trigger: "user",
    requesterPersonId: "demo-person",
  })
  if (!result.success) throw new Error(result.error)
  return result.run
}

const makeChannelFixture = async (backoff = 1_500) => {
  const fixture = await makeFixture(["timeout", "timeout"], undefined, backoff)
  await fixture.engine.ready
  const data = createGroupStore(fixture.kernel)
  const group = data.save({
    name: "Relatórios",
    color: "#dc2626",
    avatarShape: "classic-none",
    memberIds: ["b"],
    coordinatorBotId: null,
  })
  const thread = data.createThread(group)
  const request = fixture.store.insertMessage({
    message: {
      id: "channel-durable-request",
      threadId: thread.id,
      parentId: null,
      role: "user",
      kind: "text",
      status: "complete",
      runId: null,
      text: "@Demo termine o relatório",
      parts: [],
      sender: { id: "demo-person", name: "Pessoa Demo", kind: "person" },
      source: "local",
    },
  })
  if (!request.success) throw new Error(request.error)
  const openGroups = (engine: ReturnType<typeof createRuntimeEngine>) => {
    const groups = createGroupRuntime(fixture.kernel, engine, undefined, backoff)
    fixture.kernel.services.provide("groups.runtime", groups)
    cleanups.add(async () => {
      groups.shutdown()
      await groups.waitForDrain()
    })
    return groups
  }
  const groups = openGroups(fixture.engine)
  const result = groups.enqueue({ threadId: thread.id, requestMessageId: request.message.id, trigger: "user" })
  if (!result.success) throw new Error(result.error)

  return { ...fixture, groups, openGroups, run: result.run, thread }
}

test("timeouts resume immediately, then once after the backoff, on the original thread", async () => {
  const fixture = await makeFixture(["timeout", "timeout"])
  const original = send(fixture.engine)

  await waitFor(() => fixture.startTurn.mock.calls.length === 2 && fixture.engine.listRuns("t")[0]?.status === "failed")
  const pending = fixture.engine.listRuns("t")[0]
  if (!pending) throw new Error("Missing continuation")
  expect(fixture.engine.getRunSnapshot(pending).automaticResumePending).toBe(true)
  expect(
    fixture.db
      .query("SELECT due_at - ? AS remaining FROM automatic_resume_jobs WHERE run_id = ?")
      .get(Date.now(), pending.id),
  ).toMatchObject({ remaining: expect.any(Number) })
  await Bun.sleep(30)
  expect(fixture.startTurn).toHaveBeenCalledTimes(2)
  await waitFor(() => fixture.engine.listRuns("t")[0]?.status === "succeeded")

  expect(fixture.startTurn).toHaveBeenCalledTimes(3)
  expect(fixture.db.query("SELECT DISTINCT original_run_id FROM run_continuations").all()).toEqual([
    { original_run_id: original.id },
  ])
  expect(fixture.db.query("SELECT DISTINCT thread_id FROM runs").all()).toEqual([{ thread_id: "t" }])
  expect(JSON.stringify(fixture.startTurn.mock.calls[1]?.[0].input)).toContain(
    "do not redo steps that already took effect",
  )
})

test("a repeatedly failing provider stops after exactly two automatic attempts", async () => {
  const fixture = await makeFixture(["cli_crash", "cli_crash", "cli_crash"])
  send(fixture.engine)

  await waitFor(() => fixture.startTurn.mock.calls.length === 3 && fixture.engine.listRuns("t")[0]?.status === "failed")
  await Bun.sleep(200)

  expect(fixture.startTurn).toHaveBeenCalledTimes(3)
  const latest = fixture.engine.listRuns("t")[0]
  if (!latest) throw new Error("Missing final attempt")
  expect(fixture.engine.getRunSnapshot(latest).automaticResumePending).toBe(false)
})

test.each(["cli_auth", "tool_error", "canceled"] as const)("%s never resumes automatically", async (error) => {
  const fixture = await makeFixture([error])
  send(fixture.engine)

  await waitFor(() => ["failed", "canceled"].includes(fixture.engine.listRuns("t")[0]?.status ?? ""))
  await Bun.sleep(200)

  expect(fixture.startTurn).toHaveBeenCalledTimes(1)
})

test("a permission error reported as a provider crash never resumes", async () => {
  const fixture = await makeFixture(["cli_crash"], "EACCES: permission denied")
  send(fixture.engine)

  await waitFor(() => fixture.engine.listRuns("t")[0]?.status === "failed")
  await Bun.sleep(200)

  expect(fixture.startTurn).toHaveBeenCalledTimes(1)
})

test.each(["current", "original"] as const)(
  "Stop on the %s run during backoff prevents recovery after restart",
  async (target) => {
    const fixture = await makeFixture(["timeout", "timeout"], undefined, 1_000)
    const original = send(fixture.engine)
    await waitFor(
      () => fixture.startTurn.mock.calls.length === 2 && fixture.engine.listRuns("t")[0]?.status === "failed",
    )
    const pending = fixture.engine.listRuns("t")[0]
    if (!pending) throw new Error("Missing retry")

    fixture.engine.cancel(target === "original" ? original.id : pending.id)
    await fixture.engine.shutdown()
    const restarted = fixture.restart()
    await restarted.ready
    await Bun.sleep(200)

    expect(fixture.startTurn).toHaveBeenCalledTimes(2)
    expect(restarted.listRuns("t")[0]?.status).toBe("failed")
    expect(fixture.db.query("SELECT state FROM automatic_resume_jobs WHERE run_id = ?").get(pending.id)).toEqual({
      state: "abandoned",
    })
  },
)

test("restart preserves a pending retry's deadline and starts only one continuation", async () => {
  const fixture = await makeFixture(["timeout", "timeout"], undefined, 500)
  send(fixture.engine)
  await waitFor(() => fixture.startTurn.mock.calls.length === 2 && fixture.engine.listRuns("t")[0]?.status === "failed")
  const pending = fixture.engine.listRuns("t")[0]
  if (!pending) throw new Error("Missing retry")
  const job = fixture.db.query("SELECT due_at FROM automatic_resume_jobs WHERE run_id = ?").get(pending.id)

  const restarted = fixture.restart()
  await restarted.ready
  await Bun.sleep(30)

  expect(fixture.startTurn).toHaveBeenCalledTimes(2)
  expect(fixture.db.query("SELECT due_at FROM automatic_resume_jobs WHERE run_id = ?").get(pending.id)).toEqual(job)
  await waitFor(() => restarted.listRuns("t")[0]?.status === "succeeded")
  expect(fixture.startTurn).toHaveBeenCalledTimes(3)
  expect(
    fixture.db.query("SELECT COUNT(*) AS count FROM run_continuations WHERE previous_run_id = ?").get(pending.id),
  ).toEqual({ count: 1 })
})

test("Stop during recovery yields to a competing writer and persists before shutdown", async () => {
  const fixture = await makeFixture(["timeout", "timeout"], undefined, 1_000)
  send(fixture.engine)
  await waitFor(() => fixture.startTurn.mock.calls.length === 2 && fixture.engine.listRuns("t")[0]?.status === "failed")
  const pending = fixture.engine.listRuns("t")[0]
  if (!pending) throw new Error("Missing retry")
  const writer = new Database(fixture.kernel.paths.db)
  cleanups.add(async () => writer.close())
  fixture.db.exec("PRAGMA busy_timeout = 100")
  writer.exec("BEGIN IMMEDIATE")
  const release = setTimeout(() => writer.exec("ROLLBACK"), 200)
  cleanups.add(async () => clearTimeout(release))

  const result = fixture.engine.cancel(pending.id)
  const snapshot = fixture.engine.getRunSnapshot(pending)
  await fixture.engine.shutdown()
  const restarted = fixture.restart()
  await restarted.ready
  await Bun.sleep(250)

  expect(result.success).toBe(true)
  expect(snapshot.automaticResumePending).toBe(false)
  expect(fixture.db.query("SELECT state FROM automatic_resume_jobs WHERE run_id = ?").get(pending.id)).toEqual({
    state: "abandoned",
  })
  expect(fixture.startTurn).toHaveBeenCalledTimes(2)
})

test.each(["ECONNRESET", "socket hang up", "fetch failed"])("transport interruption %s is retryable", (diagnostic) => {
  expect(canAutomaticallyResumeFailure("cli_protocol", diagnostic)).toBe(true)
  expect(canAutomaticallyResumeFailure("cli_auth", diagnostic)).toBe(false)
})

test("pending approval blocks a timeout continuation without granting consent", async () => {
  const fixture = await makeFixture(["timeout"], undefined, 150, "approval")
  send(fixture.engine)

  await waitFor(() => fixture.engine.listRuns("t")[0]?.status === "failed")
  await Bun.sleep(200)

  expect(fixture.startTurn).toHaveBeenCalledTimes(1)
  expect(fixture.db.query("SELECT * FROM run_continuations").all()).toEqual([])
  expect(
    fixture.store
      .activePath({ threadId: "t" })
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "approval")
      .every((part) => part.decision !== "approved"),
  ).toBe(true)
})

test("completed reads permit recovery with instructions to inspect state before repeating anything", async () => {
  const fixture = await makeFixture(["timeout"], undefined, 150, "completed_action")
  send(fixture.engine)

  await waitFor(() => fixture.engine.listRuns("t")[0]?.status === "succeeded")

  expect(fixture.startTurn).toHaveBeenCalledTimes(2)
  expect(JSON.stringify(fixture.startTurn.mock.calls[1]?.[0].input)).toContain(
    "do not redo steps that already took effect",
  )
})

test("a channel timeout resumes only its member once without the failed parent canceling recovery", async () => {
  const fixture = await makeFixture(["timeout"])
  await fixture.engine.ready
  const groups = createGroupRuntime(fixture.kernel, fixture.engine)
  fixture.kernel.services.provide("groups.runtime", groups)
  cleanups.add(async () => groups.shutdown())
  const data = createGroupStore(fixture.kernel)
  const group = data.save({
    name: "Relatórios",
    color: "#dc2626",
    avatarShape: "classic-none",
    memberIds: ["b"],
    coordinatorBotId: null,
  })
  const thread = data.createThread(group)
  const request = fixture.store.insertMessage({
    message: {
      id: "channel-request",
      threadId: thread.id,
      parentId: null,
      role: "user",
      kind: "text",
      status: "complete",
      runId: null,
      text: "@Demo termine o relatório",
      parts: [],
      sender: { id: "demo-person", name: "Pessoa Demo", kind: "person" },
      source: "local",
    },
  })
  if (!request.success) throw new Error(request.error)

  const result = groups.enqueue({ threadId: thread.id, requestMessageId: request.message.id, trigger: "user" })
  if (!result.success) throw new Error(result.error)
  await waitFor(
    () =>
      fixture.startTurn.mock.calls.length === 2 && groups.listRuns(thread.id).some((run) => run.status === "succeeded"),
  )
  await Bun.sleep(100)

  expect(fixture.startTurn).toHaveBeenCalledTimes(2)
  expect(fixture.db.query("SELECT COUNT(*) AS count FROM run_continuations").get()).toEqual({ count: 1 })
  expect(
    fixture.db.query("SELECT DISTINCT r.thread_id FROM runs r JOIN group_turns g ON g.run_id = r.id").all(),
  ).toEqual([{ thread_id: thread.id }])
  expect(fixture.db.query("SELECT state FROM automatic_resume_jobs").all()).toEqual([{ state: "started" }])
  expect(fixture.db.query("SELECT DISTINCT requester_person_id FROM runs WHERE trigger = 'retry'").all()).toEqual([
    { requester_person_id: "demo-person" },
  ])
})

test.each(["restart", "stop"] as const)("channel backoff survives %s without duplicate recovery", async (mode) => {
  const fixture = await makeChannelFixture()
  const getPending = () =>
    fixture.db.query("SELECT run_id, due_at FROM automatic_resume_jobs WHERE state='pending'").get() as {
      run_id: string
      due_at: number
    } | null
  await waitFor(() => fixture.startTurn.mock.calls.length === 2 && getPending() !== null)
  const pending = getPending()
  if (!pending) throw new Error("Missing channel recovery deadline")

  if (mode === "restart") fixture.groups.shutdown({ appRestart: true })
  else fixture.groups.cancel(fixture.run.id)
  await fixture.groups.waitForDrain()
  await fixture.engine.shutdown()
  const restarted = fixture.restart()
  await restarted.ready
  const groups = fixture.openGroups(restarted)
  await Bun.sleep(50)

  expect(fixture.db.query("SELECT due_at FROM automatic_resume_jobs WHERE run_id=?").get(pending.run_id)).toEqual({
    due_at: pending.due_at,
  })
  if (Date.now() < pending.due_at) expect(fixture.startTurn).toHaveBeenCalledTimes(2)
  if (mode === "restart") {
    await waitFor(() => groups.listRuns(fixture.thread.id).some((run) => run.status === "succeeded"))

    expect(fixture.startTurn).toHaveBeenCalledTimes(3)
    expect(
      fixture.db.query("SELECT COUNT(*) AS count FROM run_continuations WHERE previous_run_id=?").get(pending.run_id),
    ).toEqual({ count: 1 })
    return
  }
  await Bun.sleep(Math.max(0, pending.due_at - Date.now()) + 50)

  expect(fixture.startTurn).toHaveBeenCalledTimes(2)
  expect(fixture.db.query("SELECT state FROM automatic_resume_jobs WHERE run_id=?").get(pending.run_id)).toEqual({
    state: "abandoned",
  })
})

test("a new channel request starts without waiting for an older recovery deadline", async () => {
  const fixture = await makeChannelFixture(60_000)
  await waitFor(
    () =>
      fixture.startTurn.mock.calls.length === 2 &&
      !!fixture.db.query("SELECT 1 FROM automatic_resume_jobs WHERE state='pending'").get(),
  )
  const request = fixture.store.insertMessage({
    message: {
      id: "new-channel-request",
      threadId: fixture.thread.id,
      parentId: fixture.store.getThread({ threadId: fixture.thread.id })?.activeLeafId ?? null,
      role: "user",
      kind: "text",
      status: "complete",
      runId: null,
      text: "@Demo prepare o novo resumo",
      parts: [],
      sender: { id: "demo-person", name: "Pessoa Demo", kind: "person" },
      source: "local",
    },
  })
  if (!request.success) throw new Error(request.error)

  const next = fixture.groups.enqueue({
    threadId: fixture.thread.id,
    requestMessageId: request.message.id,
    trigger: "user",
  })
  if (!next.success) throw new Error(next.error)
  await waitFor(
    () => fixture.groups.listRuns(fixture.thread.id).find((run) => run.id === next.run.id)?.status === "succeeded",
  )

  expect(fixture.startTurn).toHaveBeenCalledTimes(3)
  expect(JSON.stringify(fixture.startTurn.mock.calls[2]?.[0].input)).toContain("novo resumo")
  expect(fixture.db.query("SELECT COUNT(*) AS count FROM automatic_resume_jobs WHERE state='pending'").get()).toEqual({
    count: 0,
  })
})

test("a channel routine recovery retains its routine run and original deadline", async () => {
  const fixture = await makeFixture(["timeout"])
  await fixture.engine.ready
  const groups = createGroupRuntime(fixture.kernel, fixture.engine)
  fixture.kernel.services.provide("groups.runtime", groups)
  cleanups.add(async () => groups.shutdown())
  const data = createGroupStore(fixture.kernel)
  const group = data.save({
    name: "Relatórios",
    color: "#dc2626",
    avatarShape: "classic-none",
    memberIds: ["b"],
    coordinatorBotId: null,
  })
  const thread = data.createThread(group)
  const routine = fixture.engine.createRoutine({
    forceDisabled: true,
    input: {
      botId: "b",
      name: "Relatório diário",
      prompt: "@Demo termine o relatório",
      cron: "0 9 * * *",
      timezone: "UTC",
      enabled: false,
      continuity: "results-thread",
      resultsThreadId: thread.id,
      groupId: group.id,
      timeoutMinutes: 30,
      overlap: "skip",
      catchUpMinutes: 30,
    },
  })
  if (!routine.success) throw new Error(routine.error)

  const result = fixture.engine.runRoutine({ routineId: routine.routine.id, triggerSource: "manual" })
  if (!result.success) throw new Error(result.error)
  await waitFor(
    () => fixture.engine.listRoutineRuns(routine.routine.id)[0]?.status === "succeeded",
    () => ({
      runs: fixture.db.query("SELECT id, status, routine_run_id, error_class FROM runs").all(),
      routines: fixture.db.query("SELECT id, status, run_id FROM routine_runs").all(),
      jobs: fixture.db.query("SELECT * FROM automatic_resume_jobs").all(),
      turns: fixture.startTurn.mock.calls.length,
    }),
  )

  expect(fixture.startTurn).toHaveBeenCalledTimes(2)
  const finished = fixture.engine.listRoutineRuns(routine.routine.id)[0]
  expect(finished?.id).toBe(result.routineRun.id)
  expect(finished?.startedAt).toBe(result.routineRun.startedAt)
  expect(finished?.runId).toBe(result.routineRun.runId)
})

test("boot recovers an interrupted channel whose member was still waiting for its execution slot", async () => {
  const fixture = await makeFixture([])
  await fixture.engine.ready
  const data = createGroupStore(fixture.kernel)
  const group = data.save({
    name: "Relatórios",
    color: "#dc2626",
    avatarShape: "classic-none",
    memberIds: ["b"],
    coordinatorBotId: null,
  })
  const channel = data.createThread(group)
  const participant = data.participant(group, channel.id, "b")
  const now = Date.now()
  const insertRequest = (id: string, threadId: string) =>
    fixture.store.insertMessage({
      message: {
        id,
        threadId,
        parentId: null,
        role: "user",
        kind: "text",
        status: "complete",
        runId: null,
        text: "@Demo termine o relatório",
        parts: [],
        sender: null,
        source: "local",
      },
    })
  expect(insertRequest("channel-request", channel.id).success).toBe(true)
  expect(insertRequest("member-request", participant.id).success).toBe(true)
  fixture.db
    .query(
      "INSERT INTO runs(id,thread_id,bot_id,provider,trigger,request_message_id,status,queued_at,started_at) VALUES ('group-root',?,'b','codex','user','channel-request','running',?,?)",
    )
    .run(channel.id, now, now)
  fixture.db
    .query(
      "INSERT INTO runs(id,thread_id,bot_id,provider,trigger,request_message_id,status,queued_at) VALUES ('member-queued',?,'b','codex','user','member-request','queued',?)",
    )
    .run(participant.id, now)
  fixture.db.query("INSERT INTO group_turns VALUES ('group-root',?,?)").run(group.id, JSON.stringify(["b"]))
  fixture.db.exec("INSERT INTO group_run_links VALUES ('member-queued','group-root',0)")

  const restarted = fixture.restart()
  await restarted.ready
  const groups = createGroupRuntime(fixture.kernel, restarted)
  fixture.kernel.services.provide("groups.runtime", groups)
  cleanups.add(async () => {
    groups.shutdown()
    await groups.waitForDrain()
  })
  await waitFor(
    () => fixture.startTurn.mock.calls.length === 1 && restarted.listRuns(participant.id)[0]?.status === "succeeded",
  )

  expect(fixture.db.query("SELECT status FROM runs WHERE id = 'member-queued'").get()).toEqual({
    status: "interrupted",
  })
  expect(
    fixture.db.query("SELECT COUNT(*) AS count FROM run_continuations WHERE previous_run_id = 'member-queued'").get(),
  ).toEqual({ count: 1 })
  expect(fixture.startTurn).toHaveBeenCalledTimes(1)
})

test.each(["Bash", "Write", "Edit", "unknown_tool", "notify_user", "mcp__touri__notify_user"])(
  "recorded %s actions require review before automatic continuation",
  (tool) => {
    const parts = [
      {
        type: "tool_call" as const,
        callId: "effect",
        tool,
        summary: "Ação",
        inputJson: "{}",
        outputJson: "{}",
        ok: true,
      },
    ]

    expect(hasUnsafeResumeActions(parts)).toBe(true)
  },
)

test.each(["Read", "history_read", "mcp__touri__history_read"])("completed %s reads permit recovery", (tool) => {
  const part = {
    type: "tool_call" as const,
    callId: "read",
    tool,
    summary: "Leitura",
    inputJson: "{}",
    outputJson: "{}",
    ok: true,
  }

  expect(hasUnsafeResumeActions([part])).toBe(false)
  expect(hasUnsafeResumeActions([{ ...part, ok: null }])).toBe(true)
})

test("archiving a bot during backoff prevents a later provider start", async () => {
  const fixture = await makeFixture(["timeout", "timeout"], undefined, 500)
  send(fixture.engine)
  await waitFor(() => fixture.startTurn.mock.calls.length === 2 && fixture.engine.listRuns("t")[0]?.status === "failed")

  fixture.db.query("UPDATE bots SET archived_at = ? WHERE id = 'b'").run(Date.now())
  await waitFor(
    () => fixture.db.query("SELECT state FROM automatic_resume_jobs WHERE state = 'pending'").get() === null,
  )

  expect(fixture.startTurn).toHaveBeenCalledTimes(2)
})

test("the first continuation publication already identifies its original card", async () => {
  const fixture = await makeFixture(["timeout"])
  const publications = new Set<string>()
  const unsubscribe = fixture.kernel.subscribe(({ event }) => {
    if (event.type === "run.updated" && event.run.status === "queued" && event.run.trigger === "retry")
      publications.add(event.run.automaticResumeFromRunId ?? "missing")
  })
  cleanups.add(async () => unsubscribe())

  const original = send(fixture.engine)
  await waitFor(() => fixture.engine.listRuns("t")[0]?.status === "succeeded")

  expect([...publications]).toEqual([original.id])
  expect(fixture.engine.listRuns("t").every((run) => run.requesterPersonId === "demo-person")).toBe(true)
})
