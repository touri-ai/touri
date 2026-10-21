import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBrowserEngine } from "../../src/browser/engine"
import { createBrowserHandoffs } from "../../src/browser/handoffs"
import { createKernel } from "../../src/kernel"
import { createRuntimePersistence } from "../../src/runtime/persistence"

const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup()
  cleanups.clear()
})

test("a waiting handoff survives browser shutdown with its original deadline and resumes once", async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-handoff-recovery-"))
  const runtime = createKernel({ appData: root })
  const database = runtime.kernel.db as Database
  database.exec(`
    INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('bot','Lia','codex','/workspace/lia',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('thread','bot','Test',1,1);
    INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at) VALUES ('old','thread','bot','codex','user','succeeded',1);
    INSERT INTO browser_tabs(id,owner_bot_id,owner_thread_id,url,state,created_at,last_used_at)
      VALUES ('tab','bot','thread','https://travel.example.test/login','unloaded',1,1);
  `)
  const engines = new Set<ReturnType<typeof createBrowserEngine>>()
  cleanups.add(async () => {
    for (const engine of engines) await engine.shutdown()
    await runtime.stop()
    await rm(root, { recursive: true })
  })
  const getEngine = () => {
    const engine = createBrowserEngine({
      kernel: runtime.kernel,
      launcher: { start: async () => null, stop: async () => {} },
    })
    engines.add(engine)
    return engine
  }
  const ledger = createBrowserHandoffs(database)
  const first = getEngine()
  await first.requestTakeover({
    tabId: "tab",
    botId: "bot",
    threadId: "thread",
    runId: "old",
    reason: "login",
    timeoutMs: 120_000,
    signal: new AbortController().signal,
  })
  const persistence = createRuntimePersistence({ database })
  expect(persistence.getRunSnapshots(["old"])[0]?.browserWaitingForPerson).toBe(true)
  const deadline = ledger.get("tab")?.expiresAt
  await first.shutdown()
  let resumed = 0
  runtime.kernel.services.provide("runtime.resumeAfterBrowserTakeover", () => {
    resumed += 1
    database.exec(`
      INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at) VALUES ('resumed','thread','bot','codex','retry','succeeded',2);
      INSERT INTO browser_takeover_continuations VALUES ('resumed','old','old',2);
    `)
    return true
  })

  const restored = getEngine()
  expect(ledger.get("tab")?.expiresAt).toBe(deadline)
  expect(restored.tabsForBot("bot")[0]?.heldByUser).toBe(true)
  expect(await restored.releaseTakeover("tab")).toBe(true)
  expect(await restored.releaseTakeover("tab")).toBe(true)
  await restored.shutdown()
  const again = getEngine()

  expect(resumed).toBe(1)
  expect(ledger.get("tab")).toBeNull()
  expect(persistence.getRunSnapshots(["old"])[0]?.browserWaitingForPerson).not.toBe(true)
  await again.holdTakeover({ tabId: "tab", reason: "fixture", runId: "resumed" })
  expect(ledger.get("tab")?.runId).toBe("resumed")
  expect(persistence.getRunSnapshots(["resumed"])[0]?.browserWaitingForPerson).toBe(true)
})


test("legacy held tabs without a handoff deadline release safely on startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-handoff-orphan-"))
  const runtime = createKernel({ appData: root })
  const database = runtime.kernel.db as Database
  database.exec(`
    INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('bot','Lia','codex','/workspace/lia',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('thread','bot','Test',1,1);
    INSERT INTO browser_tabs(id,owner_bot_id,owner_thread_id,url,state,held_by_user,takeover_reason,created_at,last_used_at)
      VALUES ('orphan','bot','thread','https://travel.example.test/login','unloaded',1,'login',1,1);
  `)
  const engine = createBrowserEngine({
    kernel: runtime.kernel,
    launcher: { start: async () => null, stop: async () => {} },
  })
  cleanups.add(async () => {
    await engine.shutdown()
    await runtime.stop()
    await rm(root, { recursive: true })
  })

  const restored = engine.tabsForBot("bot")[0]

  expect(restored?.heldByUser).toBe(false)
  expect(restored?.takeoverRequested).toBe(false)
  expect(restored?.url).toBe("https://travel.example.test")
  expect(
    database
      .query("SELECT held_by_user, private_after_takeover, private_input FROM browser_tabs WHERE id = 'orphan'")
      .get(),
  ).toEqual({
    held_by_user: 0,
    private_after_takeover: 1,
    private_input: 1,
  })
})
