import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase, SCHEMA_VERSION } from "../../src/kernel/db"

const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup()
  cleanups.clear()
})

const getFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-attachment-revision-"))
  const filename = join(root, "history.sqlite")
  const database = openDatabase({ filename })
  cleanups.add(async () => {
    database.close()
    await rm(root, { recursive: true, force: true })
  })
  database.exec(`INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at)
    VALUES ('bot','Synthetic','codex','/tmp/synthetic',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('thread','bot','Synthetic',1,1);
    INSERT INTO messages(id,thread_id,role,kind,text,parts_json,created_at,updated_at)
    VALUES ('message','thread','assistant','text','Synthetic','[]',1,1);`)

  return { database, filename }
}

test("retention invalidates attachment batches without changing transcript revisions or timestamps", async () => {
  const { database } = await getFixture()
  const getMessage = () =>
    database.query("SELECT attachment_revision, updated_seq, updated_at FROM messages WHERE id = 'message'").get() as {
      attachment_revision: number
      updated_seq: number
      updated_at: number
    }
  const before = getMessage()

  database.exec(`UPDATE transcript_maintenance SET projection_write = 1 WHERE id = 1;
    UPDATE messages SET parts_json = '[{"type":"file","attachmentId":"synthetic"}]' WHERE id = 'message';
    UPDATE transcript_maintenance SET projection_write = 0 WHERE id = 1;`)

  expect(getMessage()).toEqual(Object.assign({}, before, { attachment_revision: 1 }))
  database.exec("UPDATE messages SET parts_json = parts_json WHERE id = 'message'")
  expect(getMessage()).toEqual(Object.assign({}, before, { attachment_revision: 1 }))
})

test("schema 52 upgrades without rewriting messages and reopens idempotently", async () => {
  const { database, filename } = await getFixture()
  database.exec(`DROP TRIGGER messages_attachment_revision;
    ALTER TABLE messages DROP COLUMN attachment_revision;
    DROP INDEX attachments_origin_path;
    DROP INDEX attachments_path;
    DELETE FROM schema_meta WHERE key = 'image_evidence_indexes_version';
    UPDATE schema_meta SET value = '52' WHERE key = 'schema_version';`)
  database.close()

  const upgraded = openDatabase({ filename })
  const message = upgraded.query("SELECT text, attachment_revision FROM messages WHERE id = 'message'").get()
  const indexes = upgraded
    .query("SELECT name FROM sqlite_schema WHERE name IN ('attachments_origin_path','attachments_path') ORDER BY name")
    .all()
  upgraded.close()
  const reopened = openDatabase({ filename })
  const version = reopened.query("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()
  reopened.close()

  expect(message).toEqual({ text: "Synthetic", attachment_revision: 0 })
  expect(indexes).toEqual([{ name: "attachments_origin_path" }, { name: "attachments_path" }])
  expect(version).toEqual({ value: String(SCHEMA_VERSION) })
})
