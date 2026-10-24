import { afterEach, expect, mock, test } from "bun:test"
import type { Run, ToolContext } from "@touri/contracts"
import { createGroupRuntime, groupTurnTimeoutMs } from "../../src/groups/runtime"
import { createGroupStore } from "../../src/groups/store"
import { createRuntimePersistence } from "../../src/runtime/persistence"
import { init as initStore } from "../../src/store"
import { testKernel } from "../kernel/test-kernel"

const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup()
  cleanups.clear()
})

test("a queued member gets six hours from execution start, even while reporting progress", async () => {
  const fixture = await getFixture()
  const { turn, member } = await fixture.send()

  fixture.clock.advanceBy(20 * 60_000)

  expect(fixture.getRun(member.id)).toMatchObject({ status: "queued", startedAt: null })
  expect(fixture.clock.getPendingCount()).toBe(0)
  expect(fixture.cancel).not.toHaveBeenCalled()

  fixture.startMember(member.id)
  fixture.clock.advanceBy(120_001)
  fixture.updateRun(member.id, { externalTurnId: "synthetic-progress" })

  expect(fixture.getRun(member.id).status).toBe("running")
  expect(fixture.getSignal(member.id).aborted).toBe(false)
  expect(fixture.clock.getPendingCount()).toBe(1)

  fixture.clock.advanceBy(6 * 60 * 60_000 - 120_002)

  expect(fixture.getRun(member.id).status).toBe("running")

  fixture.clock.advanceBy(1)

  expect(fixture.getRun(member.id)).toMatchObject({ status: "failed", errorClass: "timeout" })

  await fixture.runtime.waitForDrain()

  expect(fixture.getRun(turn.id)).toMatchObject({ status: "failed", errorClass: "timeout" })
  expect(fixture.getSignal(member.id).aborted).toBe(true)
  expect(fixture.cancel).toHaveBeenCalledWith(member.id, expect.objectContaining({ errorClass: "timeout" }))
  expect(fixture.clock.getPendingCount()).toBe(0)
})

test("a delegated member can finish after ten minutes and releases its deadline", async () => {
  const fixture = await getFixture()
  const { turn, member: caller } = await fixture.send()
  fixture.startMember(caller.id)
  const delegated = fixture.runtime.askBot(fixture.getContext(caller.id), {
    bot: "worker",
    message: "Complete the synthetic task",
  })
  await waitFor(() => fixture.getMember(turn.id, "worker") !== undefined)
  const worker = fixture.getMember(turn.id, "worker")
  if (!worker) throw new Error("Missing delegated member")
  fixture.startMember(worker.id)

  fixture.clock.advanceBy(10 * 60_000 + 1)

  expect(fixture.getRun(worker.id).status).toBe("running")
  expect(fixture.getSignal(worker.id).aborted).toBe(false)
  expect(fixture.clock.getPendingCount()).toBe(2)
  expect(worker.threadId).not.toBe(caller.threadId)
  expect(worker.threadId).not.toBe(turn.threadId)

  fixture.completeMember(worker.id, "Synthetic task completed")
  const answer = await delegated
  fixture.updateRun(caller.id, { status: "succeeded", finishedAt: fixture.clock.getNow() })
  await fixture.runtime.waitForDrain()
  fixture.clock.advanceBy(6 * 60 * 60_000)

  expect(answer).toMatchObject({ success: true, structured: { answer: "Synthetic task completed" } })
  expect(fixture.getRun(turn.id).status).toBe("succeeded")
  expect(fixture.cancel).not.toHaveBeenCalled()
  expect(fixture.clock.getPendingCount()).toBe(0)
})

test.each([
  { configuredMs: 120_000, expectedMs: 60 * 60_000 },
  { configuredMs: 3 * 60 * 60_000, expectedMs: 3 * 60 * 60_000 },
])("a configured $configuredMs ms budget expires at $expectedMs ms", async (scenario) => {
  const fixture = await getFixture(groupTurnTimeoutMs(scenario.configuredMs))
  const { turn, member } = await fixture.send()

  fixture.startMember(member.id)
  fixture.clock.advanceBy(scenario.expectedMs - 1)

  expect(fixture.getRun(member.id).status).toBe("running")
  expect(fixture.cancel).not.toHaveBeenCalled()

  fixture.clock.advanceBy(1)
  await fixture.runtime.waitForDrain()

  expect(fixture.getRun(member.id)).toMatchObject({ status: "failed", errorClass: "timeout" })
  expect(fixture.getRun(turn.id)).toMatchObject({ status: "failed", errorClass: "timeout" })
  expect(fixture.getSignal(member.id).aborted).toBe(true)
  expect(fixture.clock.getPendingCount()).toBe(0)
})

test.each([
  { timeoutMinutes: 1, queueMs: 45_000, remainingMs: 15_000 },
  { timeoutMinutes: 30, queueMs: 12 * 60_000, remainingMs: 18 * 60_000 },
])("a $timeoutMinutes-minute routine retains its absolute deadline across queueing", async (scenario) => {
  const fixture = await getFixture()
  fixture.createRoutine(scenario.timeoutMinutes)
  const { turn, member } = await fixture.send({ routineRunId: "routine-run" })

  fixture.clock.advanceBy(scenario.queueMs)
  fixture.startMember(member.id)
  fixture.clock.advanceBy(scenario.remainingMs - 1)

  expect(fixture.getRun(member.id).status).toBe("running")
  expect(fixture.cancel).not.toHaveBeenCalled()

  fixture.clock.advanceBy(1)

  expect(fixture.getRun(member.id)).toMatchObject({ status: "failed", errorClass: "timeout" })

  await fixture.runtime.waitForDrain()

  expect(fixture.getRun(turn.id)).toMatchObject({ status: "failed", errorClass: "timeout" })
  expect(fixture.getSignal(member.id).aborted).toBe(true)
  expect(fixture.clock.getPendingCount()).toBe(0)
})

test.each(["queued", "running"] as const)("canceling a %s member stops it and clears its timer", async (status) => {
  const fixture = await getFixture()
  const { turn, member } = await fixture.send()
  if (status === "running") fixture.startMember(member.id)

  const canceled = fixture.runtime.cancel(turn.id)
  await fixture.runtime.waitForDrain()
  fixture.clock.advanceBy(20 * 60_000)

  expect(canceled).toBe(true)
  expect(fixture.getRun(member.id)).toMatchObject({ status: "canceled", errorClass: "canceled" })
  expect(fixture.getRun(turn.id)).toMatchObject({ status: "canceled", errorClass: "canceled" })
  expect(fixture.getSignal(member.id).aborted).toBe(true)
  expect(fixture.cancel.mock.calls.every(([, reason]) => reason === undefined)).toBe(true)
  expect(fixture.clock.getPendingCount()).toBe(0)
})

const getFixture = async (timeoutMs?: number) => {
  const host = testKernel()
  await initStore(host.kernel)
  const store = host.kernel.services.use("store.api")
  if (!store) throw new Error("Missing store")
  host.db.exec(`
    INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at)
    VALUES ('caller','Caller','codex','/tmp/synthetic-caller',1,1),
      ('worker','Worker','codex','/tmp/synthetic-worker',1,1);
  `)
  const groups = createGroupStore(host.kernel)
  const group = groups.save({
    name: "Synthetic group",
    color: "#888888",
    avatarShape: "classic-none",
    memberIds: ["caller", "worker"],
    coordinatorBotId: null,
  })
  const thread = groups.createThread(group)
  const persistence = createRuntimePersistence({ database: host.db })
  const clock = getDeadlineClock()
  const controllers = new Map<string, AbortController>()
  const getRun = (id: string): Run => {
    const run = persistence.getRun(id)
    if (!run) throw new Error("Missing synthetic run")

    return run
  }
  const updateRun = (id: string, patch: Partial<Run>): Run => {
    const run = Object.assign({}, getRun(id), patch)

    persistence.saveRun(run)
    host.kernel.publish({ type: "run.updated", run })
    return run
  }
  const enqueue = (args: { threadId: string; requestMessageId: string; trigger: Run["trigger"] }) => {
    const run: Run = {
      id: host.kernel.newId(),
      threadId: args.threadId,
      botId: store.getThread({ threadId: args.threadId })?.botId ?? "",
      provider: "codex",
      trigger: args.trigger,
      requestMessageId: args.requestMessageId,
      replyMessageId: null,
      externalTurnId: null,
      status: "queued",
      errorClass: null,
      errorMessage: null,
      usage: null,
      routineRunId: null,
      queuedAt: clock.getNow(),
      startedAt: null,
      finishedAt: null,
    }

    persistence.saveRun(run)
    controllers.set(run.id, new AbortController())
    return { success: true as const, run }
  }
  const cancel = mock((id: string, reason?: { errorClass: "timeout"; errorMessage: string }) => {
    const run = getRun(id)
    if (!["queued", "starting", "running"].includes(run.status)) return { success: true as const, run }

    const patch: Partial<Run> = reason
      ? { status: "failed", errorClass: reason.errorClass, errorMessage: reason.errorMessage }
      : { status: "canceled", errorClass: "canceled" }
    const canceled = updateRun(id, Object.assign({}, patch, { finishedAt: clock.getNow() }))

    controllers.get(id)?.abort()
    return { success: true as const, run: canceled }
  })
  const runtime = createGroupRuntime(host.kernel, { enqueue, cancel }, timeoutMs, undefined, clock)
  cleanups.add(async () => {
    runtime.shutdown()
    await runtime.waitForDrain()
    host.close()
  })
  const getMember = (turnId: string, botId = "caller") => {
    const member = runtime.listRuns(thread.id).find((run) => run.groupTurnId === turnId && run.botId === botId)
    if (!member) return undefined

    return getRun(member.id)
  }
  const getSignal = (id: string) => {
    const controller = controllers.get(id)
    if (!controller) throw new Error("Missing synthetic controller")

    return controller.signal
  }
  const getContext = (id: string): ToolContext => {
    const run = getRun(id)

    return {
      botId: run.botId,
      threadId: run.threadId,
      runId: id,
      projectId: null,
      cwd: "/tmp/synthetic-task",
      signal: getSignal(id),
    }
  }
  const completeMember = (id: string, text: string) => {
    const run = getRun(id)
    const reply = store.insertMessage({
      message: {
        id: host.kernel.newId(),
        threadId: run.threadId,
        parentId: run.requestMessageId,
        role: "assistant",
        kind: "text",
        status: "complete",
        runId: id,
        text,
        parts: [{ type: "text", text }],
        sender: null,
        source: "local",
      },
    })
    if (!reply.success) throw new Error(reply.error)

    host.kernel.publish({ type: "message.created", message: reply.message })
    updateRun(id, { status: "succeeded", replyMessageId: reply.message.id, finishedAt: clock.getNow() })
  }
  const send = async (options: { routineRunId?: string } = {}) => {
    const request = store.insertMessage({
      message: {
        id: host.kernel.newId(),
        threadId: thread.id,
        parentId: null,
        role: "user",
        kind: "text",
        status: "complete",
        runId: null,
        text: "@Caller complete the synthetic task",
        parts: [],
        sender: null,
        source: "local",
      },
    })
    if (!request.success) throw new Error(request.error)
    const result = runtime.enqueue(
      Object.assign({}, options, {
        threadId: thread.id,
        requestMessageId: request.message.id,
        trigger: options.routineRunId ? ("routine" as const) : ("user" as const),
      }),
    )
    if (!result.success) throw new Error(result.error)

    await waitFor(() => getMember(result.run.id) !== undefined)
    const member = getMember(result.run.id)
    if (!member) throw new Error("Missing synthetic member")

    return { turn: result.run, member }
  }
  const createRoutine = (timeoutMinutes: number) => {
    host.db
      .query(`INSERT INTO routines(id,bot_id,name,prompt,cron,timezone,timeout_minutes,created_at,updated_at)
        VALUES ('routine','caller','Synthetic routine','Synthetic task','0 * * * *','UTC',?,1,1)`)
      .run(timeoutMinutes)
    host.db
      .query(`INSERT INTO routine_runs(id,routine_id,scheduled_for,status,thread_id,trigger_source,started_at)
        VALUES ('routine-run','routine',?,'running',?,'manual',?)`)
      .run(clock.getNow(), thread.id, clock.getNow())
  }

  return {
    runtime,
    clock,
    cancel,
    send,
    getRun,
    getMember,
    getSignal,
    getContext,
    completeMember,
    updateRun,
    createRoutine,
    startMember: (id: string) => updateRun(id, { status: "running", startedAt: clock.getNow() }),
  }
}

const getDeadlineClock = () => {
  // Only this fixture's clock and timer registry change when synthetic time advances.
  let timestamp = Date.now()
  let timers: readonly { id: symbol; at: number; callback: () => void }[] = []
  const schedule = (callback: () => void, delayMs: number) => {
    const id = Symbol()
    timers = timers.concat({ id, at: timestamp + delayMs, callback })

    return () => {
      timers = timers.filter((timer) => timer.id !== id)
    }
  }

  return {
    getNow: () => timestamp,
    getPendingCount: () => timers.length,
    schedule,
    advanceBy: (milliseconds: number) => {
      timestamp += milliseconds
      const due = timers.filter((timer) => timer.at <= timestamp)
      timers = timers.filter((timer) => timer.at > timestamp)

      due.forEach((timer) => {
        timer.callback()
      })
    },
  }
}

const waitFor = async (isReady: () => boolean) => {
  const deadline = Date.now() + 5_000
  while (!isReady()) {
    if (Date.now() >= deadline) throw new Error("Synthetic member did not reach its checkpoint")

    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}
