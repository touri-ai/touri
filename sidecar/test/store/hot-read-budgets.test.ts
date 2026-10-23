import type { Database, SQLQueryBindings } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getGroupRunsSql } from "../../src/groups/run-queries"
import { openDatabase } from "../../src/kernel/db"
import { WORK_RUNS_SQL } from "../../src/runtime/persistence"
import { getThreadRunsQuery } from "../../src/runtime/thread-runs-query"
import { getHistoryQuery, THREAD_MESSAGES_SQL } from "../../src/store/history-query"
import { getMessageFromRow } from "../../src/store/message-row"
import { createStoreReader } from "../../src/store/reader"
import { getSearchQuery } from "../../src/store/search-query"
import type { RawMessage } from "../../src/store/workspace-activity"

// This registry owns fixture resources; numeric sorts mutate only fresh local arrays.
const cleanups = new Set<() => void | Promise<void>>()

afterEach(async () => {
  await Array.from(cleanups).reduceRight(async (previous, cleanup) => {
    await previous
    await cleanup()
  }, Promise.resolve())
  cleanups.clear()
})

test("hot reads seek indexes and avoid historical sorts with five active runs", async () => {
  const db = await getFixture()
  const queries = [
    { name: "active runs", sql: WORK_RUNS_SQL, bindings: [], index: "runs_active_order", rows: 5 },
    { name: "channel runs", sql: getGroupRunsSql(), bindings: ["thread-0"], index: "group_run_links_turn", rows: 50 },
    {
      name: "messages",
      sql: `${THREAD_MESSAGES_SQL} LIMIT 50`,
      bindings: ["thread-0"],
      index: "messages_thread_created",
      rows: 50,
    },
    {
      name: "groups",
      sql: "SELECT id FROM bot_groups ORDER BY created_at,rowid",
      bindings: [],
      index: "bot_groups_created",
      rows: 1,
    },
    {
      name: "channel threads",
      sql: "SELECT id FROM threads WHERE group_id=? AND group_thread_id IS NULL AND archived_at IS NULL ORDER BY updated_at DESC",
      bindings: ["channel"],
      index: "threads_channel_updated",
      rows: 1,
    },
    {
      name: "unread projection",
      sql: "SELECT unread FROM threads WHERE bot_id=? AND archived_at IS NULL ORDER BY updated_at DESC",
      bindings: ["bot-0"],
      index: "threads_bot",
      rows: 1,
    },
    {
      name: "visible reply",
      sql: "SELECT visible_message_id FROM group_message_links WHERE message_id=?",
      bindings: ["reply-1"],
      index: "group_message_links_message",
      rows: 1,
    },
    { name: "search", ...getSearchQuery({ q: "fixture", limit: 50 }), index: "VIRTUAL TABLE INDEX", rows: 50 },
  ]

  queries.forEach((query) => {
    const plan = getPlan(db, query.sql, query.bindings)
    expect(plan).toContain(query.index)
    if (query.name !== "channel runs") expect(plan).not.toContain("USE TEMP B-TREE")
    expect(plan).not.toMatch(/SCAN (?:messages|group_message_links)\b/)
    const durations = Array.from({ length: 7 }, () => {
      const started = performance.now()
      const rows = db.query(query.sql).all(...query.bindings)
      expect(rows).toHaveLength(query.rows)

      return performance.now() - started
    }).sort((left, right) => left - right)
    const median = durations[3] ?? Number.POSITIVE_INFINITY

    console.info(`${query.name}: median ${median.toFixed(3)} ms; budget 50 ms`)
    expect(median).toBeLessThan(50)
  })

  db.exec("DROP INDEX messages_thread_created; DROP INDEX group_message_links_message")

  expect(getPlan(db, THREAD_MESSAGES_SQL, ["thread-0"])).toContain("USE TEMP B-TREE")
  expect(getPlan(db, "SELECT visible_message_id FROM group_message_links WHERE message_id=?", ["reply-1"])).toContain(
    "SCAN group_message_links",
  )
})

test("channel windows retain member executions and explicit all retains older turns", async () => {
  const db = await getFixture()

  const recent = db.query(getGroupRunsSql()).all("thread-0") as Array<{ id: string }>
  const all = db.query(getGroupRunsSql(true)).all("thread-0")

  expect(recent).toHaveLength(50)
  expect(recent[0]?.id).toBe("member-8000")
  expect(all).toHaveLength(8000)
})

test("thread snapshots enrich only selected roots and preserve member identity", async () => {
  const db = await getFixture()
  db.exec("UPDATE runs SET reply_message_id='reply-8000' WHERE id='member-8000'")
  const query = getThreadRunsQuery("thread-0")

  const rows = db.query(query.sql).all(...query.bindings) as Array<Record<string, unknown>>
  const plan = getPlan(db, query.sql, query.bindings)

  expect(rows).toHaveLength(100)
  expect(rows[0]?.id).toBe("root-8000")
  expect(rows[50]).toMatchObject({
    id: "member-8000",
    thread_id: "thread-1",
    group_thread_id: "thread-0",
    group_turn_id: "root-8000",
    visible_reply_message_id: "visible-8000",
    origin: "message",
  })
  expect(plan).toContain("runs_thread")
  expect(plan).toContain("group_run_links_turn")
  expect(plan).not.toMatch(/SCAN r\b/)
})

test("background snapshots preserve message JSON, ancestry and attachment references", async () => {
  const db = await getFixture()
  const reader = createStoreReader(db.filename)
  cleanups.add(reader.dispose)
  const signal = new AbortController().signal
  const expected = (db.query(THREAD_MESSAGES_SQL).all("thread-0") as RawMessage[]).map(getMessageFromRow)

  const result = await reader.getMessages(getHistoryQuery("thread-0", "message-2000", true), signal)
  const actual = JSON.parse(new TextDecoder().decode(result.body))
  const path = await reader.getMessages(getHistoryQuery("thread-0", "message-2"), signal)

  expect(actual).toEqual({ messages: expected, activeLeafId: "message-2000" })
  expect(JSON.parse(new TextDecoder().decode(path.body)).messages.map((message: { id: string }) => message.id)).toEqual(
    ["message-1", "message-2"],
  )
  expect(result.references[0]).toEqual({
    threadId: "thread-0",
    messageId: "message-1",
    attachmentIds: ["fixture-file"],
  })
})

test("large snapshot building keeps event-loop p99 below 50 ms with five active runs", async () => {
  const db = await getFixture()
  const reader = createStoreReader(db.filename)
  cleanups.add(reader.dispose)
  const parts = JSON.stringify([{ type: "text", text: "fixture ".repeat(32_768) }])
  db.query("UPDATE messages SET parts_json=? WHERE thread_id='thread-0' AND created_at <= 32").run(parts)
  const signal = new AbortController().signal
  const before = await getLagBudget(async () => {
    const rows = db.query(THREAD_MESSAGES_SQL).all("thread-0") as RawMessage[]
    const body = new TextEncoder().encode(JSON.stringify({ messages: rows.map(getMessageFromRow) }))
    return body.byteLength
  })
  const after = await getLagBudget(async () => {
    const result = await reader.getMessages(getHistoryQuery("thread-0", "message-2000", true), signal)
    return result.body.byteLength
  })
  console.info(
    `five active runs; 5 ms sampling; event-loop before ${JSON.stringify(before)}; after ${JSON.stringify(after)}`,
  )

  expect(after.samples).toBeGreaterThan(50)
  expect(after.p99).toBeLessThan(50)
  expect(after.maximum).toBeLessThan(500)
}, 60_000)

const getLagBudget = async (read: () => Promise<number>) => {
  const lags: number[] = []
  // Only this measurement owns its timer, expected tick and sample accumulator.
  let expected = performance.now() + 5
  const timer = setInterval(() => {
    const now = performance.now()
    lags.push(Math.max(0, now - expected))
    expected = now + 5
  }, 5)
  cleanups.add(() => clearInterval(timer))

  for (const _ of Array.from({ length: 12 })) {
    expect(await read()).toBeGreaterThan(8 * 1024 * 1024)
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 300))
  clearInterval(timer)
  const sorted = lags.slice().sort((left, right) => left - right)

  return {
    samples: lags.length,
    p99: sorted[Math.ceil(sorted.length * 0.99) - 1] ?? Number.POSITIVE_INFINITY,
    maximum: sorted.at(-1) ?? Number.POSITIVE_INFINITY,
  }
}

test("cancellation and disposal stop SQL processes and reject reads", async () => {
  const db = await getFixture()
  const ready = Promise.withResolvers<void>()
  const reader = createStoreReader(db.filename, () => ready.resolve())
  cleanups.add(reader.dispose)
  const controller = new AbortController()
  const query = {
    sql: "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n",
    bindings: [],
  }

  const result = reader.getRows(query, controller.signal)
  await ready.promise
  controller.abort()

  await expect(result).rejects.toThrow("STORE_READ_ABORTED")
  reader.dispose()
  await expect(reader.getRows({ sql: "SELECT 1", bindings: [] }, new AbortController().signal)).rejects.toThrow(
    "STORE_READ_CAPACITY",
  )
})

const getPlan = (db: Database, sql: string, bindings: SQLQueryBindings[]): string =>
  (db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings) as Array<{ detail: string }>)
    .map(({ detail }) => detail)
    .join("\n")

const getFixture = async (): Promise<Database> => {
  const root = await mkdtemp(join(tmpdir(), "touri-hot-reads-"))
  cleanups.add(() => rm(root, { recursive: true, force: true }))
  const db = openDatabase({ filename: join(root, "touri.db") })
  cleanups.add(() => db.close())
  const fixture = (await Bun.file(new URL("../fixtures/ui-seed.json", import.meta.url)).json()) as {
    bots: Array<{ provider: string }>
  }
  const provider = fixture.bots[0]?.provider ?? "fixture"
  db.transaction(() => {
    Array.from({ length: 6 }, (_, index) => index).forEach((index) => {
      db.query(
        "INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES (?,?,?,'/tmp/fixture-bot',1,1)",
      ).run(`bot-${index}`, `Fixture ${index}`, provider)
      db.query("INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES (?,?,'Fixture',1,1)").run(
        `thread-${index}`,
        `bot-${index}`,
      )
    })
    db.exec(`INSERT INTO bot_groups(id,name,color,avatar_shape,avatar_seed,created_at,updated_at)
      VALUES('channel','Fixture','#000000','circle','fixture',1,1);
      UPDATE threads SET group_id='channel' WHERE id='thread-0';
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<8000)
      INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at)
      SELECT 'root-'||x,'thread-0','bot-0','fixture','user','succeeded',x FROM n;
      INSERT INTO group_turns SELECT id,'channel','[]' FROM runs;
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<8000)
      INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at)
      SELECT 'member-'||x,'thread-1','bot-1','fixture','user','succeeded',x FROM n;
      INSERT INTO group_run_links SELECT 'member-'||queued_at,id,0 FROM runs WHERE thread_id='thread-0';
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<5)
      INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at)
      SELECT 'active-'||x,'thread-'||x,'bot-'||x,'fixture','user','running',9000+x FROM n;
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2000)
      INSERT INTO messages(id,thread_id,parent_id,role,kind,status,text,parts_json,created_at,updated_at)
      SELECT 'message-'||x,'thread-0',CASE WHEN x=1 THEN NULL ELSE 'message-'||(x-1) END,
        'assistant','text','complete','fixture searchable',
        '[{"type":"file","attachmentId":"fixture-file","name":"fixture.txt"}]',x,x FROM n;
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<8000)
      INSERT INTO group_message_links VALUES('reply-'||x,'thread-1','visible-'||x);
      INSERT INTO messages_fts(text,thread_id,message_id) SELECT text,thread_id,id FROM messages;`)
  })()

  return db
}
