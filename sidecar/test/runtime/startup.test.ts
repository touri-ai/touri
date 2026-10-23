import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import type { StartTurnArgs, StartTurnResult } from "@touri/contracts"
import { RUN_START_TIMEOUT_MESSAGE, safeRunFailure } from "@touri/contracts/run-failure"
import { getStartupFixture, getSuccessfulTurn, waitForStartup } from "./startup-fixture"

test.each([false, true])("startup preparation has a two-minute budget (delegated: %s)", async (delegated) => {
  const preparation = Promise.withResolvers<Record<string, string>>()
  const entered = Promise.withResolvers<void>()
  const fixture = await getStartupFixture({
    shellEnv: () => {
      entered.resolve()
      return preparation.promise
    },
  })
  const run = fixture.enqueue("t", delegated)
  await entered.promise

  fixture.clock.advanceBy(119_999)

  expect(fixture.persistence.getRun(run.id)?.status).toBe("starting")
  fixture.clock.advanceBy(1)
  await waitForStartup(() => fixture.persistence.getRun(run.id)?.status === "failed")
  preparation.resolve({ PATH: "/usr/bin" })
  const next = fixture.enqueue("next")
  await waitForStartup(() => fixture.persistence.getRun(next.id)?.status === "succeeded")

  expect(fixture.persistence.getRun(run.id)).toMatchObject({
    errorClass: "timeout",
    errorMessage: RUN_START_TIMEOUT_MESSAGE,
  })
  expect(fixture.persistence.getRun(run.id)?.providerStartedAt ?? null).toBeNull()
  expect(fixture.startTurn).toHaveBeenCalledTimes(1)
  expect(fixture.engine.getWorkRuns()).toEqual([])
  expect(safeRunFailure("timeout", RUN_START_TIMEOUT_MESSAGE).detail).toBe(RUN_START_TIMEOUT_MESSAGE)
})

test("a rejected preparation after its deadline keeps the timeout cause", async () => {
  const preparation = Promise.withResolvers<Record<string, string>>()
  const entered = Promise.withResolvers<void>()
  const fixture = await getStartupFixture({
    shellEnv: () => {
      entered.resolve()
      return preparation.promise
    },
  })
  const run = fixture.enqueue()
  await entered.promise

  fixture.clock.advanceBy(120_000)
  preparation.reject(new Error("Synthetic late preparation rejection"))
  await fixture.engine.waitForDrain()

  expect(fixture.persistence.getRun(run.id)).toMatchObject({
    status: "failed",
    errorClass: "timeout",
    errorMessage: RUN_START_TIMEOUT_MESSAGE,
  })
  expect(fixture.startTurn).not.toHaveBeenCalled()
  expect(fixture.engine.getWorkRuns()).toEqual([])
})

test("a silent provider is aborted; late provider frames cannot revive or alter its failed run", async () => {
  const started = Promise.withResolvers<StartTurnArgs>()
  const provider = Promise.withResolvers<StartTurnResult>()
  const fixture = await getStartupFixture({
    startTurn: async (args) => {
      started.resolve(args)
      return provider.promise
    },
  })
  const run = fixture.enqueue()
  const args = await started.promise

  fixture.clock.advanceBy(120_000)
  await waitForStartup(() => fixture.persistence.getRun(run.id)?.status === "failed")
  args.onEvent({ type: "turn_started", externalTurnId: "too-late" })
  args.onEvent({ type: "text_delta", itemId: "late", delta: "Late answer" })
  provider.resolve({ success: true, externalSessionId: "late-session", rolloutPath: null, status: "succeeded" })
  await fixture.engine.waitForDrain()

  expect(args.signal.aborted).toBe(true)
  expect(fixture.persistence.getRun(run.id)).toMatchObject({
    status: "failed",
    externalTurnId: null,
    errorClass: "timeout",
  })
  expect(fixture.store.activePath({ threadId: "t" }).some((message) => message.text.includes("Late answer"))).toBe(
    false,
  )
  expect(fixture.engine.getWorkRuns()).toEqual([])
  expect(fixture.engine.getRetainedRunStateCount()).toBe(0)
})

test("a failed provider spawn finalizes the run and does not consume a concurrency slot", async () => {
  const fixture = await getStartupFixture({
    startTurn: async () => ({ success: false, errorCode: "cli_missing", error: "Synthetic executable missing" }),
  })
  const first = fixture.enqueue()
  const second = fixture.enqueue("next")

  await waitForStartup(
    () =>
      fixture.persistence.getRun(first.id)?.status === "failed" &&
      fixture.persistence.getRun(second.id)?.status === "failed",
  )

  expect(fixture.persistence.getRun(first.id)?.errorClass).toBe("cli_missing")
  expect(fixture.startTurn).toHaveBeenCalledTimes(2)
  expect(fixture.engine.getWorkRuns()).toEqual([])
})

test("the startup timeout stops at turn acceptance and never limits an active turn", async () => {
  const started = Promise.withResolvers<StartTurnArgs>()
  const provider = Promise.withResolvers<StartTurnResult>()
  const fixture = await getStartupFixture({
    startTurn: async (args) => {
      args.onEvent({ type: "turn_started", externalTurnId: "accepted" })
      started.resolve(args)
      return provider.promise
    },
  })
  const run = fixture.enqueue()
  const args = await started.promise

  fixture.clock.advanceBy(360_000)

  expect(fixture.clock.getPendingCount()).toBe(0)
  expect(args.signal.aborted).toBe(false)
  expect(fixture.persistence.getRun(run.id)?.status).toBe("running")
  args.onEvent({ type: "text_delta", itemId: "answer", delta: "Notas organizadas." })
  provider.resolve({ success: true, externalSessionId: "session", rolloutPath: null, status: "succeeded" })
  await waitForStartup(() => fixture.persistence.getRun(run.id)?.status === "succeeded")
})

test("waiting for a slot does not spend the next run's startup budget", async () => {
  const started = Promise.withResolvers<StartTurnArgs>()
  const fixture = await getStartupFixture({
    startTurn: async (args) => {
      started.resolve(args)
      return new Promise<StartTurnResult>(() => {})
    },
  })
  const first = fixture.enqueue()
  const second = fixture.enqueue("next")
  await started.promise

  fixture.clock.advanceBy(120_000)
  await waitForStartup(
    () =>
      fixture.persistence.getRun(first.id)?.status === "failed" &&
      fixture.persistence.getRun(second.id)?.status === "starting",
  )
  fixture.clock.advanceBy(119_999)

  expect(fixture.persistence.getRun(second.id)?.status).toBe("starting")
  fixture.clock.advanceBy(1)
  await waitForStartup(() => fixture.persistence.getRun(second.id)?.status === "failed")
  expect(fixture.engine.getWorkRuns()).toEqual([])
})

test("user cancellation during stalled preparation wins over the timeout and never retries", async () => {
  const entered = Promise.withResolvers<void>()
  const fixture = await getStartupFixture({
    shellEnv: () => {
      entered.resolve()
      return new Promise<Record<string, string>>(() => {})
    },
    resume: true,
  })
  const run = fixture.enqueue()
  await entered.promise

  fixture.engine.cancel(run.id)
  await waitForStartup(() => fixture.persistence.getRun(run.id)?.status === "canceled")
  fixture.clock.advanceBy(120_000)
  await fixture.engine.waitForDrain()

  expect(fixture.engine.listRuns("t")).toHaveLength(1)
  expect(fixture.startTurn).not.toHaveBeenCalled()
  expect(fixture.engine.getWorkRuns()).toEqual([])
  expect(fixture.clock.getPendingCount()).toBe(0)
})

test("startup timeout uses bounded automatic continuation with the full original input, even without a session", async () => {
  let attempts = 0
  const fixture = await getStartupFixture({
    resume: true,
    startTurn: async (args) => {
      attempts += 1
      if (attempts === 1) return new Promise<StartTurnResult>(() => {})
      return getSuccessfulTurn(args)
    },
  })
  const run = fixture.enqueue()
  await waitForStartup(() => fixture.startTurn.mock.calls.length === 1)

  fixture.clock.advanceBy(120_000)
  await waitForStartup(() => fixture.engine.listRuns("t")[0]?.status === "succeeded")

  expect(fixture.persistence.getRun(run.id)).toMatchObject({ status: "failed", errorClass: "timeout" })
  const nextInput = fixture.startTurn.mock.calls[1]?.[0].input
  expect(nextInput).toContainEqual({ type: "image", attachmentId: "fixture-image", mime: "image/png" })
  expect(nextInput?.some((part) => part.type === "text" && part.text.includes("Organize as notas de exemplo."))).toBe(
    true,
  )
  expect(fixture.engine.listRuns("t")).toHaveLength(2)
  expect(fixture.engine.getWorkRuns()).toEqual([])
})

test("repeated startup hangs exhaust the existing continuation limit", async () => {
  const fixture = await getStartupFixture({
    resume: true,
    startTurn: async () => new Promise<StartTurnResult>(() => {}),
  })
  fixture.enqueue()
  await waitForStartup(() => fixture.startTurn.mock.calls.length === 1)

  fixture.clock.advanceBy(120_000)
  await waitForStartup(() => fixture.startTurn.mock.calls.length === 2)
  fixture.clock.advanceBy(120_000)
  await waitForStartup(() => fixture.startTurn.mock.calls.length === 3)
  fixture.clock.advanceBy(120_000)
  await fixture.engine.waitForDrain()

  expect(fixture.engine.listRuns("t")).toHaveLength(3)
  expect(fixture.engine.listRuns("t").every((run) => run.status === "failed" && run.errorClass === "timeout")).toBe(
    true,
  )
  expect(fixture.engine.getWorkRuns()).toEqual([])
})

test("a temporary database writer lock yields and then starts the run normally", async () => {
  const fixture = await getStartupFixture()
  await fixture.engine.ready
  const run = fixture.enqueue()
  const writer = new Database(fixture.db.filename)
  writer.exec("BEGIN IMMEDIATE")
  const yielded = Promise.withResolvers<void>()
  setImmediate(() => {
    writer.exec("ROLLBACK")
    writer.close()
    yielded.resolve()
  })

  await yielded.promise
  await waitForStartup(() => fixture.persistence.getRun(run.id)?.status === "succeeded")

  expect(fixture.startTurn).toHaveBeenCalledTimes(1)
  expect(fixture.engine.getWorkRuns()).toEqual([])
})

test.each(["queued", "starting", "running"] as const)(
  "boot settles or resumes a previous process's %s run",
  async (status) => {
    const fixture = await getStartupFixture()
    await fixture.engine.shutdown()
    const requestMessageId = fixture.insertRequest()
    fixture.persistence.saveRun({
      id: "previous-run",
      botId: "b",
      threadId: "t",
      provider: "codex",
      trigger: "user",
      requestMessageId,
      replyMessageId: null,
      externalTurnId: status === "running" ? "accepted" : null,
      status,
      errorClass: null,
      errorMessage: null,
      usage: null,
      routineRunId: null,
      queuedAt: Date.now(),
      startedAt: status === "queued" ? null : Date.now(),
      finishedAt: null,
    })

    const reopened = fixture.open()
    await reopened.ready
    await waitForStartup(() => !reopened.getWorkRuns().length)

    expect(fixture.persistence.getRun("previous-run")).toMatchObject({
      status: status === "queued" ? "succeeded" : "interrupted",
    })
    expect(fixture.startTurn).toHaveBeenCalledTimes(status === "queued" ? 1 : 0)
  },
)

test("pending consent prevents an automatic startup retry", async () => {
  const fixture = await getStartupFixture({
    resume: true,
    startTurn: async (args) => {
      args.onEvent({
        type: "approval_request",
        approvalId: "consent",
        part: {
          type: "approval",
          approvalId: "consent",
          request: "permission",
          detail: "Acesso de exemplo",
          decision: "pending",
        },
      })
      return new Promise<StartTurnResult>(() => {})
    },
  })
  const run = fixture.enqueue()
  await waitForStartup(() => fixture.startTurn.mock.calls.length === 1)

  fixture.clock.advanceBy(120_000)
  await fixture.engine.waitForDrain()

  expect(fixture.persistence.getRun(run.id)?.status).toBe("failed")
  expect(fixture.engine.listRuns("t")).toHaveLength(1)
})

test("shutdown settles a run even when its preparation ignores abort", async () => {
  const entered = Promise.withResolvers<void>()
  const fixture = await getStartupFixture({
    shellEnv: () => {
      entered.resolve()
      return new Promise<Record<string, string>>(() => {})
    },
  })
  const run = fixture.enqueue()
  await entered.promise

  await fixture.engine.shutdown()

  expect(fixture.persistence.getRun(run.id)).toMatchObject({ status: "interrupted", errorClass: "app_restart" })
  expect(fixture.clock.getPendingCount()).toBe(0)
  expect(fixture.engine.getWorkRuns()).toEqual([])
})

test.each(["starting", "running"] as const)(
  "boot automatically resumes %s without losing an unaccepted request",
  async (status) => {
    const fixture = await getStartupFixture({ resume: true })
    await fixture.engine.shutdown()
    const requestMessageId = fixture.insertRequest()
    fixture.persistence.saveRun({
      id: "previous-run",
      botId: "b",
      threadId: "t",
      provider: "codex",
      trigger: "user",
      requestMessageId,
      replyMessageId: null,
      externalTurnId: null,
      status,
      errorClass: null,
      errorMessage: null,
      usage: null,
      routineRunId: null,
      queuedAt: Date.now(),
      startedAt: Date.now(),
      finishedAt: null,
    })

    const reopened = fixture.open()
    await reopened.ready
    await waitForStartup(() => reopened.listRuns("t")[0]?.status === "succeeded")

    expect(fixture.persistence.getRun("previous-run")).toMatchObject({
      status: "interrupted",
      errorClass: "app_restart",
    })
    expect(fixture.startTurn.mock.calls[0]?.[0].input).toContainEqual({
      type: "image",
      attachmentId: "fixture-image",
      mime: "image/png",
    })
    expect(reopened.getWorkRuns()).toEqual([])
  },
)

test("late completion cannot remove the slot owned by a newer run in the same thread", async () => {
  const oldProvider = Promise.withResolvers<StartTurnResult>()
  const currentProvider = Promise.withResolvers<StartTurnResult>()
  let calls = 0
  const fixture = await getStartupFixture({
    startTurn: async (args) => {
      calls += 1
      if (calls === 1) return oldProvider.promise
      if (calls > 2) return getSuccessfulTurn(args)
      args.onEvent({ type: "turn_started", externalTurnId: "current-turn" })
      return currentProvider.promise
    },
  })
  const first = fixture.enqueue()
  await waitForStartup(() => calls === 1)
  fixture.clock.advanceBy(120_000)
  await waitForStartup(() => fixture.persistence.getRun(first.id)?.status === "failed")
  const second = fixture.enqueue()
  await waitForStartup(() => fixture.persistence.getRun(second.id)?.status === "running")
  const waiting = fixture.enqueue("next")

  oldProvider.resolve({ success: true, externalSessionId: "old-session", rolloutPath: null, status: "succeeded" })
  await new Promise<void>((resolve) => setImmediate(resolve))

  expect(fixture.engine.activeRun({ threadId: "t" })?.id).toBe(second.id)
  expect(fixture.persistence.getRun(waiting.id)?.status).toBe("queued")
  currentProvider.resolve({
    success: true,
    externalSessionId: "current-session",
    rolloutPath: null,
    status: "succeeded",
  })
  await waitForStartup(() => fixture.persistence.getRun(waiting.id)?.status === "succeeded")
})

test("boot does not bypass consent left pending before turn acceptance", async () => {
  const fixture = await getStartupFixture({ resume: true })
  await fixture.engine.shutdown()
  const requestMessageId = fixture.insertRequest()
  fixture.persistence.saveRun({
    id: "pending-consent-run",
    botId: "b",
    threadId: "t",
    provider: "codex",
    trigger: "user",
    requestMessageId,
    replyMessageId: "pending-reply",
    externalTurnId: null,
    status: "starting",
    errorClass: null,
    errorMessage: null,
    usage: null,
    routineRunId: null,
    queuedAt: Date.now(),
    startedAt: Date.now(),
    finishedAt: null,
  })
  fixture.store.insertMessage({
    message: {
      id: "pending-reply",
      threadId: "t",
      parentId: requestMessageId,
      role: "assistant",
      kind: "text",
      status: "streaming",
      runId: "pending-consent-run",
      text: "",
      parts: [
        {
          type: "approval",
          approvalId: "pending-approval",
          request: "permission",
          detail: "Acesso de exemplo",
          decision: "pending",
        },
      ],
      sender: null,
      source: "local",
    },
  })

  const reopened = fixture.open()
  await reopened.ready
  await reopened.waitForDrain()

  expect(fixture.persistence.getRun("pending-consent-run")?.status).toBe("interrupted")
  expect(reopened.listRuns("t")).toHaveLength(1)
  expect(fixture.startTurn).not.toHaveBeenCalled()
  expect(reopened.getWorkRuns()).toEqual([])
})

test("an explicit service refusal before acceptance does not create a continuation on shutdown", async () => {
  const fixture = await getStartupFixture({
    resume: true,
    startTurn: async () => ({
      success: false,
      errorCode: "machine_service_unavailable",
      error: "Synthetic service refusal",
    }),
  })
  const run = fixture.enqueue()
  await waitForStartup(() => fixture.persistence.getRun(run.id)?.status === "failed")

  await fixture.engine.shutdown()

  expect(fixture.engine.listRuns("t")).toHaveLength(1)
  expect(fixture.persistence.getRun(run.id)).toMatchObject({
    status: "failed",
    errorClass: "machine_service_unavailable",
  })
  expect(fixture.startTurn).toHaveBeenCalledTimes(1)
})
