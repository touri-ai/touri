import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase, SCHEMA_VERSION } from "../../src/kernel/db"

test("schema 32 upgrades bot, thread, and attachment ownership columns", () => {
  const root = mkdtempSync(join(tmpdir(), "touri-work-identity-migration-"))
  const filename = join(root, "touri.db")
  let database = openDatabase({ filename })
  try {
    database.exec(`
      DROP INDEX IF EXISTS bots_responsible_person_active;
      DROP INDEX IF EXISTS threads_owner_person_active;
      ALTER TABLE bots DROP COLUMN responsible_person_id;
      ALTER TABLE threads DROP COLUMN owner_person_id;
      ALTER TABLE attachments DROP COLUMN owner_person_id;
      UPDATE schema_meta SET value = '32' WHERE key = 'schema_version';
    `)
    database.close()
    database = openDatabase({ filename })
    expect(SCHEMA_VERSION).toBe(34)
    expect(database.query("PRAGMA table_info(bots)").all()).toContainEqual(
      expect.objectContaining({ name: "responsible_person_id" }),
    )
    expect(database.query("PRAGMA table_info(threads)").all()).toContainEqual(
      expect.objectContaining({ name: "owner_person_id" }),
    )
    expect(database.query("PRAGMA table_info(attachments)").all()).toContainEqual(
      expect.objectContaining({ name: "owner_person_id" }),
    )
    expect(database.query("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: "34" })
  } finally {
    database.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("attachment references follow message insert, edit, and deletion", async () => {
  const database = new Database(":memory:")
  try {
    database.exec(`
      CREATE TABLE bots (id TEXT PRIMARY KEY, archived_at INTEGER, responsible_person_id TEXT);
      CREATE TABLE threads (
        id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, owner_person_id TEXT, group_id TEXT, archived_at INTEGER, updated_at INTEGER
      );
      CREATE TABLE messages (thread_id TEXT NOT NULL, id TEXT NOT NULL, parts_json TEXT NOT NULL);
      CREATE TABLE attachments (id TEXT PRIMARY KEY, owner_person_id TEXT);
    `)
    database.exec(await Bun.file(join(import.meta.dir, "../../src/kernel/migrations/0033.sql")).text())
    const plan = database
      .query(`EXPLAIN QUERY PLAN SELECT 1 FROM attachment_message_refs refs
        JOIN threads t ON t.id = refs.thread_id JOIN bots b ON b.id = t.bot_id
        WHERE refs.attachment_id = ? AND t.archived_at IS NULL AND b.archived_at IS NULL LIMIT 1`)
      .all("file-a")
    expect(JSON.stringify(plan)).toContain("attachment_message_refs_attachment")
    database
      .query("INSERT INTO messages(thread_id,id,parts_json) VALUES(?,?,?)")
      .run("thread-a", "message-a", '[{"type":"file","attachmentId":"file-a"}]')
    expect(
      database.query("SELECT attachment_id FROM attachment_message_refs WHERE thread_id = ?").all("thread-a"),
    ).toEqual([{ attachment_id: "file-a" }])
    database
      .query("UPDATE messages SET parts_json = ? WHERE thread_id = ? AND id = ?")
      .run('[{"type":"image","attachmentId":"file-b"}]', "thread-a", "message-a")
    expect(
      database.query("SELECT attachment_id FROM attachment_message_refs WHERE thread_id = ?").all("thread-a"),
    ).toEqual([{ attachment_id: "file-b" }])
    database
      .query("UPDATE messages SET parts_json = ? WHERE thread_id = ? AND id = ?")
      .run('[{"type":"command","outputAttachmentId":"output-c"}]', "thread-a", "message-a")
    expect(
      database.query("SELECT attachment_id FROM attachment_message_refs WHERE thread_id = ?").all("thread-a"),
    ).toEqual([{ attachment_id: "output-c" }])
    database.query("DELETE FROM messages WHERE thread_id = ? AND id = ?").run("thread-a", "message-a")
    expect(database.query("SELECT 1 FROM attachment_message_refs").get()).toBeNull()
    database
      .query("INSERT INTO messages(thread_id,id,parts_json) VALUES(?,?,?)")
      .run("thread-a", "message-b", '[{"type":"tool_call","outputAttachmentId":"output-d"}]')
    expect(
      database.query("SELECT attachment_id FROM attachment_message_refs WHERE thread_id = ?").all("thread-a"),
    ).toEqual([{ attachment_id: "output-d" }])
  } finally {
    database.close()
  }
})
