import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { lstat, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../../src/kernel/db"
import { createTranscriptRetention } from "../../src/kernel/transcript-retention"
import {
  applyTranscriptRetentionPlan,
  compactTranscript,
  getTranscriptRetentionPlan,
} from "../../src/kernel/transcript-storage"

const cleanups = new Set<() => void | Promise<void>>()
afterEach(async () => {
  for (const cleanup of Array.from(cleanups).reverse()) await cleanup()
  cleanups.clear()
})

test("isolated batches preserve synchronous retention results, replay floors and pending acknowledgements", async () => {
  const first = await getFixture()
  const second = await getFixture()
  const retention = createTranscriptRetention(first.database)
  cleanups.add(retention.dispose)

  while (compactTranscript({ database: second.database })) await Bun.sleep(0)
  while (await retention.run()) await Bun.sleep(0)

  expect(getRetained(first.database)).toEqual(getRetained(second.database))
  expect(getRetained(first.database)).toEqual({
    entries: { count: 2000, first: 51, last: 2050 },
    events: { count: 10000, first: 101, last: 10100 },
    floors: [{ thread_id: "thread", through_seq: 50 }],
    eventFloor: { value: "100" },
  })
  expect(first.database.query("SELECT status,request_json FROM send_journal").all()).toEqual([
    { status: "sent", request_json: '{"text":"Synthetic acknowledgement"}' },
  ])
  expect(first.database.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
  expect(first.database.query("PRAGMA foreign_key_check").all()).toEqual([])
}, 30_000)

test("a slow native write is interrupted independently and rolls back its floors before retry", async () => {
  const fixture = await getFixture()
  fixture.database.exec(`CREATE TRIGGER synthetic_slow_delete BEFORE DELETE ON ui_event_log BEGIN
    SELECT (WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000000) SELECT sum(x) FROM n);
  END`)
  const retention = createTranscriptRetention(fixture.database)
  cleanups.add(retention.dispose)
  const before = getRetained(fixture.database)

  expect(await retention.run(true)).toBe(true)

  expect(getRetained(fixture.database)).toEqual(before)
  expect(fixture.database.query("SELECT ui_delete_before_seq FROM transcript_maintenance").get()).toEqual({
    ui_delete_before_seq: 0,
  })
  fixture.database.exec("DROP TRIGGER synthetic_slow_delete")
  await retention.run(true)
  expect(getRetained(fixture.database)).not.toEqual(before)
  expect(fixture.database.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
})

test("busy writes, shared ownership and shutdown leave no retained helper or committed deletion", async () => {
  const fixture = await getFixture()
  const first = createTranscriptRetention(fixture.database)
  const second = createTranscriptRetention(fixture.database)
  cleanups.add(first.dispose)
  cleanups.add(second.dispose)
  const blocker = new Database(fixture.database.filename)
  cleanups.add(() => blocker.close())
  blocker.exec("BEGIN IMMEDIATE")
  const before = getRetained(fixture.database)

  const results = await Promise.all([first.run(), second.run(true)])
  await first.dispose()
  const pending = second.run()
  await second.dispose()
  await pending
  blocker.exec("ROLLBACK")

  expect(results).toEqual([true, true])
  expect(getRetained(fixture.database)).toEqual(before)
  expect(await second.run()).toBe(false)
  expect(fixture.database.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
})

test("discovery does not hold the writer lock and stale plans recheck dirty projections", async () => {
  const fixture = await getFixture()
  const plan = getTranscriptRetentionPlan({ database: fixture.database }, 0, 32)
  if (!plan) throw new Error("Missing synthetic retention plan")
  const writer = new Database(fixture.database.filename)
  cleanups.add(() => writer.close())

  writer.exec(
    "BEGIN IMMEDIATE; INSERT INTO settings(key,value_json,updated_at) VALUES('synthetic-reader','true',1); COMMIT",
  )
  fixture.database.exec(`INSERT INTO messages(id,thread_id,role,kind,status,parts_json,created_at,updated_at)
    VALUES('reply','thread','assistant','text','streaming','[{"type":"text","text":""}]',1,1);
    UPDATE transcript_maintenance SET projection_write=1 WHERE id=1;
    UPDATE messages SET updated_seq=0 WHERE id='reply';
    UPDATE transcript_maintenance SET projection_write=0 WHERE id=1`)
  const result = applyTranscriptRetentionPlan(fixture.database, plan)

  expect(result.more).toBe(true)
  expect(fixture.database.query("SELECT text FROM messages WHERE id='reply'").get()).toEqual({ text: "x" })
  expect(fixture.database.query("SELECT min(seq) AS first FROM transcript_entries").get()).toEqual({ first: 1 })
  expect(fixture.database.query("SELECT value_json FROM settings WHERE key='synthetic-reader'").get()).toEqual({
    value_json: "true",
  })
})

test("retention refuses a symlink database without writing its target", async () => {
  const fixture = await getFixture()
  const link = join(fixture.root, "link.db")
  await symlink(fixture.database.filename, link)
  const linked = new Database(link)
  cleanups.add(() => linked.close())
  const retention = createTranscriptRetention(linked)
  cleanups.add(retention.dispose)
  const before = getRetained(fixture.database)

  await expect(retention.run()).rejects.toThrow("RETENTION_FAILED")

  expect(getRetained(fixture.database)).toEqual(before)
})

test("discovery bounds row bytes to a contiguous prefix and preserves an unpublished tail", async () => {
  const fixture = await getFixture()
  while (compactTranscript({ database: fixture.database, events: 0, entriesPerThread: 0, maxAgeMs: 0 }))
    await Bun.sleep(0)
  const body = JSON.stringify({ type: "fixture.event", text: "x".repeat(100_000) })
  fixture.database
    .query(`INSERT INTO transcript_entries(thread_id,seq,generation,event_json,at)
    VALUES('thread',2051,1,?,1),('thread',2052,1,?,1),('thread',2053,1,?,1)`)
    .run(body, body, body)
  fixture.database.exec("UPDATE schema_meta SET value='2052' WHERE key='transcript_event_checkpoint'")
  const plan = getTranscriptRetentionPlan(
    { database: fixture.database, entriesPerThread: 0, maxAgeMs: 0 },
    0,
    32,
    150_000,
  )
  if (!plan) throw new Error("Missing synthetic byte plan")

  expect(plan.threads.flatMap(({ rows }) => rows).reduce((bytes, row) => bytes + row.bytes, 0)).toBeLessThanOrEqual(
    150_000,
  )
  expect(plan.threads.flatMap(({ rows }) => rows).some(({ id }) => id > 2052)).toBe(false)
  expect(plan.threads.flatMap(({ rows }) => rows.map(({ id }) => id))).toEqual([2051])
  expect(plan.more).toBe(true)
  expect(plan.events.reduce((bytes, row) => bytes + row.bytes, 0)).toBeLessThanOrEqual(150_000)
  applyTranscriptRetentionPlan(fixture.database, plan)
  expect(fixture.database.query("SELECT seq FROM transcript_entries ORDER BY seq").all()).toEqual([
    { seq: 2052 },
    { seq: 2053 },
  ])
})

test("fresh helpers resume projection scans across long gaps of unrelated entries", async () => {
  const fixture = await getFixture(600)
  fixture.database.exec(`INSERT INTO messages(id,thread_id,role,kind,status,parts_json,created_at,updated_at)
    VALUES('reply','thread','assistant','text','streaming','[{"type":"text","text":""}]',1,1);
    UPDATE transcript_maintenance SET projection_write=1 WHERE id=1;
    UPDATE messages SET updated_seq=0 WHERE id='reply';
    UPDATE transcript_maintenance SET projection_write=0 WHERE id=1;
    UPDATE schema_meta SET value='2051' WHERE key='transcript_event_checkpoint'`)
  const retention = createTranscriptRetention(fixture.database)
  cleanups.add(retention.dispose)

  await retention.run(true)
  const first = fixture.database.query("SELECT text,updated_seq FROM messages WHERE id='reply'").get()
  for (const _pass of Array.from({ length: 8 })) await retention.run(true)

  expect(first).toEqual({ text: "", updated_seq: 0 })
  expect(fixture.database.query("SELECT text FROM messages WHERE id='reply'").get()).toEqual({ text: "x" })
  expect(fixture.database.query("SELECT 1 FROM transcript_pending_deltas WHERE message_id='reply'").get()).toBeNull()
  expect(
    fixture.database.query("SELECT value FROM schema_meta WHERE key='transcript_retention_projection_scan'").get(),
  ).toBeNull()
  expect(fixture.database.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
}, 30_000)

test("both compiled entry points dispatch the private retention helper", async () => {
  const fixture = await getFixture()
  const stat = await lstat(fixture.database.filename)
  for (const entry of ["cli/main.ts", "main.ts"]) {
    const binary = join(fixture.root, entry.startsWith("cli") ? "cli" : "sidecar")
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, "../../src", entry)],
      target: "bun",
      compile: { outfile: binary },
    })
    expect(built.success).toBe(true)
    const child = Bun.spawn([binary, "transcript-retention"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, TOURI_APP_DATA: fixture.root },
    })
    cleanups.add(async () => {
      child.kill("SIGKILL")
      await child.exited
    })
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000)
    child.stdin.write(
      JSON.stringify({ filename: fixture.database.filename, dev: stat.dev, ino: stat.ino, cursor: 0, manual: true }),
    )
    await child.stdin.end()
    const [reply, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
    clearTimeout(timer)

    expect(code).toBe(0)
    expect(JSON.parse(reply)).toMatchObject({ more: true, cursor: 0 })
  }
}, 60_000)

const getFixture = async (deltaAt = 1) => {
  const root = await mkdtemp(join(tmpdir(), "touri-retention-"))
  cleanups.add(() => rm(root, { recursive: true, force: true }))
  const database = openDatabase({ filename: join(root, "touri.db") })
  cleanups.add(() => database.close())
  database.exec(`INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES('bot','Synthetic','codex','.',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at,updated_seq) VALUES('thread','bot','Synthetic',1,1,2050);
    `)
  database
    .query(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2050)
    INSERT INTO transcript_entries(thread_id,seq,generation,event_json,at) SELECT 'thread',x,1,CASE WHEN x=? THEN '{"type":"message.delta","threadId":"thread","messageId":"reply","partIndex":0,"offset":0,"delta":"x"}' ELSE '{"type":"fixture.event"}' END,unixepoch()*1000 FROM n;`)
    .run(deltaAt)
  database.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10100)
    INSERT INTO ui_event_log(at,event_json) SELECT unixepoch()*1000,'{"type":"fixture.event"}' FROM n;
    UPDATE schema_meta SET value='2050' WHERE key='transcript_event_checkpoint';
    INSERT INTO send_journal(thread_id,client_nonce,request_json,message_id,deadline,status,created_at,updated_at)
    VALUES('thread','synthetic-nonce','{"text":"Synthetic acknowledgement"}','pending',0,'sent',1,1)`)
  return { root, database }
}

const getRetained = (database: Database) => ({
  entries: database.query("SELECT count(*) AS count,min(seq) AS first,max(seq) AS last FROM transcript_entries").get(),
  events: database.query("SELECT count(*) AS count,min(seq) AS first,max(seq) AS last FROM ui_event_log").get(),
  floors: database.query("SELECT * FROM transcript_retention").all(),
  eventFloor: database.query("SELECT value FROM schema_meta WHERE key='ui_event_floor_seq'").get(),
})
