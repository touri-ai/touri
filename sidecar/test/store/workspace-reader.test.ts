import type { Database } from "bun:sqlite"
import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createKernel } from "../../src/kernel"
import { openDatabase } from "../../src/kernel/db"
import { init as initStore } from "../../src/store"
import { createStoreReader } from "../../src/store/reader"
import { getWorkspaceActivity, readWorkspaceActivity } from "../../src/store/workspace-activity"

// Fixture registries and timing samples are local accumulators; sorting never changes shared input.
const cleanups = new Set<() => void | Promise<void>>()

afterEach(async () => {
  await Array.from(cleanups).reduceRight(async (previous, cleanup) => {
    await previous
    await cleanup()
  }, Promise.resolve())
  cleanups.clear()
})

test("workspace route never queries historical previews on the request connection", async () => {
  const fixture = await getFixture()
  const query = fixture.database.query.bind(fixture.database)
  const guard = spyOn(fixture.database, "query").mockImplementation((sql) => {
    if (sql.includes("WITH visible AS MATERIALIZED")) throw new Error("LIVE_HISTORY_QUERY")
    return query(sql)
  })
  cleanups.add(() => guard.mockRestore())

  const response = await fixture.get("/workspace/activity")

  expect(response.status).toBe(200)
  const activity = await response.json()
  expect(activity.messages.map((message: { id: string }) => message.id)).toContain("own-preview")
})

test.each([
  undefined,
  { personId: "member", channelIds: ["team"] },
  { personId: "outsider", channelIds: [] },
  { personId: "owner", channelIds: [] },
])("async workspace previews preserve synchronous scope and projection: %j", async (scope) => {
  const fixture = await getFixture()
  const reader = createStoreReader(fixture.database.filename)
  cleanups.add(reader.dispose)
  const expected = readWorkspaceActivity(fixture.database, scope)

  const actual = await getWorkspaceActivity(fixture.database, reader, new AbortController().signal, scope)

  expect(actual).toEqual(expected)
  if (scope?.personId === "member")
    expect(actual.messages.map((message) => message.id).sort()).toEqual(["own-preview", "team-preview"])
  if (scope?.personId === "outsider") expect(actual.messages).toEqual([])
})

test("workspace previews preserve large approval details across bounded reader frames", async () => {
  const fixture = await getFixture()
  const detail = JSON.stringify({ changes: "Synthetic diff 🌿\n".repeat(40_000) })
  const parts = [{ type: "approval", approvalId: "large-review", request: "file_change", detail, decision: "pending" }]
  fixture.database.query("UPDATE messages SET parts_json = ? WHERE id = 'own-preview'").run(JSON.stringify(parts))

  const response = await fixture.get("/workspace/activity")

  expect(response.status).toBe(200)
  const activity = await response.json()
  const preview = activity.messages.find((message: { id: string }) => message.id === "own-preview")
  expect(preview.parts).toEqual(parts)
})

test("health responds and cancellation kills a held workspace reader", async () => {
  const fixture = await getFixture()
  const ready = Promise.withResolvers<number>()
  const reader = createStoreReader(fixture.database.filename, (pid) => {
    process.kill(pid, "SIGSTOP")
    ready.resolve(pid)
  })
  cleanups.add(reader.dispose)
  const controller = new AbortController()
  const result = getWorkspaceActivity(fixture.database, reader, controller.signal)
  const observed = result.catch((error: Error) => error.message)
  const pid = await ready.promise

  const samples = await Promise.all(
    Array.from({ length: 20 }, async () => {
      const started = performance.now()
      const health = await fixture.get("/health")
      expect(health.status).toBe(200)
      await health.arrayBuffer()
      return performance.now() - started
    }),
  )
  controller.abort()

  const sorted = samples.sort((left, right) => left - right)
  expect(sorted[18]).toBeLessThan(500)
  console.info(JSON.stringify({ heldReaderHealthP95Ms: sorted[18], samples: sorted.length }))
  expect(await observed).toBe("STORE_READ_ABORTED")
  expect(() => process.kill(pid, 0)).toThrow()
})

test("same synthetic preview workload records blocking and async timer delay", async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-workspace-benchmark-"))
  cleanups.add(() => rm(root, { recursive: true, force: true }))
  const database = openDatabase({ filename: join(root, "touri.db") })
  cleanups.add(() => database.close())
  seedWorkspace(database)
  database.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2000)
    INSERT INTO threads(id,bot_id,title,created_at,updated_at,owner_person_id)
    SELECT 'extra-'||x,'bot','Synthetic thread',1,1,'member' FROM n;
    INSERT INTO messages(id,thread_id,role,kind,status,text,created_at,updated_at)
    SELECT id||'-preview',id,'assistant','text','complete','Synthetic preview',1,1
    FROM threads WHERE id LIKE 'extra-%';`)
  const fixture = { database }
  fixture.database
    .query(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<12000)
    INSERT INTO messages(id,thread_id,role,kind,status,text,parts_json,created_at,updated_at)
    SELECT 'history-'||x,'own','assistant','tool','complete','',?,x+10,x+10 FROM n`)
    .run(JSON.stringify([{ type: "tool_call", outputJson: "synthetic ".repeat(200) }]))
  const reader = createStoreReader(fixture.database.filename)
  cleanups.add(reader.dispose)
  const scope = { personId: "member", channelIds: ["team"] }

  const before = await getMeasurement(() => readWorkspaceActivity(fixture.database, scope))
  const after = await getMeasurement(() =>
    getWorkspaceActivity(fixture.database, reader, new AbortController().signal, scope),
  )

  expect(after.value).toEqual(before.value)
  console.info(
    JSON.stringify({
      workload: "2003 threads; 14003 synthetic messages; same database and scope; warm cache",
      before: before.timings,
      after: after.timings,
    }),
  )
}, 30000)

const getMeasurement = async <Value>(read: () => Value | Promise<Value>) => {
  const samples: number[] = []
  let expected = performance.now() + 2
  const timer = setInterval(() => {
    const now = performance.now()
    samples.push(Math.max(0, now - expected))
    expected = now + 2
  }, 2)
  const started = performance.now()
  try {
    const value = await read()
    const durationMs = performance.now() - started
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    const sorted = samples.sort((left, right) => left - right)

    return { value, timings: { durationMs, maxTimerDelayMs: sorted.at(-1) ?? 0, samples: samples.length } }
  } finally {
    clearInterval(timer)
  }
}

const getFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-workspace-reader-"))
  cleanups.add(() => rm(root, { recursive: true, force: true }))
  const runtime = createKernel({ appData: root })
  cleanups.add(runtime.stop)
  await initStore(runtime.kernel)
  const database = runtime.kernel.db as Database
  seedWorkspace(database)
  return {
    database,
    get: (path: string) =>
      fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1${path}`, {
        headers: { Authorization: "Bearer dev-ui-token", Origin: "tauri://localhost" },
      }),
  }
}

const seedWorkspace = (database: Database): void => {
  database.exec(`
    INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('bot','Brisa','codex','/tmp/bot',1,1);
    INSERT INTO bot_groups(id,name,color,avatar_shape,avatar_seed,created_at,updated_at)
      VALUES ('team','Equipe','#888888','circle','team',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at,owner_person_id,group_id)
      VALUES ('own','bot','Conversa',1,1,'member',NULL),
      ('private','bot','Privada',1,1,'owner',NULL),
      ('team','bot','Canal',1,1,NULL,'team');
    INSERT INTO messages(id,thread_id,role,kind,status,text,created_at,updated_at)
      VALUES ('own-preview','own','assistant','text','complete','Resposta fictícia',2,2),
      ('private-preview','private','assistant','text','complete','Privada fictícia',2,2),
      ('team-preview','team','assistant','text','complete','Equipe fictícia',2,2);
  `)
}
