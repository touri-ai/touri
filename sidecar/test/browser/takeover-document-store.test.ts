import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBrowserStore } from "../../src/browser/store"
import { createKernel } from "../../src/kernel"

const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup()
  cleanups.clear()
})

test("private document provenance survives reopening without storing typed URL or title values", async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-private-document-"))
  const runtime = createKernel({ appData: root })
  cleanups.add(async () => {
    runtime.stop()
    await rm(root, { recursive: true, force: true })
  })
  const database = runtime.kernel.db as Database
  database.exec(`
    INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('leo','Léo','codex','/workspace',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('thread','leo','Synthetic',1,1);
  `)
  const store = createBrowserStore({ kernel: runtime.kernel })
  const tab = store.create({
    botId: "leo",
    threadId: "thread",
    url: "https://example.test",
    openerTabId: null,
    targetId: "owned-tab",
  })
  Object.assign(tab, { privateInput: true, privateAfterTakeover: true, privateDocumentIds: [100] })
  Object.assign(tab.info, {
    url: "https://private-fixture-value.example.test/private-fixture-value?token=private-fixture-value",
    title: "private-fixture-value",
  })

  store.save(tab)
  const persisted = database.query("SELECT * FROM browser_tabs WHERE id = ?").get(tab.info.tabId)
  const reopened = createBrowserStore({ kernel: runtime.kernel }).load()[0]

  expect(JSON.stringify(persisted)).not.toContain("private-fixture-value")
  expect(persisted).toMatchObject({ url: "", title: "", private_document_ids_json: "[100]" })
  expect(reopened?.privateDocumentIds).toEqual([100])
  expect(reopened?.privateAfterTakeover).toBe(true)
})
