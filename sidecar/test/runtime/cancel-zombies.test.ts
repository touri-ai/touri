import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import type { ProviderAdapter, Run, StartTurnArgs } from "@touri/contracts"
import { spawnTree } from "../../src/kernel/spawn"
import { createRuntimeEngine } from "../../src/runtime/engine"
import { createRuntimePersistence } from "../../src/runtime/persistence"
import type { ChildProcess } from "../../src/runtime/provider-io"
import { getProviderProcessAlive } from "../../src/runtime/provider-processes"
import { RUN_EVENT_TIMEOUT_MS } from "../../src/runtime/run-supervision"
import { init as initStore } from "../../src/store"
import { testKernel } from "../kernel/test-kernel"

setDefaultTimeout(15_000)

const cleanups = new Set<() => void | Promise<void>>()

afterEach(async () => {
  await Array.from(cleanups).reduceRight(async (previous, cleanup) => {
    await previous
    await cleanup()
  }, Promise.resolve())
  cleanups.clear()
})

test.each(["live", "dead", "missed-exit", "missed-exit-descendant"] as const)(
  "cancel ends a run with a %s process even when its adapter never settles",
  async (mode) => {
    const fixture = await getFixture(mode)
    const started = performance.now()

    const result = await fixture.engine.cancelAndWait(fixture.run.id)
    await fixture.engine.cancelRuns([fixture.run.id])

    expect(result).toMatchObject({ success: true, run: { status: "canceled", errorClass: "canceled" } })
    expect(performance.now() - started).toBeLessThan(5_000)
    expect(fixture.getRun()).toMatchObject({ status: "canceled", finishedAt: expect.any(Number) })
    expect(fixture.engine.activeRun({ threadId: "thread" })).toBeNull()
    expect(await getProviderProcessAlive(fixture.child.pid)).toBe(false)
    if (fixture.descendantPid) expect(await getProviderProcessAlive(fixture.descendantPid)).toBe(false)
    expect(fixture.turn.signal.aborted).toBe(true)

    fixture.turn.onEvent({ type: "text_delta", itemId: "late", delta: "Late output must be fenced" })
    fixture.finish.resolve()
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(fixture.getRun()?.status).toBe("canceled")
    expect(
      fixture.store.activePath({ threadId: "thread" }).some((message) => message.text.includes("Late output")),
    ).toBe(false)
  },
)

test("a completed adapter cannot leave its canceled provider process alive", async () => {
  const fixture = await getFixture("cooperative")

  const result = await fixture.engine.cancelAndWait(fixture.run.id)

  expect(result).toMatchObject({ success: true, run: { status: "canceled" } })
  expect(await getProviderProcessAlive(fixture.child.pid)).toBe(false)
})

test("a stalled output flush cannot prevent terminal cancellation", async () => {
  const fixture = await getFixture("live", false, "output")
  const started = performance.now()

  const result = await fixture.engine.cancelAndWait(fixture.run.id)
  await fixture.engine.cancelRuns([fixture.run.id])

  expect(result).toMatchObject({ success: true, run: { status: "canceled" } })
  expect(performance.now() - started).toBeLessThan(5_000)
  expect(fixture.engine.activeRun({ threadId: "thread" })).toBeNull()
})

test("cancellation reports an error when the provider cannot be stopped", async () => {
  const fixture = await getFixture("live", false, "signal")

  const result = await fixture.engine.cancelAndWait(fixture.run.id)
  const repeated = await fixture.engine.cancelAndWait(fixture.run.id)

  expect(repeated).toEqual(result)
  expect(result).toMatchObject({
    success: false,
    errorCode: "TIMEOUT",
    error: "Não foi possível parar o processo do bot. Verifique as permissões e tente novamente.",
  })
  expect(fixture.getRun()?.status).toBe("running")
})

test("a canceled run releases its slot for the next request", async () => {
  const fixture = await getFixture("live")
  const next = fixture.enqueue("second-request")
  expect(fixture.persistence.getRun(next.id)?.status).toBe("queued")

  await fixture.engine.cancelAndWait(fixture.run.id)
  await fixture.engine.cancelRuns([fixture.run.id])
  fixture.finish.resolve()
  await getReady(() => fixture.persistence.getRun(next.id)?.status === "succeeded")

  expect(fixture.persistence.getRun(next.id)?.status).toBe("succeeded")
})

test("reconciliation fails a dead provider, preserves history and releases the slot", async () => {
  const fixture = await getFixture("dead")
  const observed = await fixture.engine.getRunActivities([fixture.getRunOrThrow()])

  await fixture.engine.reconcileRuns()
  await fixture.engine.cancelRuns([fixture.run.id])

  expect(observed[0]?.activity).toMatchObject({
    active: false,
    processAlive: false,
    staleReason: "process_exited",
    lastEventAt: expect.any(Number),
  })
  expect(fixture.getRun()).toMatchObject({
    status: "failed",
    errorClass: "cli_crash",
    errorMessage: "O processo do bot foi encerrado sem concluir a tarefa. Você pode tentar novamente.",
  })
  expect(fixture.engine.activeRun({ threadId: "thread" })).toBeNull()
  expect(fixture.store.activePath({ threadId: "thread" }).some((message) => message.role === "user")).toBe(true)
})

test("a silent live provider is killed and reconciled after ten minutes", async () => {
  const fixture = await getFixture("live")
  fixture.advanceTime(RUN_EVENT_TIMEOUT_MS)

  await fixture.engine.reconcileRuns()
  await fixture.engine.cancelRuns([fixture.run.id])

  expect(fixture.getRun()).toMatchObject({
    status: "failed",
    errorClass: "cli_crash",
    errorMessage: "O bot ficou 10 minutos sem enviar eventos. A tarefa foi encerrada. Você pode tentar novamente.",
  })
  expect(await getProviderProcessAlive(fixture.child.pid)).toBe(false)
})

test("events refresh liveness instead of imposing a maximum turn duration", async () => {
  const fixture = await getFixture("live")
  fixture.advanceTime(RUN_EVENT_TIMEOUT_MS - 1)
  fixture.turn.onEvent({ type: "text_delta", itemId: "reply", delta: "Ainda trabalhando." })
  fixture.advanceTime(RUN_EVENT_TIMEOUT_MS - 1)

  await fixture.engine.reconcileRuns()
  const observed = await fixture.engine.getRunActivities([fixture.getRunOrThrow()])

  expect(fixture.getRun()?.status).toBe("running")
  expect(observed[0]?.activity).toMatchObject({
    active: true,
    processAlive: true,
    staleReason: null,
    lastEventAt: fixture.getNow() - RUN_EVENT_TIMEOUT_MS + 1,
  })
})

test("waiting for a human approval does not count as provider silence", async () => {
  const fixture = await getFixture("live")
  fixture.turn.onEvent({
    type: "approval_request",
    approvalId: "synthetic-approval",
    part: {
      type: "approval",
      approvalId: "synthetic-approval",
      request: "permission",
      detail: "Pedido sintético",
      decision: "pending",
    },
  })
  fixture.advanceTime(RUN_EVENT_TIMEOUT_MS * 2)

  await fixture.engine.reconcileRuns()
  const observed = await fixture.engine.getRunActivities([fixture.getRunOrThrow()])

  expect(fixture.getRun()?.status).toBe("running")
  expect(observed[0]?.activity).toMatchObject({ active: true, processAlive: true, staleReason: null })
})

test("dead provider reconciliation uses the existing automatic retry path", async () => {
  const fixture = await getFixture("dead", true)

  await fixture.engine.reconcileRuns()
  fixture.finish.resolve()
  await getReady(() =>
    fixture.engine.listRuns("thread").some((run) => run.trigger === "retry" && run.status === "succeeded"),
  )

  expect(fixture.getRun()).toMatchObject({ status: "failed", errorClass: "cli_crash" })
  expect(fixture.engine.listRuns("thread").filter((run) => run.trigger === "retry")).toHaveLength(1)
})

test.each(["runtime", "shared"] as const)(
  "a %s bridge approval starts a fresh provider silence deadline",
  async (source) => {
    const fixture = await getFixture("live")
    const prompt = fixture.engine.approvalPrompt({
      ctx: { botId: "bot", threadId: "thread", runId: fixture.run.id, signal: fixture.turn.signal },
      toolName: "Read",
      input: { file_path: "/synthetic/example.txt" },
    })
    const approval = fixture.store
      .activePath({ threadId: "thread" })
      .flatMap((message) => message.parts)
      .find((part) => part.type === "approval" && part.decision === "pending")
    if (approval?.type !== "approval") throw new Error("Missing synthetic approval")
    fixture.advanceTime(RUN_EVENT_TIMEOUT_MS * 2)

    const answer = source === "runtime" ? fixture.engine.answerApproval : fixture.engine.approvalBridge.approve
    const result = await answer({ approvalId: approval.approvalId, decision: "approved" })
    await prompt
    const observed = await fixture.engine.getRunActivities([fixture.getRunOrThrow()])

    expect(result).toEqual({ success: true })
    expect(observed[0]?.activity).toMatchObject({
      active: true,
      processAlive: true,
      staleReason: null,
      lastEventAt: fixture.getNow(),
    })

    fixture.advanceTime(RUN_EVENT_TIMEOUT_MS)
    await fixture.engine.reconcileRuns()

    expect(fixture.getRun()).toMatchObject({ status: "failed", errorClass: "cli_crash" })
  },
)

const getFixture = async (
  mode: "live" | "dead" | "missed-exit" | "missed-exit-descendant" | "cooperative",
  resume = false,
  failure?: "output" | "signal",
) => {
  const base = testKernel()
  cleanups.add(base.close)
  await initStore(base.kernel)
  base.db
    .query("INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('bot','Synthetic','codex',?,1,1)")
    .run(base.kernel.paths.appData)
  base.db.exec("INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('thread','bot','Synthetic',1,1)")
  base.db
    .query("INSERT INTO settings(key,value_json,updated_at) VALUES ('resumeInterruptedTurns',?,1)")
    .run(JSON.stringify(resume))
  const store = base.kernel.services.use("store.api")
  if (!store) throw new Error("Missing synthetic store")
  const persistence = createRuntimePersistence({ database: base.db })
  const started = Promise.withResolvers<{ turn: StartTurnArgs; child: ChildProcess; descendantPid: number | null }>()
  const finish = Promise.withResolvers<void>()
  const output = Promise.withResolvers<void>()
  if (failure === "output")
    base.kernel.services.provide("store.api", Object.assign({}, store, { flushWritesAsync: () => output.promise }))
  const children = new Set<ChildProcess>()
  // The clock and invocation counter are confined to this injected provider fixture.
  let now = Date.now()
  let calls = 0
  const provider: ProviderAdapter = {
    provider: "codex",
    detect: async () => ({ success: true, path: "/synthetic/provider", version: "1", loggedIn: true }),
    startTurn: async (turn) => {
      calls += 1
      turn.onEvent({ type: "turn_started", externalTurnId: `synthetic-turn-${calls}` })
      if (calls === 1) {
        const live = mode === "live" || mode === "cooperative"
        const hasDescendant = live || mode === "missed-exit-descendant"
        const program = getProviderProgram(mode)
        const child = spawnTree({
          cmd: process.execPath,
          args: ["-e", program],
          cwd: base.kernel.paths.appData,
          env: {},
        })
        if (!child.success) throw new Error(child.error)
        children.add(child)
        const reader = child.stdout.getReader()
        const ready = await reader.read()
        const descendantPid = hasDescendant ? Number(new TextDecoder().decode(ready.value).trim().split(" ")[1]) : null
        reader.releaseLock()
        if (!live) await child.exited
        const observed =
          mode === "missed-exit" || mode === "missed-exit-descendant"
            ? Object.assign({}, child, { exited: new Promise<Awaited<ChildProcess["exited"]>>(() => {}) })
            : child
        const stoppable =
          failure === "signal"
            ? Object.assign({}, observed, {
                kill: () => {
                  throw new Error("Synthetic signal failure")
                },
              })
            : observed
        turn.onProcess?.(stoppable)
        if (mode === "cooperative") turn.signal.addEventListener("abort", () => finish.resolve(), { once: true })
        started.resolve({ turn, child, descendantPid })
      }
      await finish.promise
      turn.onEvent({ type: "text_delta", itemId: "reply", delta: "Resultado sintético." })
      return { success: true, status: "succeeded", externalSessionId: "synthetic-session", rolloutPath: null }
    },
    answerApproval: async () => ({ success: true }),
    shutdown: async () => {
      finish.resolve()
    },
  }
  const engine = createRuntimeEngine({
    kernel: base.kernel,
    providerAdapters: { codex: provider },
    maxConcurrentRuns: 1,
    getNow: () => now,
    environment: { PATH: "/usr/bin:/bin", HOME: base.kernel.paths.appData },
  })
  cleanups.add(async () => {
    output.resolve()
    finish.resolve()
    for (const child of children) {
      child.kill("SIGKILL")
      await child.exited
    }
    await engine.shutdown()
  })
  const enqueue = (id: string): Run => {
    const request = store.insertMessage({
      message: {
        id,
        threadId: "thread",
        parentId: store.getThread({ threadId: "thread" })?.activeLeafId ?? null,
        role: "user",
        kind: "text",
        status: "complete",
        runId: null,
        text: "Confira o resultado sintético.",
        parts: [],
        sender: null,
        source: "local",
      },
    })
    if (!request.success) throw new Error(request.error)
    const result = engine.enqueue({ threadId: "thread", requestMessageId: id, trigger: "user" })
    if (!result.success) throw new Error(result.error)

    return result.run
  }
  const run = enqueue("request")
  const { turn, child, descendantPid } = await started.promise
  const getRun = () => persistence.getRun(run.id)
  const getRunOrThrow = () => {
    const stored = getRun()
    if (!stored) throw new Error("Missing synthetic run")
    return stored
  }

  return {
    engine,
    store,
    persistence,
    run,
    turn,
    child,
    descendantPid,
    finish,
    enqueue,
    getRun,
    getRunOrThrow,
    advanceTime: (elapsed: number) => {
      now += elapsed
    },
    getNow: () => now,
  }
}

const getReady = async (predicate: () => boolean): Promise<void> => {
  const deadline = performance.now() + 5_000
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("Synthetic run did not settle")
    await Bun.sleep(5)
  }
}

const getProviderProgram = (
  mode: "live" | "dead" | "missed-exit" | "missed-exit-descendant" | "cooperative",
): string => {
  if (mode === "missed-exit-descendant")
    return 'const helper = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {stdout: "ignore", stderr: "ignore"}); console.log("READY " + helper.pid); process.exit(0)'
  if (mode === "live" || mode === "cooperative")
    return 'process.on("SIGTERM", () => {}); process.on("SIGINT", () => {}); const helper = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {stdout: "ignore", stderr: "ignore"}); console.log("READY " + helper.pid); setInterval(() => {}, 1000)'

  return 'console.log("READY")'
}
