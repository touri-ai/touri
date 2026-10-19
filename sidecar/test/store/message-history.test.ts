import type { Database } from "bun:sqlite"
import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createKernel } from "../../src/kernel"
import { createRuntimeEngine } from "../../src/runtime/engine"
import { summarizeToolResolutions } from "../../src/runtime/tool-resolution-summary"
import { createToolResolutions, PENDING_TOOL_RECOVERY_SQL } from "../../src/runtime/tool-resolutions"
import { init as initStore } from "../../src/store"

const fixtures = new Set<Awaited<ReturnType<typeof getFixture>>>()

afterEach(async () => {
  for (const fixture of fixtures) await fixture.close()
  fixtures.clear()
})

test("bounded paths preserve order, branch membership and an explicit leaf", async () => {
  const fixture = await getFixture()
  fixtures.add(fixture)
  const { store } = fixture
  const getIds = (options: Parameters<typeof store.activePath>[0]) =>
    store.activePath(options).map((message) => message.id)

  expect(getIds({ threadId: "thread", limit: 2 })).toEqual(["request-a", "reply-a"])
  expect(getIds({ threadId: "thread", limit: 1, fromRoot: true })).toEqual(["root"])
  expect(getIds({ threadId: "thread", limit: 0, fromRoot: true })).toEqual([])
  expect(getIds({ threadId: "thread", leafId: "reply-b" })).toEqual(["root", "request-b", "reply-b"])
  expect(store.getPathMessage?.({ threadId: "thread", messageId: "root" })?.id).toBe("root")
  expect(store.getPathMessage?.({ threadId: "thread", messageId: "request-b" })).toBeNull()
  expect(store.getPathMessage?.({ threadId: "thread", messageId: "reply-b", leafId: "reply-b" })?.id).toBe("reply-b")
})

test("cyclic and missing parents terminate without repeating messages", async () => {
  const fixture = await getFixture()
  fixtures.add(fixture)
  const { database, store } = fixture
  database.exec("UPDATE messages SET parent_id = 'reply-a' WHERE id = 'root'")

  expect(store.activePath({ threadId: "thread" }).map((message) => message.id)).toEqual([
    "root",
    "request-a",
    "reply-a",
  ])
  expect(store.getPathMessage?.({ threadId: "thread", messageId: "absent" })).toBeNull()
  database.exec("UPDATE messages SET parent_id = 'missing' WHERE id = 'root'")
  expect(store.activePath({ threadId: "thread" })).toHaveLength(3)
})

test("reconciliation selects the latest thirty tools on the requested branch without hydrating history", async () => {
  const fixture = await getFixture()
  fixtures.add(fixture)
  const { database, store } = fixture
  database.transaction(() => {
    Array.from({ length: 80 }, (_, index) => index).forEach((index) => {
      const callId = `call-${String(index).padStart(3, "0")}`
      const part = {
        type: "tool_call",
        callId,
        tool: "fixture_tool",
        inputJson: "{}",
        outputJson: "resultado",
        ok: true,
      }
      database
        .query(`INSERT INTO tool_resolutions(run_id,call_id,thread_id,part_json,resolution)
        VALUES ('run-a',?,'thread',?,'completed_unobserved')`)
        .run(callId, JSON.stringify(part))
    })
    database
      .query(`INSERT INTO tool_resolutions(run_id,call_id,thread_id,part_json,resolution)
      VALUES ('run-b','other-branch','thread',?,'completed_unobserved')`)
      .run(
        JSON.stringify({
          type: "tool_call",
          callId: "other-branch",
          tool: "other_tool",
          inputJson: "{}",
          outputJson: "outro",
          ok: true,
        }),
      )
  })()
  const path = getPathSpy(store)
  fixture.restore.add(path.restore)

  const summary = summarizeToolResolutions(database, store, "thread", "reply-a")

  expect(path.getCalls()).toBe(0)
  expect(summary).toContain("call-050")
  expect(summary).toContain("call-079")
  expect(summary).not.toContain("call-049")
  expect(summary).not.toContain("other-branch")
  expect(summary).toContain("history_read")
  expect(summary?.match(/fixture_tool/g)).toHaveLength(30)
})

test("mirroring a settled reply does not requeue its tools", async () => {
  const fixture = await getFixture()
  fixtures.add(fixture)
  const { database, store, kernel } = fixture
  const tools = createToolResolutions(kernel)
  await tools.reconcile(store)
  database.exec(`INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('shared','bot','Grupo',1,1);
    INSERT INTO messages(id,thread_id,role,kind,status,run_id,text,created_at,updated_at)
      VALUES ('mirror','shared','assistant','text','complete','run-a','Resposta A',1,1);
    UPDATE messages SET parts_json = '[{"type":"text","text":"Resposta A"}]' WHERE id = 'mirror';`)

  expect(database.query("SELECT run_id FROM tool_recovery_pending").all()).toEqual([])

  const importedParts = JSON.stringify([
    {
      type: "tool_call",
      callId: "imported",
      tool: "fixture_tool",
      summary: "Resultado importado",
      inputJson: "{}",
      outputJson: "preservado",
      ok: true,
    },
  ])
  database.query("UPDATE messages SET parts_json = ? WHERE thread_id = 'thread' AND id = 'reply-a'").run(importedParts)
  expect(database.query("SELECT run_id,thread_id FROM tool_recovery_pending").all()).toEqual([
    { run_id: "run-a", thread_id: "thread" },
  ])

  await tools.reconcilePending(store, "thread")

  expect(database.query("SELECT run_id FROM tool_recovery_pending").all()).toEqual([])
})

test("late imported results enter an indexed recovery queue and remain pending after a failed repair", async () => {
  const fixture = await getFixture()
  fixtures.add(fixture)
  const { database, store, kernel } = fixture
  const tools = createToolResolutions(kernel)
  await tools.reconcile(store)
  const explain = database.prepare(`EXPLAIN QUERY PLAN ${PENDING_TOOL_RECOVERY_SQL} AND p.thread_id = ?`)
  const plan = (explain.all("thread") as Array<{ detail: string }>).map((row) => row.detail).join("\n")
  explain.finalize()
  database
    .query(`INSERT INTO tool_resolutions(run_id,call_id,thread_id,part_json,resolution)
    VALUES ('run-a','late-result','thread',?,'succeeded')`)
    .run(
      JSON.stringify({
        type: "tool_call",
        callId: "late-result",
        tool: "fixture_tool",
        summary: "Resultado importado",
        inputJson: "{}",
        outputJson: "resultado preservado",
        ok: true,
      }),
    )
  database.exec(`CREATE TEMP TRIGGER reject_recovery BEFORE UPDATE OF parts_json ON messages
    WHEN NEW.id = 'reply-a' BEGIN SELECT RAISE(ABORT, 'retry recovery'); END`)

  await expect(tools.reconcilePending(store, "thread")).rejects.toThrow("retry recovery")

  expect(plan).toContain("tool_recovery_thread")
  expect(database.query("SELECT run_id FROM tool_recovery_pending").all()).toEqual([{ run_id: "run-a" }])
  expect(database.query("SELECT resolution FROM tool_resolutions WHERE call_id = 'late-result'").get()).toEqual({
    resolution: "succeeded",
  })

  database.exec("DROP TRIGGER reject_recovery")
  await tools.reconcilePending(store, "thread")
  const changes = database.query("SELECT total_changes() AS n").get()
  await tools.reconcilePending(store, "thread")

  expect(database.query("SELECT total_changes() AS n").get()).toEqual(changes)
  expect(database.query("SELECT run_id FROM tool_recovery_pending").all()).toEqual([])
  expect(store.getPathMessage?.({ threadId: "thread", messageId: "reply-a" })?.parts).toContainEqual(
    expect.objectContaining({
      callId: "late-result",
      outputJson: "resultado preservado",
      resolution: "completed_unobserved",
    }),
  )
})

test("normal terminal transitions consume their recovery marker atomically", async () => {
  const fixture = await getFixture()
  fixtures.add(fixture)
  const { database, store, kernel } = fixture
  const engine = createRuntimeEngine({
    kernel,
    environment: { PATH: "/usr/bin", HOME: kernel.paths.appData },
    providerAdapters: {
      codex: {
        provider: "codex",
        detect: async () => ({ success: true, path: "/tmp/fixture-provider", version: "1", loggedIn: true }),
        startTurn: async (args) => {
          args.onEvent({ type: "turn_started", externalTurnId: "fixture-turn" })
          args.onEvent({ type: "text_delta", itemId: "reply", delta: "Concluído." })
          return { success: true, externalSessionId: "fixture-session", rolloutPath: null, status: "succeeded" }
        },
        answerApproval: async () => ({ success: true }),
        shutdown: async () => {},
      },
    },
  })
  fixture.restore.add(() => engine.shutdown())

  const queued = engine.enqueue({ threadId: "thread", requestMessageId: "request-a", trigger: "user" })
  if (!queued.success) throw new Error(queued.error)
  await getReady(() => engine.listRuns("thread").find((run) => run.id === queued.run.id)?.status === "succeeded")

  expect(database.query("SELECT run_id FROM tool_recovery_pending").all()).toEqual([])
  expect(store.activePath({ threadId: "thread" }).at(-1)?.text).toBe("Concluído.")
})

const getReady = async (ready: () => boolean): Promise<void> => {
  const deadline = performance.now() + 10_000
  while (!ready()) {
    if (performance.now() > deadline) throw new Error("Fixture turn did not finish")
    await Bun.sleep(2)
  }
}

const getPathSpy = (store: Awaited<ReturnType<typeof getFixture>>["store"]) => {
  const path = spyOn(store, "activePath")
  return { getCalls: () => path.mock.calls.length, restore: () => path.mockRestore() }
}

const getOfflineRuntime = (root: string) => {
  const serve = spyOn(Bun, "serve").mockReturnValue({ port: 0, stop: () => {} } as ReturnType<typeof Bun.serve>)
  try {
    return createKernel({ appData: root })
  } finally {
    serve.mockRestore()
  }
}

const getFixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-message-history-"))
  const runtime = getOfflineRuntime(root)
  runtime.kernel.services.use("storage.maintenance")?.dispose()
  await initStore(runtime.kernel)
  const database = runtime.kernel.db as Database
  database
    .query("INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('bot','Teste','codex',?,1,1)")
    .run(join(root, "bot"))
  database.exec(`INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('thread','bot','Conversa',1,1);
    INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,request_message_id,queued_at) VALUES
      ('run-a','thread','bot','codex','user','succeeded','request-a',1),
      ('run-b','thread','bot','codex','user','succeeded','request-b',2);
    INSERT INTO messages(id,thread_id,parent_id,role,kind,status,run_id,text,created_at,updated_at) VALUES
      ('root','thread',NULL,'user','text','complete',NULL,'Raiz',1,1),
      ('request-a','thread','root','user','text','complete',NULL,'A',2,2),
      ('reply-a','thread','request-a','assistant','text','complete','run-a','Resposta A',3,3),
      ('request-b','thread','root','user','text','complete',NULL,'B',4,4),
      ('reply-b','thread','request-b','assistant','text','complete','run-b','Resposta B',5,5);
    UPDATE threads SET active_leaf_id = 'reply-a' WHERE id = 'thread';`)
  const store = runtime.kernel.services.use("store.api")
  if (!store) throw new Error("Missing store")
  const restore = new Set<() => void | Promise<void>>()

  return {
    database,
    store,
    kernel: runtime.kernel,
    restore,
    close: async () => {
      for (const callback of restore) await callback()
      runtime.stop()
      rmSync(root, { recursive: true, force: true })
    },
  }
}
