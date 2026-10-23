import { afterEach, expect, test } from "bun:test"
import { createGroupRuntime } from "../../src/groups/runtime"
import { createGroupStore } from "../../src/groups/store"
import { profileProviders } from "../../src/kernel/provider-profiles"
import { init as initStore } from "../../src/store"
import { createStartupRecovery } from "../../src/store/startup-recovery"
import { testKernel } from "../kernel/test-kernel"

const cleanups = new Set<() => void | Promise<void>>()
afterEach(async () => {
  await Array.from(cleanups).reduceRight(async (previous, cleanup) => {
    await previous
    await cleanup()
  }, Promise.resolve())
  cleanups.clear()
})

test("shared restart recovery preserves durable text before interrupting a streaming reply", async () => {
  const fixture = testKernel()
  cleanups.add(fixture.close)
  await initStore(fixture.kernel)
  await fixture.kernel.services.use("store.recovery")?.dispose()
  fixture.db
    .query("INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES('bot','Fixture',?,'fixture',1,1)")
    .run(profileProviders[0])
  const groups = createGroupStore(fixture.kernel)
  const group = groups.save({
    name: "Fixture",
    color: "#dc2626",
    avatarShape: "classic-none",
    memberIds: ["bot"],
    coordinatorBotId: null,
  })
  const thread = groups.createThread(group)
  fixture.db
    .query(`INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at)
    VALUES('run',?,'bot',?,'user','running',1)`)
    .run(thread.id, profileProviders[0])
  fixture.db.query("INSERT INTO group_turns VALUES('run',?,'[\"bot\"]')").run(group.id)
  fixture.db
    .query(`INSERT INTO messages(id,thread_id,role,kind,status,run_id,text,parts_json,created_at,updated_at)
    VALUES('reply',?,'assistant','text','streaming','run','Saved','[{"type":"text","text":"Saved"}]',1,1)`)
    .run(thread.id)
  fixture.db
    .query(`INSERT INTO transcript_entries(thread_id,seq,generation,event_json,at)
    SELECT thread_id,updated_seq+1,1,json_object('type','message.delta','threadId',thread_id,
      'messageId',id,'partIndex',0,'offset',5,'delta',' reply'),2 FROM messages WHERE id='reply'`)
    .run()
  fixture.db.query("UPDATE threads SET updated_seq=updated_seq+1 WHERE id=?").run(thread.id)
  const release = Promise.withResolvers<void>()
  const recovery = createStartupRecovery(fixture.kernel, undefined, () => release.promise)
  fixture.kernel.services.provide("store.recovery", recovery)
  cleanups.add(recovery.dispose)
  cleanups.add(release.resolve)

  const runtime = createGroupRuntime(fixture.kernel, {
    enqueue: () => ({ success: false, errorCode: "BOT_PAUSED", error: "Fixture paused" }),
    cancel: () => ({ success: false, errorCode: "NOT_FOUND", error: "Fixture missing" }),
  })
  runtime.shutdown({ appRestart: true })
  await runtime.waitForDrain()
  await recovery.ensureThread(thread.id)

  expect(fixture.db.query("SELECT text,status FROM messages WHERE id='reply'").get()).toEqual({
    text: "Saved reply",
    status: "failed",
  })
})
