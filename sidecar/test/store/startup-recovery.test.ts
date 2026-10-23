import { afterEach, expect, test } from "bun:test"
import { profileProviders } from "../../src/kernel/provider-profiles"
import { createStartupRecovery } from "../../src/store/startup-recovery"
import { testKernel } from "../kernel/test-kernel"

// Each fixture owns its blocked filesystem operation and releases it before closing SQLite.
const cleanups = new Set<() => void | Promise<void>>()
afterEach(async () => {
  await Array.from(cleanups).reduceRight(async (previous, cleanup) => {
    await previous
    await cleanup()
  }, Promise.resolve())
  cleanups.clear()
})

test("a thread replays its durable deltas while another bot home is still recovering", async () => {
  const fixture = testKernel()
  cleanups.add(fixture.close)
  fixture.db
    .query("INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES('bot','Fixture',?,'fixture',1,1)")
    .run(profileProviders[0])
  fixture.db.exec(`
    INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES('thread','bot','Fixture',1,1);
    INSERT INTO messages(id,thread_id,role,kind,status,text,parts_json,created_at,updated_at)
    VALUES('reply','thread','assistant','text','streaming','Saved',
      '[{"type":"text","text":"Saved"}]',1,1);
    INSERT INTO transcript_entries(thread_id,seq,generation,event_json,at)
    SELECT 'thread',updated_seq+1,1,
      '{"type":"message.delta","threadId":"thread","messageId":"reply","partIndex":0,"offset":5,"delta":" reply"}',2
      FROM messages WHERE id='reply';`)
  const reached = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const recovery = createStartupRecovery(fixture.kernel, undefined, async () => {
    reached.resolve()
    await release.promise
  })
  cleanups.add(recovery.dispose)
  cleanups.add(release.resolve)
  await reached.promise

  await recovery.ensureThread("thread")

  expect(fixture.db.query("SELECT text FROM messages WHERE id='reply'").get()).toEqual({ text: "Saved reply" })
  expect(fixture.db.query("SELECT 1 FROM transcript_pending_deltas WHERE thread_id='thread'").get()).toBeNull()
  expect(recovery.ensureBot("bot")).toBe(recovery.ensureBot("bot"))
  release.resolve()
  await recovery.ready
})
