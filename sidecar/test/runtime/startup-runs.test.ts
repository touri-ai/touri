import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../../src/kernel/db"
import { profileProviders } from "../../src/kernel/provider-profiles"
import { getStartupReply, getStartupRuns } from "../../src/runtime/startup-runs"
import { init as initStore } from "../../src/store"
import { testKernel } from "../kernel/test-kernel"

const cleanups = new Set<() => void | Promise<void>>()

afterEach(async () => {
  await Array.from(cleanups).reduceRight(async (previous, cleanup) => {
    await previous
    await cleanup()
  }, Promise.resolve())
  cleanups.clear()
})

test("startup pages retain timestamp ties and exclude runs accepted after the restart watermark", async () => {
  const database = await getFixture()
  database.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<65)
    INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at)
    SELECT 'old-'||x,'thread','bot','fixture','user','running',x%3 FROM n;`)
  const runs = getStartupRuns(database, () => [])
  database.exec(`INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at)
    VALUES('new','thread','bot','fixture','user','running',0);`)
  const ids = new Set<string>()

  for await (const run of runs) ids.add(run.id)

  expect(ids.size).toBe(65)
  expect(ids.has("new")).toBe(false)
  expect(ids).toEqual(new Set(Array.from({ length: 65 }, (_, index) => `old-${index + 1}`)))
})

test("recovery reads its saved reply directly even when another branch is selected", async () => {
  const fixture = testKernel()
  cleanups.add(async () => {
    await fixture.kernel.services.use("store.recovery")?.dispose()
    fixture.close()
  })
  await initStore(fixture.kernel)
  fixture.db
    .query("INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES('bot','Fixture',?,'fixture',1,1)")
    .run(profileProviders[0])
  fixture.db.exec(`
    INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES('thread','bot','Fixture',1,1);
    INSERT INTO messages(id,thread_id,role,kind,status,text,created_at,updated_at) VALUES
      ('reply','thread','assistant','text','complete','Saved reply',1,1),
      ('other','thread','assistant','text','complete','Other branch',2,2);
    UPDATE threads SET active_leaf_id='other' WHERE id='thread';`)
  const store = fixture.kernel.services.use("store.api")
  if (!store) throw new Error("Missing fixture store")

  const reply = getStartupReply(store, { threadId: "thread", replyMessageId: "reply" })

  expect(reply).toMatchObject({ id: "reply", text: "Saved reply" })
  expect(store.getThread({ threadId: "thread" })?.activeLeafId).toBe("other")
})

const getFixture = async (): Promise<Database> => {
  const root = await mkdtemp(join(tmpdir(), "touri-startup-runs-"))
  cleanups.add(() => rm(root, { recursive: true, force: true }))
  const database = openDatabase({ filename: join(root, "touri.db") })
  cleanups.add(() => database.close())
  database
    .query("INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES('bot','Fixture',?,'fixture',1,1)")
    .run(profileProviders[0])
  database.exec("INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES('thread','bot','Fixture',1,1)")
  return database
}
