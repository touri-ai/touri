import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import type { MessagePart, ProviderAdapter, StartTurnArgs, StartTurnResult } from "@touri/contracts"
import { createGroupRuntime } from "../../src/groups/runtime"
import { createGroupStore } from "../../src/groups/store"
import { createRuntimeEngine } from "../../src/runtime/engine"
import { SESSION_RECOVERY_MESSAGE } from "../../src/runtime/session-recovery"
import { init as initStore } from "../../src/store"
import { testKernel } from "../kernel/test-kernel"

const cleanups = new Set<() => Promise<void>>()
setDefaultTimeout(20_000)

afterEach(async () => {
  for (const cleanup of cleanups) await cleanup()
  cleanups.clear()
})

test.each([false, true])("restart mid-tool resumes a healthy native session (channel: %s)", async (channel) => {
  const f = await getFixture({ channel, outcome: "healthy" })
  f.send("Conclua o relatório de demonstração.")
  await getUntil(() => f.turns.length === 1)

  await f.restart()
  await getUntil(() => f.getRuns()[0]?.status === "succeeded")

  expect(f.turns).toHaveLength(2)
  expect(f.turns[1]?.session?.externalSessionId).toBe("interrupted-session")
  expect(f.getParts().some((part) => part.type === "text" && part.text.includes("Retomada nativa concluída"))).toBe(
    true,
  )
})

test.each([false, true])("restart mid-tool recovers a rejected session (channel: %s)", async (channel) => {
  const f = await getFixture({ channel, outcome: "rejected" })
  const original = f.send("Confira o relatório de demonstração e conclua a tarefa.")
  await getUntil(() => f.turns.length === 1)

  await f.restart()
  await getUntil(() => f.getRuns()[0]?.status === "succeeded")

  expect(f.turns).toHaveLength(3)
  expect(f.turns[1]?.session?.externalSessionId).toBe("interrupted-session")
  expect(f.turns[2]?.session).toBeNull()
  expect(f.turns[2]?.handoffPacket).toContain("Confira o relatório de demonstração")
  expect(f.turns[2]?.handoffPacket).toContain("Etapa inicial salva")
  expect(f.turns[2]?.handoffPacket).toContain("untrusted reference data")
  expect(f.turns[2]?.handoffPacket?.length).toBeLessThanOrEqual(32_000)
  expect(f.getRuns().find((run) => run.id === original.id)?.status).toBe("interrupted")
  expect(f.getParts().filter((part) => part.type === "notice" && part.text === SESSION_RECOVERY_MESSAGE)).toHaveLength(
    1,
  )
  expect(f.getExecutionCount()).toBe(2)

  const followup = f.send("Agora confirme o total, sem repetir a tarefa.")
  const repeated = f.enqueue(followup.requestMessageId ?? "")
  await getUntil(() => f.getRuns()[0]?.status === "succeeded")

  expect(repeated.id).toBe(followup.id)
  expect(f.turns).toHaveLength(4)
  expect(f.turns[3]?.session?.externalSessionId).toBe("recovered-session")

  const lateReplay = f.enqueue(followup.requestMessageId ?? "")
  expect(lateReplay.id).toBe(followup.id)
  expect(f.getExecutionCount()).toBe(3)
  expect(f.getRequestPlan()).toContain("runs_request")

  f.addLaterRuns()
  expect(f.enqueue(followup.requestMessageId ?? "").id).toBe(followup.id)
  expect(f.turns).toHaveLength(4)
})

test.each(["empty", "reasoning", "notice"] as const)(
  "an initialized %s resume retries inside the same run",
  async (outcome) => {
    const f = await getFixture({ outcome })
    f.send("Prepare o relatório de demonstração.")
    await getUntil(() => f.turns.length === 1)

    await f.restart()
    await getUntil(() => f.getRuns()[0]?.status === "succeeded")

    expect(f.turns).toHaveLength(3)
    expect(f.getRuns()).toHaveLength(2)
    expect(f.getRuns()[0]).toMatchObject({ status: "succeeded", errorClass: null })
    expect(f.getParts().some((part) => part.type === "text" && part.text.includes("Relatório concluído"))).toBe(true)
  },
)

test("a fresh session that is also empty fails visibly without a retry loop", async () => {
  const f = await getFixture({ outcome: "empty", freshEmpty: true, channel: true })
  f.send("Prepare o relatório de demonstração.")
  await getUntil(() => f.turns.length === 1)

  await f.restart()
  await getUntil(() => f.getRuns()[0]?.status === "failed")

  expect(f.turns).toHaveLength(3)
  expect(f.getRuns()[0]).toMatchObject({ errorClass: "cli_protocol" })
  expect(f.getParts().some((part) => part.type === "notice" && part.text === SESSION_RECOVERY_MESSAGE)).toBe(true)
})

test.each(["auth", "tool", "approval", "canceled"] as const)(
  "a %s result never starts a fresh session",
  async (outcome) => {
    const f = await getFixture({ outcome })
    f.send("Prepare o relatório de demonstração.")
    await getUntil(() => f.turns.length === 1)

    await f.restart()
    await getUntil(() => ["failed", "canceled"].includes(f.getRuns()[0]?.status ?? ""))

    expect(f.turns).toHaveLength(2)
    expect(f.getParts().some((part) => part.type === "notice" && part.text === SESSION_RECOVERY_MESSAGE)).toBe(false)
    if (outcome === "auth") expect(f.getRuns()[0]?.errorClass).toBe("cli_auth")
  },
)

type Outcome = "healthy" | "rejected" | "empty" | "reasoning" | "notice" | "auth" | "tool" | "approval" | "canceled"

const getFixture = async ({
  channel = false,
  outcome,
  freshEmpty = false,
}: {
  channel?: boolean
  outcome: Outcome
  freshEmpty?: boolean
}) => {
  const fixture = testKernel()
  await initStore(fixture.kernel)
  fixture.db
    .query(`INSERT INTO bots(id,name,provider,provider_profile,home_dir,browser_enabled,notifications,created_at,updated_at)
    VALUES ('bot','Demo','claude','fixture',?,0,'none',1,1)`)
    .run(fixture.kernel.paths.appData)
  fixture.db.exec("INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('direct','bot','Demo',1,1)")
  const store = fixture.kernel.services.use("store.api")
  if (!store) throw new Error("Missing store")
  const groupStore = createGroupStore(fixture.kernel)
  const group = channel
    ? groupStore.save({
        name: "Demo",
        color: "#888888",
        avatarShape: "cercle",
        memberIds: ["bot"],
        coordinatorBotId: null,
      })
    : null
  const threadId = group ? groupStore.createThread(group).id : "direct"
  const turns: StartTurnArgs[] = []
  const engines: ReturnType<typeof createRuntimeEngine>[] = []
  const groups: ReturnType<typeof createGroupRuntime>[] = []
  const adapter: ProviderAdapter = {
    provider: "claude",
    detect: async () => ({ success: true, path: "/tmp/demo-provider", version: "1", loggedIn: true }),
    startTurn: async (args) => {
      // Local traces preserve call order for assertions across runtime instances.
      turns.push(args)
      const sessionId = turns.length < 3 ? "interrupted-session" : "recovered-session"
      args.onEvent({ type: "session", externalSessionId: sessionId, rolloutPath: null })
      args.onEvent({ type: "turn_started", externalTurnId: `turn-${turns.length}` })
      if (turns.length === 1) {
        args.onEvent({ type: "text_delta", itemId: "initial", delta: "Etapa inicial salva." })
        args.onEvent({ type: "item", part: getTool() })
        return new Promise<StartTurnResult>((resolve) => {
          args.signal.addEventListener(
            "abort",
            () => resolve({ success: false, errorCode: "canceled", error: "Stopped" }),
            { once: true },
          )
        })
      }
      if (turns.length === 2) return getResumeResult(args, outcome)
      if (!freshEmpty) args.onEvent({ type: "text_delta", itemId: "final", delta: "Relatório concluído." })

      return { success: true, externalSessionId: sessionId, rolloutPath: null, status: "succeeded" }
    },
    answerApproval: async () => ({ success: true }),
    shutdown: async () => {},
  }
  const open = () => {
    const engine = createRuntimeEngine({
      kernel: fixture.kernel,
      providerAdapters: { claude: adapter },
      environment: { PATH: "/usr/bin:/bin", HOME: fixture.kernel.paths.appData },
    })
    engines.push(engine)
    if (channel) groups.push(createGroupRuntime(fixture.kernel, engine))
  }
  const stop = async () => {
    groups.at(-1)?.shutdown({ appRestart: true })
    await engines.at(-1)?.shutdown()
    await groups.at(-1)?.waitForDrain()
  }
  cleanups.add(async () => {
    await stop()
    fixture.close()
  })
  open()
  const enqueue = (requestMessageId: string) => {
    const runtime = channel ? groups.at(-1) : engines.at(-1)
    if (!runtime) throw new Error("Missing runtime")
    const result = runtime.enqueue({ threadId, requestMessageId, trigger: "user" })
    if (!result.success) throw new Error(result.error)

    return result.run
  }

  return {
    turns,
    enqueue,
    getRuns: () =>
      (channel ? groups.at(-1)?.listRuns(threadId) : engines.at(-1)?.listRuns(threadId))?.filter(
        (run) => !run.groupTurnId,
      ) ?? [],
    getParts: () => store.activePath({ threadId }).flatMap((message) => message.parts),
    getExecutionCount: () =>
      (
        fixture.db
          .query("SELECT COUNT(*) AS count FROM runs WHERE id NOT IN (SELECT run_id FROM group_turns)")
          .get() as { count: number }
      ).count,
    getRequestPlan: () =>
      JSON.stringify(
        fixture.db
          .query(
            "EXPLAIN QUERY PLAN SELECT * FROM runs WHERE thread_id = ? AND request_message_id = ? ORDER BY queued_at DESC, rowid DESC LIMIT 1",
          )
          .all(threadId, "request"),
      ),
    addLaterRuns: () => {
      const insert = fixture.db.query(
        "INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at,finished_at) VALUES (?,?,'bot','claude','user','failed',?,?)",
      )
      const now = Date.now()
      Array.from({ length: 60 }, (_, index) => index).forEach((index) => {
        insert.run(`later-${index}`, threadId, now + index, now + index)
      })
    },
    restart: async () => {
      await stop()
      open()
    },
    send: (text: string) => {
      const requestText = channel ? `@Demo ${text}` : text
      const result = store.insertMessage({
        message: {
          id: fixture.kernel.newId(),
          threadId,
          parentId: store.getThread({ threadId })?.activeLeafId ?? null,
          role: "user",
          kind: "text",
          status: "complete",
          runId: null,
          text: requestText,
          parts: [{ type: "text", text: requestText }],
          sender: null,
          source: "local",
        },
      })
      if (!result.success) throw new Error(result.error)

      return enqueue(result.message.id)
    },
  }
}

const getResumeResult = (args: StartTurnArgs, outcome: Outcome): StartTurnResult => {
  if (outcome === "healthy")
    args.onEvent({ type: "text_delta", itemId: "healthy", delta: "Retomada nativa concluída." })
  if (outcome === "auth") return { success: false, errorCode: "cli_auth", error: "login required" }
  if (outcome === "canceled") return { success: false, errorCode: "canceled", error: "Turno cancelado" }
  if (outcome === "tool") args.onEvent({ type: "item", part: { ...getTool(), ok: true } })
  if (outcome === "reasoning")
    args.onEvent({ type: "reasoning_delta", itemId: "thinking", delta: "Conferindo o histórico" })
  if (outcome === "notice")
    args.onEvent({
      type: "item",
      part: { type: "notice", code: "session_replaced", level: "info", text: "Inicializado" },
    })
  if (outcome === "approval")
    args.onEvent({
      type: "item",
      part: {
        type: "approval",
        approvalId: "approval",
        request: "command",
        detail: "Demonstração",
        decision: "pending",
      },
    })
  if (["rejected", "tool", "approval"].includes(outcome)) {
    args.onEvent({
      type: "turn_completed",
      status: "failed",
      errorClass: "cli_protocol",
      errorMessage: "Session cannot be resumed",
    })
    return { success: true, externalSessionId: "interrupted-session", rolloutPath: null, status: "failed" }
  }

  return { success: true, externalSessionId: "interrupted-session", rolloutPath: null, status: "succeeded" }
}

const getTool = (): Extract<MessagePart, { type: "tool_call" }> => ({
  type: "tool_call",
  callId: "demo-tool",
  tool: "Bash",
  summary: "Espera de demonstração",
  inputJson: '{"command":"sleep 120"}',
  outputJson: null,
  ok: null,
})

const getUntil = async (predicate: () => boolean) => {
  const deadline = Date.now() + 10_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Expected restart recovery did not finish")
    await Bun.sleep(5)
  }
}
