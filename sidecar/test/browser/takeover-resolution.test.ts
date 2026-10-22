import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBrowserEngine } from "../../src/browser/engine"
import { createKernel } from "../../src/kernel"

const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup()
  cleanups.clear()
})

test("an expired browser handoff resolves channel attention without resuming the bot", async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-browser-expiry-"))
  const runtime = createKernel({ appData: root })
  const database = runtime.kernel.db as Database
  database.exec(`
    INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('leo','Léo','codex','/workspace',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('thread','leo','Synthetic',1,1);
    INSERT INTO browser_tabs(id,owner_bot_id,owner_thread_id,url,state,created_at,last_used_at)
      VALUES ('tab','leo','thread','https://example.test/login','live',1,1);
  `)
  const engine = createBrowserEngine({
    kernel: runtime.kernel,
    launcher: { start: async () => null, stop: async () => {} },
  })
  cleanups.add(async () => {
    await engine.shutdown()
    runtime.stop()
    await rm(root, { recursive: true, force: true })
  })
  let resumeCount = 0
  runtime.kernel.services.provide("runtime.resumeAfterBrowserTakeover", () => {
    resumeCount += 1
    return true
  })
  const resolution = new Promise<unknown>((resolve) => {
    runtime.kernel.services.provide("browser.takeoverResolved", resolve)
  })

  await engine.requestTakeover({
    tabId: "tab",
    botId: "leo",
    threadId: "thread",
    runId: "run",
    reason: "login",
    timeoutMs: 1,
    signal: new AbortController().signal,
    notify: false,
  })

  expect(await resolution).toEqual({ tabId: "tab", resolution: "expired" })
  expect(engine.tabsForBot("leo")[0]?.heldByUser).toBe(false)
  expect(resumeCount).toBe(0)
})
