import { afterEach, expect, mock, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { collectUnusedOutputBlobs } from "../../src/kernel/data-maintenance"
import { openDatabase } from "../../src/kernel/db"
import { OUTPUT_BLOB_ORIGIN } from "../../src/kernel/output-blobs"

const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup()
  cleanups.clear()
})

const makeFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-attachment-ownership-"))
  const database = openDatabase({ filename: join(root, "synthetic.db") })
  cleanups.add(async () => {
    database.close()
    await rm(root, { recursive: true, force: true })
  })
  await mkdir(join(root, "attachments"))
  database
    .query("INSERT INTO bot_deletions(bot_id,delete_volumes,phase,created_at,updated_at) VALUES (?,0,'cleanup',1,1)")
    .run("owner")
  const attachments = ["upload", "output"].map((id) => ({ id, path: join(root, "attachments", `${id}.txt`) }))
  for (const attachment of attachments) {
    await writeFile(attachment.path, "synthetic")
    database
      .query("INSERT INTO attachments(id,path,mime,bytes,origin_path,created_at) VALUES (?,?,'text/plain',9,?,1)")
      .run(attachment.id, attachment.path, attachment.id === "output" ? OUTPUT_BLOB_ORIGIN : "")
    const key = `storage.deleted-attachments:owner${attachment.id === "output" ? ":0" : ""}`
    database
      .query("INSERT INTO settings(key,value_json,updated_at) VALUES (?,?,1)")
      .run(key, JSON.stringify([attachment.id]))
  }

  return { root, database, attachments }
}

const collect = (fixture: Awaited<ReturnType<typeof makeFixture>>, botId?: string, onDeferred = () => {}) =>
  collectUnusedOutputBlobs(
    fixture.database,
    fixture.root,
    Date.now(),
    undefined,
    undefined,
    undefined,
    onDeferred,
    undefined,
    undefined,
    botId,
  )

test.each([undefined, "another-bot"])(
  "collection by %s preserves a live deletion's files and markers",
  async (botId) => {
    const fixture = await makeFixture()
    const deferred = mock(() => {})

    const removed = await collect(fixture, botId, deferred)

    expect(removed).toBe(0)
    expect(fixture.database.query("SELECT id FROM attachments ORDER BY id").all()).toEqual([
      { id: "output" },
      { id: "upload" },
    ])
    expect(
      fixture.database.query("SELECT key FROM settings WHERE key LIKE 'storage.deleted-attachments:%'").all(),
    ).toHaveLength(2)
    for (const attachment of fixture.attachments) expect(await Bun.file(attachment.path).text()).toBe("synthetic")
    if (botId) expect(deferred).not.toHaveBeenCalled()
    if (!botId) expect(deferred).toHaveBeenCalledWith("changed")
  },
)

test.each(["owner", undefined])("collection by %s removes files after ownership is available", async (botId) => {
  const fixture = await makeFixture()
  if (!botId) fixture.database.query("UPDATE bot_deletions SET error_code = 'TOURI-E2015' WHERE bot_id = 'owner'").run()

  const removed = await collect(fixture, botId)

  expect(removed).toBe(2)
  expect(fixture.database.query("SELECT id FROM attachments").all()).toEqual([])
  expect(
    fixture.database.query("SELECT key FROM settings WHERE key LIKE 'storage.deleted-attachments:%'").all(),
  ).toEqual([])
  for (const attachment of fixture.attachments) expect(await Bun.file(attachment.path).exists()).toBe(false)
})

test.each([undefined, "another-bot"])(
  "collection by %s progresses past reserved marker pages without consuming them",
  async (botId) => {
    const fixture = await makeFixture()
    const path = join(fixture.root, "attachments", "unreserved.txt")
    await writeFile(path, "synthetic")
    fixture.database
      .query("INSERT INTO attachments(id,path,mime,bytes,created_at) VALUES ('unreserved',?,'text/plain',9,1)")
      .run(path)
    const insertMarker = fixture.database.query("INSERT INTO settings(key,value_json,updated_at) VALUES (?,?,1)")
    Array.from({ length: 55 }, (_, page) => `storage.deleted-attachments:owner:${page + 1}`).forEach((key) => {
      insertMarker.run(key, '["upload","output"]')
    })
    insertMarker.run("storage.deleted-attachments:another-bot", '["unreserved"]')

    const removed = await collect(fixture, botId)

    expect(removed).toBe(1)
    expect(await Bun.file(path).exists()).toBe(false)
    expect(fixture.database.query("SELECT id FROM attachments ORDER BY id").all()).toEqual([
      { id: "output" },
      { id: "upload" },
    ])
    expect(
      fixture.database.query("SELECT key FROM settings WHERE key LIKE 'storage.deleted-attachments:%'").all(),
    ).toHaveLength(57)
    expect(
      fixture.database.query("SELECT 1 FROM settings WHERE key = 'storage.deleted-attachments:another-bot'").get(),
    ).toBeNull()
    for (const attachment of fixture.attachments) expect(await Bun.file(attachment.path).text()).toBe("synthetic")
  },
)
