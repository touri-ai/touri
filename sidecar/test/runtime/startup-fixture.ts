import { afterEach, mock } from "bun:test"
import type { Kernel, ProviderAdapter, Run, StartTurnArgs, StartTurnResult } from "@touri/contracts"
import { createRuntimeEngine } from "../../src/runtime/engine"
import type { GoalDeadlineClock } from "../../src/runtime/goal-deadline"
import { createRuntimePersistence } from "../../src/runtime/persistence"
import { init as initStore } from "../../src/store"
import { testKernel } from "../kernel/test-kernel"

const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup()
  cleanups.clear()
})

export const getStartupFixture = async (
  options: { startTurn?: ProviderAdapter["startTurn"]; shellEnv?: Kernel["shellEnv"]; resume?: boolean } = {},
) => {
  const fixture = testKernel()
  const kernel = Object.assign({}, fixture.kernel, { shellEnv: options.shellEnv ?? fixture.kernel.shellEnv })
  await initStore(kernel)
  fixture.db
    .query(
      "INSERT INTO bots(id,name,provider,provider_profile,home_dir,browser_enabled,notifications,created_at,updated_at) VALUES ('b','Fixture','codex','fixture',?,0,'none',1,1)",
    )
    .run(kernel.paths.appData)
  fixture.db.exec(
    "INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('t','b','Fixture',1,1), ('next','b','Next',1,1)",
  )
  if (!options.resume)
    fixture.db.exec(
      "INSERT OR REPLACE INTO settings(key,value_json,updated_at) VALUES ('resumeInterruptedTurns','false',1)",
    )
  const store = kernel.services.use("store.api")
  if (!store) throw new Error("Missing store")
  const startTurn = mock(options.startTurn ?? getSuccessfulTurn)
  const adapter: ProviderAdapter = {
    provider: "codex",
    detect: async () => ({ success: true, path: "/workspace/provider", version: "1", loggedIn: true }),
    startTurn,
    answerApproval: async () => ({ success: true }),
    shutdown: async () => {},
  }
  const clock = getStartupClock()
  const engines = new Set<ReturnType<typeof createRuntimeEngine>>()
  const open = () => {
    const engine = createRuntimeEngine({
      kernel,
      providerAdapters: { codex: adapter },
      maxConcurrentRuns: 1,
      resumeBackoffMs: 0,
      startupDeadlineClock: clock,
    })
    engines.add(engine)
    return engine
  }
  const engine = open()
  const insertRequest = (threadId = "t") => {
    const id = `request-${threadId}-${kernel.newId()}`
    store.insertMessage({
      message: {
        id,
        threadId,
        parentId: null,
        role: "user",
        kind: "text",
        status: "complete",
        runId: null,
        text: "Organize as notas de exemplo.",
        parts: [
          { type: "text", text: "Organize as notas de exemplo." },
          { type: "image", attachmentId: "fixture-image", mime: "image/png" },
        ],
        sender: null,
        source: "local",
      },
    })
    return id
  }
  const enqueue = (threadId = "t", delegated = false): Run => {
    const requestMessageId = insertRequest(threadId)
    const result = engine.enqueue({ threadId, requestMessageId, trigger: "user", delegated })
    if (!result.success) throw new Error(result.error)
    return result.run
  }
  cleanups.add(async () => {
    for (const current of engines) await current.shutdown()
    fixture.close()
  })

  return Object.assign({}, fixture, {
    engine,
    open,
    kernel,
    store,
    clock,
    startTurn,
    enqueue,
    insertRequest,
    persistence: createRuntimePersistence({ database: fixture.db }),
  })
}

export const getSuccessfulTurn = async (args: StartTurnArgs): Promise<StartTurnResult> => {
  args.onEvent({ type: "session", externalSessionId: "fixture-session", rolloutPath: null })
  args.onEvent({ type: "turn_started", externalTurnId: "fixture-turn" })
  args.onEvent({ type: "text_delta", itemId: "fixture-answer", delta: "Notas organizadas." })
  return { success: true, externalSessionId: "fixture-session", rolloutPath: null, status: "succeeded" }
}

export const waitForStartup = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Run did not reach the expected state")
    await Bun.sleep(5)
  }
}

const getStartupClock = () => {
  // Only the injected timer registry and test clock advance; other runtime timers remain real.
  let timestamp = Date.now()
  const timers = new Map<symbol, { callback: () => void; at: number }>()
  const schedule: GoalDeadlineClock["schedule"] = (callback, delay) => {
    const id = Symbol()
    timers.set(id, { callback, at: timestamp + delay })
    return () => {
      timers.delete(id)
    }
  }

  return {
    now: () => timestamp,
    schedule,
    getPendingCount: () => timers.size,
    advanceBy: (milliseconds: number) => {
      timestamp += milliseconds
      Array.from(timers.entries())
        .filter(([, timer]) => timer.at <= timestamp)
        .forEach(([id, timer]) => {
          timers.delete(id)
          timer.callback()
        })
    },
  }
}
