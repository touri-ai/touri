import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GROUP_CONTEXT_SQL, getGroupContextRows } from "../../src/groups/context"
import { openDatabase } from "../../src/kernel/db"
import contextIndexes from "../../src/kernel/migrations/channel-context-indexes.sql" with { type: "text" }

const cleanups = new Set<() => void>()
afterEach(() => {
  Array.from(cleanups).reduceRight<void>((_, cleanup) => cleanup(), undefined)
  cleanups.clear()
})

const getFixture = () => {
  const database = new Database(":memory:")
  cleanups.add(() => database.close())
  database.exec(`CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE messages (thread_id TEXT, id TEXT, seq INTEGER, role TEXT, text TEXT, sender_json TEXT,
      PRIMARY KEY (thread_id, id));`)
  database.exec(contextIndexes)
  database.exec(`WITH RECURSIVE sequence(seq) AS (
    VALUES (1) UNION ALL SELECT seq + 1 FROM sequence WHERE seq < 20000
  )
  INSERT INTO messages
  SELECT 'channel', CAST(seq AS TEXT), seq,
    CASE WHEN seq % 2 = 1 THEN 'user' ELSE 'assistant' END, 'synthetic ' || seq, NULL FROM sequence
  UNION ALL
  SELECT 'other', CAST(seq AS TEXT), seq, 'assistant', 'unrelated channel', NULL FROM sequence;`)

  return database
}

const getLegacyRows = (database: Database, requestId: string | null) =>
  database
    .query(`SELECT role, text, sender_json FROM messages
      WHERE thread_id=? AND (role<>'user' OR seq <= (SELECT seq FROM messages WHERE thread_id=? AND id=?))
      ORDER BY seq DESC LIMIT 80`)
    .all("channel", "channel", requestId) as ReturnType<typeof getGroupContextRows>

test.each(["19999", "19921", "1", "missing", null])(
  "bounded channel context preserves the request ceiling: %s",
  (requestId) => {
    const database = getFixture()

    const actual = getGroupContextRows(database, "channel", requestId)

    expect(actual).toEqual(getLegacyRows(database, requestId))
    expect(actual).toHaveLength(80)
  },
)

test("channel context seeks indexed role candidates before sorting its bounded window", () => {
  const database = getFixture()

  const plan = database.query(`EXPLAIN QUERY PLAN ${GROUP_CONTEXT_SQL}`).all("channel", "1") as { detail: string }[]
  const details = plan.map(({ detail }) => detail)

  expect(
    details.some((detail) => /SEARCH messages USING (?:COVERING )?INDEX messages_channel_user_seq/.test(detail)),
  ).toBe(true)
  expect(
    details.some((detail) => /SEARCH messages USING (?:COVERING )?INDEX messages_channel_reply_seq/.test(detail)),
  ).toBe(true)
  expect(details.some((detail) => /^SCAN (?:messages|m)\b/.test(detail))).toBe(false)
})

test("current stores install channel indexes once and preserve them on reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "touri-channel-context-"))
  cleanups.add(() => rmSync(root, { recursive: true, force: true }))
  const filename = join(root, "store.sqlite")
  const first = openDatabase({ filename })
  first.exec(`DROP INDEX messages_channel_user_seq; DROP INDEX messages_channel_reply_seq;
    DELETE FROM schema_meta WHERE key = 'channel_context_indexes_version';`)
  first.close()

  const upgraded = openDatabase({ filename })
  expect(upgraded.query("SELECT value FROM schema_meta WHERE key = 'channel_context_indexes_version'").get()).toEqual({
    value: "1",
  })
  upgraded.close()
  const reopened = openDatabase({ filename })
  cleanups.add(() => reopened.close())

  expect(
    reopened
      .query("SELECT name FROM sqlite_schema WHERE type = 'index' AND name LIKE 'messages_channel_%' ORDER BY name")
      .all(),
  ).toEqual([{ name: "messages_channel_reply_seq" }, { name: "messages_channel_user_seq" }])
})
