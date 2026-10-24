import type { Database } from "bun:sqlite"
import { afterEach, expect, mock, setDefaultTimeout, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GoalStart, ProviderAdapter, StartTurnArgs } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { createGoalCheckpointHandler } from "../../src/runtime"
import { createRuntimeEngine } from "../../src/runtime/engine"
import type { GoalDeadlineClock } from "../../src/runtime/goal-deadline"
import { init as initStore } from "../../src/store"

setDefaultTimeout(15_000)

const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  await Promise.all([...cleanups].map((cleanup) => cleanup()))
  cleanups.clear()
})

const makeFixture = async (
  onTurn?: (args: StartTurnArgs, index: number) => Promise<void>,
  goalDeadlineClock?: GoalDeadlineClock,
) => {
  const root = mkdtempSync(join(tmpdir(), "touri-goals-"))
  const runtime = createKernel({ appData: root })
  await initStore(runtime.kernel)
  const database = runtime.kernel.db as Database
  database
    .query("INSERT INTO projects(id,name,path,data_dir,created_at,updated_at) VALUES ('p','Demo',?,?,1,1)")
    .run(root, root)
  database
    .query(
      "INSERT INTO bots(id,name,provider,home_dir,project_id,created_at,updated_at) VALUES ('b','Demo','codex',?,'p',1,1)",
    )
    .run(root)
  database.exec("INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('t','b','Demo',1,1)")
  const store = runtime.kernel.services.use("store.api")
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
      text: "Compare três opções e entregue uma tabela.",
      parts: [{ type: "text", text: "Compare três opções e entregue uma tabela." }],
      sender: null,
      source: "local",
    },
  })
  if (!request.success) throw new Error(request.error)
  const startTurn = mock(async (args: StartTurnArgs) => {
    const index = startTurn.mock.calls.length
    args.onEvent({ type: "session", externalSessionId: "demo-session", rolloutPath: null })
    args.onEvent({ type: "turn_started", externalTurnId: `turn-${index}` })
    args.onEvent({ type: "text_delta", itemId: `reply-${index}`, delta: `Etapa observada ${index}.` })
    await onTurn?.(args, index)
    return {
      success: true as const,
      externalSessionId: "demo-session",
      rolloutPath: null,
      status: "succeeded" as const,
    }
  })
  const adapter: ProviderAdapter = {
    provider: "codex",
    detect: async () => ({ success: true, path: "/tmp/fake-provider", version: "1", loggedIn: true }),
    startTurn,
    answerApproval: mock(async () => ({ success: true as const })),
    shutdown: async () => {},
  }
  const getEngine = () =>
    createRuntimeEngine({
      kernel: runtime.kernel,
      providerAdapters: { codex: adapter },
      environment: { PATH: "/usr/bin" },
      resumeBackoffMs: 1,
      ...(goalDeadlineClock ? { goalDeadlineClock } : {}),
    })
  const engine = getEngine()
  const engines = new Set([engine])
  cleanups.add(async () => {
    await Promise.all([...engines].map((value) => value.shutdown()))
    await runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  const restart = () => {
    const next = getEngine()
    engines.add(next)
    return next
  }

  return { engine, startTurn, adapter, database, store, restart, kernel: runtime.kernel, input: getInput() }
}

const getInput = (patch: Partial<GoalStart> = {}): GoalStart => ({
  requestMessageId: "request",
  completionCriterion: "Tabela com três opções e fontes verificadas.",
  maxTurns: 3,
  maxMinutes: 10,
  ...patch,
})

const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Goal did not reach the expected checkpoint")
    await Bun.sleep(10)
  }
}

const waitForAbort = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve()
    signal.addEventListener("abort", () => resolve(), { once: true })
  })

const makeDeadlineClock = () => {
  // Timer handles and the clock advance locally, without patching other runtime timers.
  let timestamp = Date.now()
  let timers: Array<{ callback: () => void; deadlineAt: number }> = []
  const schedule = mock((callback: () => void, delay: number) => {
    const timer = { callback, deadlineAt: timestamp + delay }
    timers = [...timers, timer]
    return () => {
      timers = timers.filter((pending) => pending !== timer)
    }
  })

  return {
    now: () => timestamp,
    schedule,
    getPendingCount: () => timers.length,
    advanceBy: (duration: number) => {
      timestamp += duration
      const due = timers.filter((timer) => timer.deadlineAt <= timestamp)
      timers = timers.filter((timer) => timer.deadlineAt > timestamp)
      due.forEach((timer) => {
        timer.callback()
      })
    },
  }
}

test("a live goal waits for one deadline timeout without polling its checkpoint", async () => {
  const clock = makeDeadlineClock()
  const fixture = await makeFixture(async (args) => waitForAbort(args.signal), clock)
  const expireRun = spyOn(fixture.engine.goals, "expireRun")
  cleanups.add(async () => expireRun.mockRestore())
  fixture.engine.goals.startGoal("t", fixture.input)
  await waitFor(() => fixture.startTurn.mock.calls.length === 1)

  clock.advanceBy(9 * 60_000)

  expect(clock.schedule).toHaveBeenCalledTimes(1)
  expect(clock.schedule.mock.calls[0]?.[1]).toBe(10 * 60_000)
  expect(clock.getPendingCount()).toBe(1)
  expect(expireRun).not.toHaveBeenCalled()

  clock.advanceBy(60_000)
  await waitFor(() => fixture.engine.activeRun({ threadId: "t" }) === null)

  expect(expireRun).toHaveBeenCalledTimes(1)
  expect(fixture.engine.goals.getGoal("t")?.status).toBe("budget_exhausted")
  expect(clock.getPendingCount()).toBe(0)
})

test("budget extensions and reductions replace the live timeout but progress leaves it alone", async () => {
  const clock = makeDeadlineClock()
  const fixture = await makeFixture(async (args) => waitForAbort(args.signal), clock)
  fixture.engine.goals.startGoal("t", fixture.input)
  await waitFor(() => fixture.startTurn.mock.calls.length === 1)
  const run = fixture.engine.activeRun({ threadId: "t" })
  if (!run) throw new Error("Missing goal turn")

  fixture.engine.goals.recordCheckpoint({
    runId: run.id,
    botId: "b",
    threadId: "t",
    step: "Fonte verificada.",
    completed: false,
  })

  expect(clock.schedule).toHaveBeenCalledTimes(1)

  clock.advanceBy(60_000)
  fixture.engine.goals.controlGoal("t", { action: "budget", maxTurns: 3, maxMinutes: 20 })
  clock.advanceBy(9 * 60_000)

  expect(clock.schedule).toHaveBeenCalledTimes(2)
  expect(clock.schedule.mock.calls[1]?.[1]).toBe(20 * 60_000)
  expect(clock.getPendingCount()).toBe(1)
  expect(fixture.startTurn.mock.calls[0]?.[0].signal.aborted).toBe(false)

  fixture.engine.goals.controlGoal("t", { action: "budget", maxTurns: 3, maxMinutes: 1 })

  expect(clock.schedule).toHaveBeenCalledTimes(3)
  expect(clock.schedule.mock.calls[2]?.[1]).toBe(60_000)
  expect(clock.getPendingCount()).toBe(1)

  clock.advanceBy(60_000)
  await waitFor(() => fixture.engine.activeRun({ threadId: "t" }) === null)

  expect(fixture.engine.goals.getGoal("t")?.status).toBe("budget_exhausted")
  expect(clock.getPendingCount()).toBe(0)
})

test("ending a goal turn clears its deadline timeout", async () => {
  const clock = makeDeadlineClock()
  const fixture = await makeFixture(async (args) => waitForAbort(args.signal), clock)
  fixture.engine.goals.startGoal("t", fixture.input)
  await waitFor(() => fixture.startTurn.mock.calls.length === 1)

  fixture.engine.goals.controlGoal("t", { action: "pause" })
  await waitFor(() => fixture.engine.activeRun({ threadId: "t" }) === null)

  expect(clock.getPendingCount()).toBe(0)
  clock.advanceBy(10 * 60_000)
  expect(fixture.engine.goals.getGoal("t")?.status).toBe("paused")
})

test("normal turn endings continue the goal and stop at the turn budget", async () => {
  const fixture = await makeFixture()

  const started = fixture.engine.goals.startGoal("t", fixture.input)
  await waitFor(() => fixture.engine.goals.getGoal("t")?.status === "budget_exhausted")

  expect(started.success).toBe(true)
  expect(fixture.startTurn).toHaveBeenCalledTimes(3)
  expect(fixture.engine.goals.getGoal("t")).toMatchObject({ turnsUsed: 3, status: "budget_exhausted" })
  expect(fixture.engine.goals.getGoal("t")?.steps).toHaveLength(3)
  expect(fixture.startTurn.mock.calls[1]?.[0].input).toContainEqual(
    expect.objectContaining({
      type: "text",
      text: expect.stringContaining("Agreed completion criterion: Tabela"),
    }),
  )
  expect(fixture.startTurn.mock.calls.every(([args]) => args.bot.approvals === "on-request")).toBe(true)
  expect(fixture.adapter.answerApproval).not.toHaveBeenCalled()
})

test("only an explicit checkpoint declaring completion stops before the budget", async () => {
  const fixture = await makeFixture(async (_args, index) => {
    if (index !== 2) return
    const run = fixture.engine.activeRun({ threadId: "t" })
    if (!run) throw new Error("Missing turn")
    fixture.engine.goals.recordCheckpoint({
      runId: run.id,
      botId: "b",
      threadId: "t",
      step: "Tabela verificada.",
      completed: true,
    })
  })

  fixture.engine.goals.startGoal("t", fixture.input)
  await waitFor(() => fixture.engine.goals.getGoal("t")?.status === "completed")
  await waitFor(() => fixture.engine.activeRun({ threadId: "t" }) === null)

  expect(fixture.startTurn).toHaveBeenCalledTimes(2)
  expect(fixture.engine.goals.getGoal("t")?.steps.at(-1)?.text).toBe("Tabela verificada.")
})

test("pause cancels the live turn, budget edits do not resume, and resume uses the checkpoint", async () => {
  const fixture = await makeFixture(async (args) => waitForAbort(args.signal))
  fixture.engine.goals.startGoal("t", fixture.input)
  await waitFor(() => fixture.startTurn.mock.calls.length === 1)

  fixture.engine.goals.controlGoal("t", { action: "pause" })
  await waitFor(() => fixture.engine.activeRun({ threadId: "t" }) === null)
  fixture.engine.goals.controlGoal("t", { action: "budget", maxTurns: 4, maxMinutes: 20 })

  expect(fixture.engine.goals.getGoal("t")).toMatchObject({ status: "paused", turnsUsed: 1, maxTurns: 4 })
  expect(fixture.startTurn).toHaveBeenCalledTimes(1)

  fixture.engine.goals.controlGoal("t", { action: "resume" })
  await waitFor(() => fixture.startTurn.mock.calls.length === 2)
  fixture.engine.goals.controlGoal("t", { action: "complete" })
  await waitFor(() => fixture.engine.activeRun({ threadId: "t" }) === null)

  expect(fixture.engine.goals.getGoal("t")?.status).toBe("completed")
  expect(fixture.startTurn.mock.calls[1]?.[0].session?.externalSessionId).toBe("demo-session")
})

test("time exhaustion interrupts an unfinished turn and cannot resume without more budget", async () => {
  const fixture = await makeFixture(async (args) => waitForAbort(args.signal))
  fixture.engine.goals.startGoal("t", fixture.input)
  await waitFor(() => fixture.startTurn.mock.calls.length === 1)
  const goal = fixture.engine.goals.getGoal("t")
  if (!goal) throw new Error("Missing goal")

  fixture.engine.goals.saveGoal({ ...goal, deadlineAt: Date.now() - 1 })
  await waitFor(() => fixture.engine.goals.getGoal("t")?.status === "budget_exhausted")
  await waitFor(() => fixture.engine.activeRun({ threadId: "t" }) === null)
  fixture.engine.goals.controlGoal("t", { action: "resume" })

  expect(fixture.startTurn).toHaveBeenCalledTimes(1)
  expect(fixture.engine.goals.getGoal("t")?.status).toBe("budget_exhausted")
})

test("active goals survive runtime replacement and keep their original budget", async () => {
  const fixture = await makeFixture(async (args) => waitForAbort(args.signal))
  fixture.engine.goals.startGoal("t", fixture.input)
  await waitFor(() => fixture.startTurn.mock.calls.length === 1)
  const original = fixture.engine.goals.getGoal("t")
  const runId = original?.runId
  if (!runId) throw new Error("Missing goal turn")
  fixture.engine.goals.recordCheckpoint({
    runId,
    botId: "b",
    threadId: "t",
    step: "Primeira fonte verificada.",
    completed: false,
  })

  await fixture.engine.shutdown()
  const replacement = fixture.restart()
  await waitFor(() => fixture.startTurn.mock.calls.length === 2)

  expect(replacement.goals.getGoal("t")).toMatchObject({
    id: original?.id,
    maxTurns: 3,
    turnsUsed: 2,
    deadlineAt: original?.deadlineAt,
  })
  expect(replacement.goals.getGoal("t")?.steps[0]?.text).toBe("Primeira fonte verificada.")
  replacement.goals.controlGoal("t", { action: "complete" })
})

test("goals require authorized scope, valid budgets and a current user request", async () => {
  const fixture = await makeFixture()

  expect(fixture.engine.goals.startGoal("t", getInput({ maxTurns: 0 })).success).toBe(false)
  expect(fixture.engine.goals.startGoal("t", getInput({ maxMinutes: Number.NaN })).success).toBe(false)
  expect(fixture.engine.goals.startGoal("t", getInput({ requestMessageId: "stale" })).success).toBe(false)
  fixture.database.exec("UPDATE bots SET project_id = NULL WHERE id = 'b'")

  expect(fixture.engine.goals.startGoal("t", fixture.input).success).toBe(false)
  expect(fixture.startTurn).not.toHaveBeenCalled()

  const ordinary = fixture.engine.enqueue({ threadId: "t", requestMessageId: "request", trigger: "user" })
  await waitFor(() => fixture.engine.listRuns("t")[0]?.status === "succeeded")

  expect(ordinary.success).toBe(true)
  expect(fixture.startTurn).toHaveBeenCalledTimes(1)
  expect(fixture.engine.goals.getGoal("t")).toBeNull()
})

test("checkpoint tool refuses another run or bot and cannot raise a budget", async () => {
  const fixture = await makeFixture(async (args) => waitForAbort(args.signal))
  fixture.engine.goals.startGoal("t", fixture.input)
  await waitFor(() => fixture.startTurn.mock.calls.length === 1)
  const run = fixture.engine.activeRun({ threadId: "t" })
  if (!run) throw new Error("Missing turn")
  const handler = createGoalCheckpointHandler(fixture.engine)
  const ctx = {
    botId: "other",
    threadId: "t",
    runId: run.id,
    projectId: "p",
    cwd: "/tmp/demo",
    signal: new AbortController().signal,
  }

  const rejected = await handler({ ctx, args: { step: "Fake completion", completed: true, maxTurns: 20 } })

  expect(rejected.success).toBe(false)
  expect(fixture.engine.goals.getGoal("t")).toMatchObject({ status: "active", maxTurns: 3 })
})

test("goal checkpoints keep restart continuation caps", async () => {
  const fixture = await makeFixture(async (args) => waitForAbort(args.signal))
  fixture.engine.goals.startGoal("t", getInput({ maxTurns: 10 }))
  await waitFor(() => fixture.startTurn.mock.calls.length === 1)

  await fixture.engine.shutdown()
  const second = fixture.restart()
  await waitFor(() => fixture.startTurn.mock.calls.length === 2)
  await second.shutdown()
  const third = fixture.restart()
  await waitFor(() => fixture.startTurn.mock.calls.length === 3)
  await third.shutdown()
  const fourth = fixture.restart()
  await fourth.ready

  expect(fourth.goals.getGoal("t")).toMatchObject({ status: "paused", turnsUsed: 3 })
  expect(fixture.startTurn).toHaveBeenCalledTimes(3)
})

test("an autonomous turn waits for explicit approval and pauses after a denial", async () => {
  const fixture = await makeFixture(async (args) => {
    const run = fixture.engine.activeRun({ threadId: "t" })
    if (!run) throw new Error("Missing turn")
    fixture.engine.continueAfterApproval({ botId: "b", threadId: "t", runId: run.id, signal: args.signal })
    await fixture.engine.approvalPrompt({
      ctx: { botId: "b", threadId: "t", runId: run.id, signal: args.signal },
      toolName: "Bash",
      input: { command: "echo demo" },
    })
  })
  fixture.engine.goals.startGoal("t", fixture.input)
  const getApproval = () =>
    fixture.store
      .activePath({ threadId: "t" })
      .flatMap((message) => message.parts)
      .find((part) => part.type === "approval" && part.decision === "pending")
  await waitFor(() => getApproval() !== undefined)

  expect(fixture.startTurn).toHaveBeenCalledTimes(1)
  expect(fixture.adapter.answerApproval).not.toHaveBeenCalled()
  expect(fixture.engine.goals.getGoal("t")?.status).toBe("active")

  const approval = getApproval()
  if (approval?.type !== "approval") throw new Error("Missing approval")
  await fixture.engine.answerApproval({ approvalId: approval.approvalId, decision: "denied" })
  await waitFor(() => fixture.engine.activeRun({ threadId: "t" }) === null)

  expect(getApproval()).toBeUndefined()
  expect(fixture.startTurn).toHaveBeenCalledTimes(1)
  expect(fixture.engine.goals.getGoal("t")?.status).toBe("paused")
})

test("a new user request pauses the goal and reaches the next turn", async () => {
  const fixture = await makeFixture(async (args, index) => {
    if (index === 1) await waitForAbort(args.signal)
  })
  fixture.engine.goals.startGoal("t", fixture.input)
  await waitFor(() => fixture.startTurn.mock.calls.length === 1)
  const text = "Agora prepare apenas um resumo."
  fixture.store.insertMessage({
    message: {
      id: "new-request",
      threadId: "t",
      parentId: fixture.store.getThread({ threadId: "t" })?.activeLeafId ?? null,
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

  fixture.engine.enqueue({ threadId: "t", requestMessageId: "new-request", trigger: "user" })
  await waitFor(() => fixture.engine.listRuns("t")[0]?.status === "succeeded")

  expect(fixture.startTurn).toHaveBeenCalledTimes(2)
  expect(fixture.engine.goals.getGoal("t")?.status).toBe("paused")
  expect(fixture.startTurn.mock.calls[1]?.[0].input).toContainEqual(
    expect.objectContaining({ type: "text", text: expect.stringContaining(text) }),
  )
})

test("a continuation cannot escape the goal budget if it expires while being queued", async () => {
  const fixture = await makeFixture(async (args, index) => {
    if (index !== 1) return
    const run = fixture.engine.activeRun({ threadId: "t" })
    fixture.engine.continueAfterApproval({ botId: "b", threadId: "t", runId: run?.id ?? null, signal: args.signal })
  })
  const unsubscribe = fixture.kernel.subscribe(({ event }) => {
    if (event.type !== "run.updated" || event.run.status !== "queued" || fixture.startTurn.mock.calls.length !== 1)
      return
    const goal = fixture.engine.goals.getGoal("t")
    if (goal) fixture.engine.goals.saveGoal({ ...goal, deadlineAt: Date.now() - 1 })
  })
  cleanups.add(async () => unsubscribe())

  fixture.engine.goals.startGoal("t", fixture.input)
  await waitFor(() => fixture.engine.goals.getGoal("t")?.status === "budget_exhausted")
  await waitFor(() => ["succeeded", "canceled"].includes(fixture.engine.listRuns("t")[0]?.status ?? ""))

  expect(fixture.startTurn).toHaveBeenCalledTimes(1)
  expect(fixture.engine.listRuns("t")[0]?.status).toBe("canceled")
})
