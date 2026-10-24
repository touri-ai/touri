import { afterEach, expect, mock, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Kernel } from "@touri/contracts"
import { deletedBrowserSessionKey, retryDeletedBrowserSessionKeys } from "../../src/browser/sessionVault"
import { createStorageMaintenance } from "../../src/kernel/data-maintenance"
import { openDatabase } from "../../src/kernel/db"

// Resource handles are registered locally for the test runner's teardown lifecycle.
const cleanups = new Set<() => void | Promise<void>>()
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup()
  cleanups.clear()
})

const makeDatabase = () => {
  const appData = mkdtempSync(join(tmpdir(), "touri-session-cleanup-"))
  const database = openDatabase({ filename: join(appData, "test.db") })
  const close = () => {
    database.close()
    rmSync(appData, { recursive: true, force: true })
  }
  cleanups.add(close)
  return { database, appData, close }
}

const waitUntil = async (ready: () => boolean) => {
  const deadline = Date.now() + 3000
  while (!ready() && Date.now() < deadline) await Bun.sleep(10)
  expect(ready()).toBe(true)
}

const makeMaintenance = (retry: (signal: AbortSignal) => Promise<void>) => {
  const fixture = makeDatabase()
  fixture.database.exec(`
    INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('bot','Teste','codex','/tmp',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('thread','bot','Teste',1,1);
    WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM rows WHERE n<151)
    INSERT INTO messages(id,thread_id,role,kind,status,text,parts_json,created_at,updated_at)
    SELECT 'message-' || n,'thread','assistant','text','complete','Teste','[]',1,1 FROM rows;
  `)
  const onError = mock(() => {})
  const publishResync = mock(() => {})
  const maintenance = createStorageMaintenance({
    ...fixture,
    retryDeletedBrowserSessionKeys: retry,
    publishResync,
    onError,
  })
  cleanups.delete(fixture.close)
  cleanups.add(async () => {
    await maintenance.dispose()
    fixture.close()
  })
  return { ...fixture, maintenance, onError, publishResync }
}

test("a failed key cleanup runs once while message compaction advances through several batches", async () => {
  const retry = mock(async () => {
    throw new Error("synthetic vault failure")
  })
  const fixture = makeMaintenance(retry)

  await waitUntil(() => fixture.maintenance.snapshot().processed === 151 && !fixture.maintenance.snapshot().running)
  await fixture.maintenance.dispose()

  expect(retry).toHaveBeenCalledTimes(1)
  expect(fixture.onError).toHaveBeenCalledTimes(1)
  expect(fixture.maintenance.snapshot().error).toBeUndefined()
})

test("a hanging key cleanup cannot block compaction or overlap another cleanup batch", async () => {
  const retry = mock(() => new Promise<void>(() => {}))
  const fixture = makeMaintenance(retry)

  await waitUntil(() => fixture.maintenance.snapshot().processed === 151 && !fixture.maintenance.snapshot().running)
  fixture.maintenance.scheduleSessionKeyRetry()
  fixture.maintenance.scheduleSessionKeyRetry()
  await Bun.sleep(150)

  expect(retry).toHaveBeenCalledTimes(1)
  expect(fixture.onError).not.toHaveBeenCalled()
  expect(fixture.publishResync).not.toHaveBeenCalled()
})

test("key cleanup rotates past ten permanent failures and keeps the cursor across restarts", async () => {
  const { database } = makeDatabase()
  const ids = Array.from({ length: 13 }, (_, index) => `bot-${String(index).padStart(2, "0")}`)
  ids.forEach((id) => {
    database.query("INSERT INTO settings VALUES (?,?,?)").run(deletedBrowserSessionKey(id), "true", 1)
  })
  const callHost = mock(async (_method: string, params: { account: string }) => ({
    success: params.account >= "browser-session-key:bot-10",
    value: {},
  })) as Kernel["callHost"]
  const kernel = { db: database, callHost, log: mock(() => {}), redact: (text: string) => text }

  await retryDeletedBrowserSessionKeys(kernel)
  await retryDeletedBrowserSessionKeys({ ...kernel })

  expect(callHost).toHaveBeenCalledTimes(20)
  ids.slice(10).forEach((id) => {
    expect(database.query("SELECT key FROM settings WHERE key = ?").get(deletedBrowserSessionKey(id))).toBeNull()
  })
  ids.slice(0, 10).forEach((id) => {
    expect(database.query("SELECT key FROM settings WHERE key = ?").get(deletedBrowserSessionKey(id))).not.toBeNull()
  })
})

test("disposing a pending key cleanup prevents further database writes", async () => {
  const { database } = makeDatabase()
  database.query("INSERT INTO settings VALUES (?,?,?)").run(deletedBrowserSessionKey("bot"), "true", 1)
  const response = Promise.withResolvers<{ success: true; value: Record<string, never> }>()
  const controller = new AbortController()
  const kernel = {
    db: database,
    callHost: mock(() => response.promise) as Kernel["callHost"],
    log: mock(() => {}),
    redact: (text: string) => text,
  }
  const pending = retryDeletedBrowserSessionKeys(kernel, controller.signal)

  controller.abort()
  response.resolve({ success: true, value: {} })
  await pending

  expect(database.query("SELECT key FROM settings WHERE key = ?").get(deletedBrowserSessionKey("bot"))).not.toBeNull()
  expect(kernel.log).not.toHaveBeenCalled()
})
