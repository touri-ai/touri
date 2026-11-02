import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { UiEvent } from "@touri/contracts"
import { startMessageThread } from "../../src/groups/start-thread"
import { createKernel } from "../../src/kernel"
import { init as initStore } from "../../src/store"

const cleanups = new Set<() => void | Promise<void>>()
afterEach(async () => {
  await Array.from(cleanups).reduceRight(async (previous, cleanup) => {
    await previous
    await cleanup()
  }, Promise.resolve())
  cleanups.clear()
})

test("thread creation waits behind admitted events and publishes its committed context once", async () => {
  const fixture = await getFixture()
  const events = new Map<number, UiEvent>()
  cleanups.add(fixture.host.kernel.subscribe(({ seq, event }) => events.set(seq, event)))
  fixture.lock.exec("BEGIN IMMEDIATE")
  fixture.host.kernel.publish({ type: "import.progress", importId: "fixture", phase: "saving", done: 1, total: 1 })
  fixture.lock.exec("COMMIT")

  const thread = await startMessageThread(fixture.host.kernel, fixture.parent, fixture.message, "Planejamento")
  const repeated = await startMessageThread(fixture.host.kernel, fixture.parent, fixture.message, "Planejamento")
  await fixture.host.kernel.flushEvents?.()

  expect(repeated.id).toBe(thread.id)
  expect(thread).toMatchObject({
    parentThreadId: fixture.parent.id,
    anchorMessageId: fixture.message.id,
    title: "Planejamento",
  })
  expect(fixture.store.activePath({ threadId: thread.id }).map(({ text }) => text)).toEqual([fixture.message.text])
  const published = Array.from(events.values())
  const updates = published.flatMap((event) =>
    event.type === "thread.updated" && event.thread.id === thread.id ? [event.thread.activeLeafId] : [],
  )
  expect(updates).toEqual([null, thread.activeLeafId])
  expect(published[0]?.type).toBe("import.progress")
  expect(fixture.database.inTransaction).toBe(false)
  expect(fixture.database.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5_000 })
})

test("thread creation rechecks authorization after yielding to a held writer", async () => {
  const fixture = await getFixture()
  const controller = new AbortController()
  fixture.lock.exec("BEGIN IMMEDIATE")

  const creating = startMessageThread(
    fixture.host.kernel,
    fixture.parent,
    fixture.message,
    undefined,
    () => !controller.signal.aborted,
  )
  controller.abort()
  fixture.lock.exec("COMMIT")

  await expect(creating).rejects.toThrow("Mensagem indisponível")
  expect(fixture.database.query("SELECT id FROM threads WHERE anchor_message_id = ?").all(fixture.message.id)).toEqual(
    [],
  )
})

test("thread creation yields to release a held writer before inserting its context", async () => {
  const fixture = await getFixture()
  fixture.lock.exec("BEGIN IMMEDIATE")
  const release = Promise.withResolvers<void>()
  const immediate = setImmediate(() => {
    fixture.lock.exec("COMMIT")
    release.resolve()
  })
  cleanups.add(() => clearImmediate(immediate))

  const creating = startMessageThread(fixture.host.kernel, fixture.parent, fixture.message)
  await release.promise
  const thread = await creating

  expect(fixture.store.activePath({ threadId: thread.id })).toHaveLength(1)
  expect(
    fixture.database.query("SELECT id FROM threads WHERE anchor_message_id = ?").all(fixture.message.id),
  ).toHaveLength(1)
})

const getFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-thread-write-"))
  cleanups.add(() => rm(root, { recursive: true, force: true }))
  const host = createKernel({ appData: root })
  cleanups.add(() => host.stop())
  await initStore(host.kernel)
  const database = host.kernel.db as Database
  const settings = host.kernel.services.use("store.settings")?.()
  if (!settings) throw new Error("Settings missing")
  database
    .query("INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('bot','Lia',?,?,1,1)")
    .run(settings.defaultProvider, root)
  const store = host.kernel.services.use("store.api")
  if (!store) throw new Error("Store missing")
  const parent = store.createThread({ botId: "bot", kind: "chat", title: "Conversa" })
  if (!parent.success) throw new Error(parent.error)
  const inserted = store.insertMessage({
    message: {
      id: "request",
      threadId: parent.thread.id,
      parentId: null,
      role: "user",
      kind: "text",
      status: "complete",
      runId: null,
      text: "Crie uma thread para planejar.",
      parts: [],
      sender: null,
      source: "local",
    },
  })
  if (!inserted.success) throw new Error(inserted.error)
  await host.kernel.flushEvents?.()
  const lock = new Database(database.filename)
  cleanups.add(() => lock.close())
  cleanups.add(() => {
    if (lock.inTransaction) lock.exec("ROLLBACK")
  })

  return { host, database, lock, store, parent: parent.thread, message: inserted.message }
}
