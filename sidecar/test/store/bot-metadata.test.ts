import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../../src/kernel/db"
import { profileProviders } from "../../src/kernel/provider-profiles"
import { type BotMetadataEdit, createBotMetadataWriter } from "../../src/store/bot-metadata"

// Every fixture owns its helper and database until afterEach has released them.
const cleanups = new Set<() => void | Promise<void>>()
afterEach(async () => {
  await Array.from(cleanups).reduceRight(async (previous, cleanup) => {
    await previous
    await cleanup()
  }, Promise.resolve())
  cleanups.clear()
})

const makeFixture = async (onReady?: () => void | Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "touri-metadata-fixture-"))
  cleanups.add(() => rm(root, { recursive: true, force: true }))
  const database = openDatabase({ filename: join(root, "touri.db") })
  cleanups.add(() => database.close())
  database
    .query("INSERT INTO bots(id, name, provider, home_dir, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)")
    .run("fixture", "Bot de teste", profileProviders[0], "/workspace/bot")
  const select = "SELECT id, name, instructions_hash FROM bots WHERE id = ?"
  const expected = database.query(select).get("fixture") as Record<string, unknown>
  const writer = createBotMetadataWriter(database.filename, onReady)
  cleanups.add(writer.dispose)
  const edit: BotMetadataEdit = {
    botId: "fixture",
    select,
    expected,
    statement: { sql: "UPDATE bots SET name = ? WHERE id = ?", bindings: ["Nome atualizado", "fixture"] },
    instructions: "Texto fictício 😀\n".repeat(200_000),
  }
  return { database, writer, edit }
}

test("the isolated transaction saves full instructions and rejects a stale metadata snapshot", async () => {
  const f = await makeFixture()

  const updated = await f.writer.save(f.edit, new AbortController().signal)
  const stale = await f.writer.save(f.edit, new AbortController().signal)

  expect(updated).toMatchObject({ id: "fixture", name: "Nome atualizado" })
  expect(updated?.instructions_hash).toHaveLength(64)
  expect(stale).toBeUndefined()
  expect(f.database.query("SELECT instructions FROM bots WHERE id = ?").get("fixture")).toEqual({
    instructions: f.edit.instructions,
  })
})

test("a transaction failure rolls back every field and its acknowledgement marker", async () => {
  const f = await makeFixture()
  f.database.exec(
    "CREATE TRIGGER reject_metadata BEFORE UPDATE ON bots BEGIN SELECT RAISE(FAIL, 'synthetic failure'); END",
  )

  await expect(f.writer.save(f.edit, new AbortController().signal)).rejects.toThrow("commit failed")

  expect(f.database.query("SELECT name, instructions FROM bots WHERE id = ?").get("fixture")).toEqual({
    name: "Bot de teste",
    instructions: "",
  })
  expect(f.database.query("SELECT 1 FROM settings WHERE key = ?").get("bot-metadata:fixture")).toBeNull()
})

test("cancellation kills a helper blocked inside SQLite and leaves no partial edit", async () => {
  const reached = Promise.withResolvers<void>()
  const f = await makeFixture(() => reached.resolve())
  const controller = new AbortController()
  f.database.exec("BEGIN IMMEDIATE")
  cleanups.add(() => {
    if (f.database.inTransaction) f.database.exec("ROLLBACK")
  })
  const saved = f.writer.save(f.edit, controller.signal)
  const result = saved.catch((error: unknown) => error)
  await reached.promise

  controller.abort()
  const error = await result
  f.database.exec("ROLLBACK")

  expect(error).toBeInstanceOf(Error)
  expect(f.database.query("SELECT name, instructions FROM bots WHERE id = ?").get("fixture")).toEqual({
    name: "Bot de teste",
    instructions: "",
  })
})

test("a lost acknowledgement after COMMIT returns the atomically stored result", async () => {
  const committed = Promise.withResolvers<void>()
  const f = await makeFixture(async () => {
    await committed.promise
    throw new Error("Synthetic acknowledgement loss")
  })
  const saved = f.writer.save(f.edit, new AbortController().signal)
  cleanups.add(committed.resolve)
  void saved.catch(() => undefined)
  // Wait for the durable condition, rather than guessing how long the helper needs.
  const deadline = performance.now() + 10_000
  while (!f.database.query("SELECT 1 FROM settings WHERE key = ?").get("bot-metadata:fixture")) {
    if (performance.now() > deadline) throw new Error("Commit did not finish")
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }

  committed.resolve()
  const updated = await saved

  expect(updated).toMatchObject({ name: "Nome atualizado" })
  expect(f.database.query("SELECT instructions FROM bots WHERE id = ?").get("fixture")).toEqual({
    instructions: f.edit.instructions,
  })
})
