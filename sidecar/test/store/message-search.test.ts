import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase, SCHEMA_VERSION } from "../../src/kernel/db"
import { DELETE_MESSAGE_SEARCH_SQL, refreshMessageSearch } from "../../src/kernel/message-search"

const fixtures = new Set<ReturnType<typeof getFixture>>()

afterEach(() => {
  fixtures.forEach((fixture) => {
    fixture.close()
  })
  fixtures.clear()
})

test("schema 27 gains deletion indexes while retaining search and recovery objects on repeated opens", () => {
  const fixture = getFixture()
  fixtures.add(fixture)
  const { database } = fixture
  refreshMessageSearch(database, { threadId: "thread", id: "first", text: "primeiro" })
  database.exec(`DROP INDEX group_members_bot;
    DROP INDEX group_turns_group;
    DROP INDEX routines_group;
    UPDATE schema_meta SET value = '27' WHERE key = 'schema_version';`)
  const objects = database.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all()
  const messages = database.query("SELECT * FROM messages ORDER BY id").all()
  const searchRows = database.query("SELECT * FROM message_search_rows ORDER BY fts_rowid").all()

  const upgraded = fixture.reopen()

  expect(upgraded.query("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()).toEqual({
    value: String(SCHEMA_VERSION),
  })

  const reopened = fixture.reopen()

  expect(reopened.query("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()).toEqual({
    value: String(SCHEMA_VERSION),
  })
  expect(
    reopened
      .query(
        "SELECT type, name, sql FROM sqlite_master WHERE name NOT IN ('group_members_bot', 'group_turns_group', 'routines_group') ORDER BY name",
      )
      .all(),
  ).toEqual(objects)
  const indexes = [
    { table: "group_members", column: "bot_id", index: "group_members_bot" },
    { table: "group_turns", column: "group_id", index: "group_turns_group" },
    { table: "routines", column: "group_id", index: "routines_group" },
  ]
  indexes.forEach(({ table, column, index }) => {
    const plan = reopened.query(`EXPLAIN QUERY PLAN SELECT * FROM ${table} WHERE ${column} = ?`).all("group")

    expect(plan).toEqual(expect.arrayContaining([expect.objectContaining({ detail: expect.stringContaining(index) })]))
  })
  expect(reopened.query("SELECT * FROM messages ORDER BY id").all()).toEqual(messages)
  expect(reopened.query("SELECT * FROM message_search_rows ORDER BY fts_rowid").all()).toEqual(searchRows)
  expect(fixture.getHits("primeiro")).toEqual(["first"])
  expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([])
})

test("search updates seek indexed rowids and preserve other messages", () => {
  const fixture = getFixture()
  fixtures.add(fixture)
  const { database } = fixture
  refreshMessageSearch(database, { threadId: "thread", id: "first", text: "antigo" })
  refreshMessageSearch(database, { threadId: "thread", id: "second", text: "vizinho" })
  const explain = database.prepare(`EXPLAIN QUERY PLAN ${DELETE_MESSAGE_SEARCH_SQL}`)
  const plan = (
    explain.all("thread", "first", "thread", "first") as Array<{
      detail: string
    }>
  )
    .map((row) => row.detail)
    .join("\n")
  explain.finalize()

  refreshMessageSearch(database, { threadId: "thread", id: "first", text: "atualizado" })

  expect(plan).toContain("message_search_rows")
  expect(plan).toContain("INDEX 0:=")
  expect(fixture.getHits("antigo")).toEqual([])
  expect(fixture.getHits("atualizado")).toEqual(["first"])
  expect(fixture.getHits("vizinho")).toEqual(["second"])
})

test("migration keeps legacy rowids, removes duplicate revisions and survives rollback and reopen", () => {
  const fixture = getFixture()
  fixtures.add(fixture)
  const { database } = fixture
  database.exec(`DROP TRIGGER message_search_delete;
    DROP TABLE message_search_rows;
    DROP INDEX tool_resolutions_thread_resolution;
    DELETE FROM schema_meta WHERE key = 'message_search_rows_version';
    UPDATE schema_meta SET value = '26' WHERE key = 'schema_version';
    INSERT INTO messages_fts(rowid,text,thread_id,message_id) VALUES
      (4000,'antigo','thread','first'), (8000,'antigo','thread','first'),
      (9000,'vizinho','thread','second');`)

  const reopened = fixture.reopen()

  expect(reopened.query("SELECT fts_rowid FROM message_search_rows ORDER BY fts_rowid").all()).toEqual([
    { fts_rowid: 4000 },
    { fts_rowid: 8000 },
    { fts_rowid: 9000 },
  ])
  expect(() =>
    reopened.transaction(() => {
      refreshMessageSearch(reopened, { threadId: "thread", id: "first", text: "descartado" })
      throw new Error("rollback")
    })(),
  ).toThrow("rollback")
  expect(fixture.getHits("antigo")).toEqual(["first", "first"])
  expect(fixture.getHits("descartado")).toEqual([])
  refreshMessageSearch(reopened, { threadId: "thread", id: "first", text: "atualizado" })
  fixture.reopen()
  expect(fixture.getHits("antigo")).toEqual([])
  expect(fixture.getHits("atualizado")).toEqual(["first"])
  expect(fixture.getHits("vizinho")).toEqual(["second"])
})

test("message deletion removes its search row and locator in the same transaction", () => {
  const fixture = getFixture()
  fixtures.add(fixture)
  const { database } = fixture
  refreshMessageSearch(database, { threadId: "thread", id: "first", text: "primeiro" })
  refreshMessageSearch(database, { threadId: "thread", id: "second", text: "segundo" })

  database.query("DELETE FROM messages WHERE thread_id = 'thread' AND id = 'first'").run()

  expect(fixture.getHits("primeiro")).toEqual([])
  expect(fixture.getHits("segundo")).toEqual(["second"])
  expect(database.query("SELECT message_id FROM message_search_rows").all()).toEqual([{ message_id: "second" }])
})

test.each(["refresh", "delete"])("a stale locator cannot remove another message's search row during %s", (action) => {
  const fixture = getFixture()
  fixtures.add(fixture)
  const { database } = fixture
  refreshMessageSearch(database, { threadId: "thread", id: "first", text: "primeiro" })
  refreshMessageSearch(database, { threadId: "thread", id: "second", text: "segundo" })
  database.exec(`UPDATE message_search_rows SET fts_rowid = (
    SELECT fts_rowid FROM message_search_rows WHERE message_id = 'second'
  ) WHERE message_id = 'first'`)

  if (action === "refresh") refreshMessageSearch(database, { threadId: "thread", id: "first", text: "novo" })
  if (action === "delete") database.query("DELETE FROM messages WHERE id = 'first'").run()

  expect(fixture.getHits("segundo")).toEqual(["second"])
})

const getFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "touri-message-search-"))
  const filename = join(root, "touri.db")
  // Reopening is part of the durability test; keep this connection local to its fixture.
  let database = openDatabase({ filename })
  database.exec(`INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at)
    VALUES ('bot','Teste','codex','/tmp/fixture',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('thread','bot','Conversa',1,1);
    INSERT INTO messages(id,thread_id,role,kind,status,text,created_at,updated_at) VALUES
      ('first','thread','user','text','complete','primeiro',1,1),
      ('second','thread','user','text','complete','segundo',2,2);`)

  return {
    database,
    getHits: (query: string) =>
      (
        database
          .query("SELECT message_id FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rowid")
          .all(query) as Array<{ message_id: string }>
      ).map((row) => row.message_id),
    reopen: () => {
      database.close()
      database = openDatabase({ filename })
      return database
    },
    close: () => {
      database.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}
