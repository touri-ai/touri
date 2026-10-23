import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import type { Message, ProviderAdapter, Run, StartTurnArgs } from "@touri/contracts"
import { createGroupRuntime } from "../../src/groups/runtime"
import { createGroupStore } from "../../src/groups/store"
import type { PerformanceStageRunner } from "../../src/kernel/performance"
import { createRuntimeEngine } from "../../src/runtime/engine"
import { createRuntimePersistence } from "../../src/runtime/persistence"
import { init as initStore } from "../../src/store"
import { testKernel } from "../kernel/test-kernel"

setDefaultTimeout(60_000)

const cleanups = new Set<() => void | Promise<void>>()

afterEach(async () => {
  await runCleanups(Array.from(cleanups))
  cleanups.clear()
})

test.each([false, true])(
  "channel requests advance after output preparation throws (persistent: %s)",
  async (persistent) => {
    // Failure counters belong to this injected finalization stage only.
    let remainingFailures = persistent ? Infinity : 1
    const runStage: PerformanceStageRunner = (stage, action, input) => {
      if (stage === "runtime_output_preparation" && remainingFailures > 0) {
        remainingFailures -= 1
        throw Object.assign(new Error("Synthetic output write failure"), { code: "EIO" })
      }

      return action(input as Parameters<typeof action>[0])
    }
    const fixture = await getFixture(runStage)
    const first = fixture.send()
    const turn = await fixture.started.promise
    turn.onEvent({ type: "text_delta", itemId: "answer", delta: "Resultado preservado." })
    turn.onEvent({
      type: "item",
      part: {
        type: "tool_call",
        callId: "completed-tool",
        tool: "fixture_lookup",
        summary: "Conferência sintética",
        inputJson: "{}",
        outputJson: '{"found":true}',
        ok: true,
      },
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    await fixture.store.flushWritesAsync?.()
    const second = fixture.send()
    expect(fixture.persistence.getRun(second.id)?.status).toBe("queued")

    fixture.finish.resolve()
    await fixture.getFinished(second.id)

    const member = fixture.getMember(first.id)
    expect(member).toMatchObject({ status: "failed", errorClass: "unknown", finishedAt: expect.any(Number) })
    expect(fixture.persistence.getRun(first.id)).toMatchObject({ status: "failed", errorClass: "unknown" })
    expect(fixture.getStartCount()).toBe(2)
    expect(fixture.persistence.getRun(second.id)?.status).toBe(persistent ? "failed" : "succeeded")
    expect(fixture.engine.activeRun({ threadId: member.threadId })).toBeNull()
    expect(fixture.notifications).toContain("turn-failed")
    expect(fixture.logs).toContainEqual(
      expect.objectContaining({
        msg: "Unexpected turn execution failure",
        data: expect.objectContaining({ errorCode: "EIO" }),
      }),
    )
    expect(JSON.stringify(fixture.logs)).not.toContain("Synthetic output write failure")

    const reply = fixture.store.getPathMessage?.({ threadId: member.threadId, messageId: member.replyMessageId ?? "" })
    expect(reply?.text).toContain("Resultado preservado.")
    expect(reply?.text).toContain("Conferência concluída.")
    expect(reply?.parts).toContainEqual(expect.objectContaining({ callId: "completed-tool", resolution: "succeeded" }))
    if (persistent) return

    expect(reply).toMatchObject({ status: "failed" })
    expect(reply?.parts).toContainEqual(expect.objectContaining({ type: "notice", code: "run_failed" }))
  },
)

test("an unexpected startup failure releases the execution slot and preserves the request", async () => {
  // The fault is scoped to the first request-path lookup, before provider invocation.
  let shouldFail = true
  const runStage: PerformanceStageRunner = (stage, action, input) => {
    if (stage === "runtime_request_path_lookup" && shouldFail) {
      shouldFail = false
      throw Object.assign(new Error("Synthetic startup failure"), { code: "EPRIVATE" })
    }

    return action(input as Parameters<typeof action>[0])
  }
  const fixture = await getFixture(runStage)

  const first = fixture.send()
  const second = fixture.send()
  fixture.finish.resolve()
  await fixture.getFinished(second.id)

  expect(fixture.getMember(first.id)).toMatchObject({ status: "failed", errorClass: "unknown" })
  expect(fixture.getStartCount()).toBe(1)
  expect(fixture.persistence.getRun(second.id)?.status).toBe("succeeded")
  expect(JSON.stringify(fixture.logs)).not.toContain("EPRIVATE")
  expect(
    fixture.store.getPathMessage?.({ threadId: fixture.threadId, messageId: first.requestMessageId ?? "" }),
  ).toMatchObject({ role: "user", text: "@Teste confira o resultado sintético." })
})

const getFixture = async (runStage: PerformanceStageRunner) => {
  const fixture = testKernel()
  cleanups.add(fixture.close)
  await initStore(fixture.kernel)
  const store = fixture.kernel.services.use("store.api")
  if (!store) throw new Error("Missing fixture store")
  fixture.db
    .query("INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('bot','Teste','codex',?,1,1)")
    .run(fixture.kernel.paths.appData)
  const groups = createGroupStore(fixture.kernel)
  const group = groups.save({
    name: "Equipe sintética",
    color: "#888888",
    avatarShape: "classic-none",
    memberIds: ["bot"],
    coordinatorBotId: null,
  })
  const thread = groups.createThread(group)
  const persistence = createRuntimePersistence({ database: fixture.db })
  const started = Promise.withResolvers<StartTurnArgs>()
  const finish = Promise.withResolvers<void>()
  const logs: Array<Parameters<typeof fixture.kernel.log>[0]> = []
  const notifications: string[] = []
  fixture.kernel.services.provide("notify.emit", (notice) => {
    notifications.push(notice.kind)
    return {
      ...notice,
      id: notifications.length,
      level: "error",
      botName: "Teste",
      botColor: "#888888",
      avatarShape: "classic-none",
      requestId: notice.requestId ?? null,
      createdAt: Date.now(),
      resolvedAt: null,
      resolution: null,
    }
  })
  // This fake records calls for one provider lifecycle; no global adapter is patched.
  let startCount = 0
  const provider: ProviderAdapter = {
    provider: "codex",
    detect: async () => ({ success: true, path: "/tmp/fixture-provider", version: "1", loggedIn: true }),
    startTurn: async (args) => {
      startCount += 1
      args.onEvent({ type: "turn_started", externalTurnId: `fixture-turn-${startCount}` })
      started.resolve(args)
      await finish.promise
      args.onEvent({ type: "text_delta", itemId: "answer", delta: " Conferência concluída." })
      return {
        success: true,
        status: "succeeded",
        externalSessionId: "fixture-session",
        usage: null,
        rolloutPath: null,
      }
    },
    answerApproval: async () => ({ success: true }),
    shutdown: async () => {
      finish.resolve()
    },
  }
  const engine = createRuntimeEngine({
    kernel: {
      ...fixture.kernel,
      log: (entry) => {
        logs.push(entry)
      },
    },
    environment: { PATH: "/usr/bin", HOME: fixture.kernel.paths.appData },
    providerAdapters: { codex: provider },
    runStage,
  })
  const runtime = createGroupRuntime(fixture.kernel, engine)
  cleanups.add(async () => {
    finish.resolve()
    runtime.shutdown()
    await engine.shutdown()
    // A broken baseline can orphan executions; settle only this fixture's records so teardown can finish.
    persistence.listActiveRuns().forEach((run) => {
      const canceled: Run = { ...run, status: "canceled", errorClass: "canceled", finishedAt: Date.now() }
      persistence.saveRun(canceled)
      fixture.kernel.publish({ type: "run.updated", run: canceled })
    })
    await runtime.waitForDrain()
  })
  const send = () => {
    const message: Omit<Message, "createdAt" | "updatedAt"> = {
      id: fixture.kernel.newId(),
      threadId: thread.id,
      parentId: store.getThread({ threadId: thread.id })?.activeLeafId ?? null,
      role: "user",
      kind: "text",
      status: "complete",
      text: "@Teste confira o resultado sintético.",
      parts: [],
      runId: null,
      sender: null,
      source: "local",
    }
    const request = store.insertMessage({ message })
    if (!request.success) throw new Error(request.error)
    const queued = runtime.enqueue({ threadId: thread.id, requestMessageId: message.id, trigger: "user" })
    if (!queued.success) throw new Error(queued.error)

    return queued.run
  }
  const getMember = (turnId: string) => {
    const link = fixture.db.query("SELECT run_id FROM group_run_links WHERE turn_id = ?").get(turnId) as {
      run_id: string
    } | null
    const run = link ? persistence.getRun(link.run_id) : null
    if (!run) throw new Error("Missing fixture member run")

    return run
  }
  const getFinished = async (runId: string): Promise<void> => {
    const deadline = performance.now() + 30_000
    while (!["succeeded", "failed", "canceled"].includes(persistence.getRun(runId)?.status ?? "")) {
      if (performance.now() >= deadline) throw new Error("Synthetic channel request did not finish")
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
  }

  return {
    store,
    engine,
    persistence,
    started,
    finish,
    logs,
    notifications,
    send,
    getMember,
    getFinished,
    threadId: thread.id,
    getStartCount: () => startCount,
  }
}

const runCleanups = async (remaining: ReadonlyArray<() => void | Promise<void>>): Promise<void> => {
  const [cleanup, ...rest] = remaining
  if (!cleanup) return

  await runCleanups(rest)
  await cleanup()
}
