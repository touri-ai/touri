import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../../src/kernel/db"
import { getThreadRunsQuery } from "../../src/runtime/thread-runs-query"
import { getHistoryQuery } from "../../src/store/history-query"
import { createStoreReader } from "../../src/store/reader"

type Row = { id: string; created_at: number }
const cleanups = new Set<() => void | Promise<void>>()
afterEach(async () => {
  for (const cleanup of Array.from(cleanups).reverse()) await cleanup()
  cleanups.clear()
})

test("a 5k-message channel seeks the latest page and keeps timestamp ties across older pages", async () => {
  const database = await getFixture()
  const first = getHistoryQuery("channel", "message-5000", true, { limit: 40 })
  const rows = database.query(first.sql).all(...first.bindings) as Row[]
  const second = getHistoryQuery("channel", "message-5000", true, { limit: 40, before: "message-4961" })
  const older = database.query(second.sql).all(...second.bindings) as Row[]
  const plan = JSON.stringify(database.query(`EXPLAIN QUERY PLAN ${second.sql}`).all(...second.bindings))

  expect(rows).toHaveLength(41)
  expect(rows[0]?.id).toBe("message-5000")
  expect(rows[39]?.id).toBe("message-4961")
  expect(older[0]?.id).toBe("message-4960")
  expect(older[39]?.id).toBe("message-4921")
  expect(plan).toContain("messages_thread_created")
  expect(plan).not.toContain("TEMP B-TREE")

  const missing = getHistoryQuery("channel", null, true, { limit: 40, before: "not-in-this-thread" })
  expect(database.query(missing.sql).all(...missing.bindings)).toEqual([])
})

test("an older selected branch or search target has a bounded, inclusive page", async () => {
  const database = await getFixture()
  const query = getHistoryQuery("channel", "message-100", true, { limit: 40, around: "message-100" })

  const rows = database.query(query.sql).all(...query.bindings) as Row[]

  expect(rows).toHaveLength(41)
  expect(rows[0]?.id).toBe("message-100")
  expect(rows[39]?.id).toBe("message-61")
})

test("message hydration and serialization include only the page and its attachment references", async () => {
  const database = await getFixture()
  const reader = createStoreReader(database.filename)
  cleanups.add(reader.dispose)

  const reply = await reader.getMessages(
    getHistoryQuery("channel", null, true, { limit: 40 }),
    AbortSignal.timeout(15_000),
  )
  const page = JSON.parse(new TextDecoder().decode(reply.body))
  const end = await reader.getMessages(
    getHistoryQuery("channel", null, true, { limit: 40, before: "message-10" }),
    AbortSignal.timeout(15_000),
  )
  const oldest = JSON.parse(new TextDecoder().decode(end.body))

  expect(page.messages).toHaveLength(40)
  expect(page.messages[0].id).toBe("message-4961")
  expect(page.messages.at(-1).id).toBe("message-5000")
  expect(page.before).toBe("message-4961")
  expect(reply.references).toHaveLength(40)
  expect(reply.references.every((reference) => Number(reference.messageId.replace("message-", "")) >= 4961)).toBe(true)
  expect(reply.body.byteLength).toBeLessThan(100_000)
  expect(oldest.messages).toHaveLength(9)
  expect(oldest.before).toBeNull()
})

test("run projections are restricted to visible messages, even when older runs share the thread", async () => {
  const database = await getFixture()
  database.exec(`INSERT INTO bot_groups(id,name,color,avatar_shape,avatar_seed,created_at,updated_at)
    VALUES('group','Fixture','#000000','circle','fixture',1,1);
    INSERT INTO group_turns VALUES('run-5000','group','[]');
    INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at)
    VALUES('offscreen-member','other','bot','fixture','user','succeeded',5000);
    INSERT INTO group_run_links VALUES('offscreen-member','run-5000',0);`)
  const ids = Array.from({ length: 40 }, (_, index) => `message-${4961 + index}`)
  const query = getThreadRunsQuery("channel", false, ids)

  const runs = database.query(query.sql).all(...query.bindings) as Array<{ id: string }>
  const plan = JSON.stringify(database.query(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.bindings))

  expect(runs).toHaveLength(40)
  expect(runs[0]?.id).toBe("run-5000")
  expect(plan).toContain("runs_request")
  expect(plan).not.toMatch(/SCAN r\b/)
})

test("indexed page queries and page-scoped run projections stay within the live CPU budget", async () => {
  const database = await getFixture()
  const ids = Array.from({ length: 40 }, (_, index) => `message-${4961 + index}`)
  const runs = getThreadRunsQuery("channel", false, ids)
  const samples = Array.from({ length: 30 }, (_, index) => {
    const query = getHistoryQuery("channel", null, true, {
      limit: 40,
      ...(index ? { before: `message-${5000 - index * 40}` } : {}),
    })
    const started = process.cpuUsage()

    database.query(query.sql).all(...query.bindings)
    database.query(runs.sql).all(...runs.bindings)
    const cpu = process.cpuUsage(started)

    return (cpu.user + cpu.system) / 1000
  }).sort((left, right) => left - right)

  expect(samples[28]).toBeLessThan(20)
  expect(samples.at(-1)).toBeLessThan(50)
})

const getFixture = async (): Promise<Database> => {
  const directory = await mkdtemp(join(tmpdir(), "touri-history-page-"))
  cleanups.add(() => rm(directory, { recursive: true, force: true }))
  const database = openDatabase({ filename: join(directory, "touri.db") })
  cleanups.add(() => database.close())
  const fixture = (await Bun.file(new URL("../fixtures/ui-seed.json", import.meta.url)).json()) as {
    bots: Array<{ provider: string }>
  }
  const provider = fixture.bots[0]?.provider
  if (!provider) throw new Error("Missing synthetic provider")
  database
    .query(
      "INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES('bot','Fixture',?,'/fixture/bot',1,1)",
    )
    .run(provider)
  database.exec(`INSERT INTO threads(id,bot_id,title,created_at,updated_at)
    VALUES('channel','bot','Fixture',1,1),('other','bot','Other fixture',1,1);
    WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<5000)
    INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at,request_message_id)
      SELECT 'run-'||x,'channel','bot','fixture','user','succeeded',x,'message-'||x FROM n;
    WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<5000)
    INSERT INTO messages(id,thread_id,parent_id,role,kind,status,run_id,text,parts_json,created_at,updated_at,seq,generation,updated_seq)
      SELECT 'message-'||x,'channel',CASE WHEN x=1 THEN NULL ELSE 'message-'||(x-1) END,
      'user','text','complete','run-'||x,'Mensagem fictícia '||x,
      '[{"type":"file","attachmentId":"fixture-file","name":"fixture.txt"}]',x/3,x/3,x,1,x FROM n;
    INSERT INTO messages(id,thread_id,role,kind,text,created_at,updated_at,seq,generation,updated_seq)
      VALUES('not-in-this-thread','other','user','text','Other fixture',1,1,1,1,1);`)

  return database
}
