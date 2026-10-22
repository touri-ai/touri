import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext } from "@touri/contracts"
import { createChannelBrowserRuns, getNextChannelBrowserRun } from "../../src/browser/channel-runs"
import { createKernel } from "../../src/kernel"
import { toRun } from "../../src/runtime/persistence"

const cleanups = new Set<() => void>()

afterEach(() => {
  cleanups.forEach((cleanup) => {
    cleanup()
  })
  cleanups.clear()
})

const getFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "touri-browser-bot-queue-"))
  const runtime = createKernel({ appData: root })
  const database = runtime.kernel.db as Database
  runtime.kernel.services.provide("work.personChannelIds", () => ["team"])
  runtime.kernel.services.provide("work.defaultPersonId", () => "owner")
  database.exec(`
    INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at)
      VALUES ('leo','Léo','codex','/tmp/fixture-leo',1,1), ('bia','Bia','codex','/tmp/fixture-bia',1,1);
    INSERT INTO bot_groups(id,name,color,avatar_shape,avatar_seed,created_at,updated_at)
      VALUES ('team','Equipe','#888888','circle','team',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at,group_id)
      VALUES ('channel-a','leo','Canal A',1,1,'team'), ('channel-b','leo','Canal B',1,1,'team'),
        ('dm','leo','Conversa',1,1,NULL);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at,group_id,group_thread_id)
      VALUES ('session-a','leo','Canal A',1,1,'team','channel-a'),
        ('session-b','leo','Canal B',1,1,'team','channel-b'), ('session-bia','bia','Canal A',1,1,'team','channel-a');
  `)
  const runs = createChannelBrowserRuns({ kernel: runtime.kernel, database })
  cleanups.add(() => {
    runs.dispose()
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  const enter = (runId: string, botId: string, threadId: string, requestMessageId?: string) => {
    database
      .query(`INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at,requester_person_id)
      VALUES (?, ?, ?, 'codex', 'user', 'running', 1, 'ana')`)
      .run(runId, threadId, botId)
    if (requestMessageId) {
      database
        .query(`INSERT INTO messages(id,thread_id,role,kind,status,text,parts_json,source,created_at,updated_at)
        VALUES (?,?,'user','text','complete','Synthetic','[]','local',1,1)`)
        .run(requestMessageId, threadId)
      database.query("UPDATE runs SET request_message_id = ? WHERE id = ?").run(requestMessageId, runId)
    }
    const ctx: ToolContext = {
      runId,
      botId,
      threadId,
      projectId: null,
      cwd: "/tmp",
      signal: new AbortController().signal,
    }
    return runs.enter(ctx)
  }
  const finish = (runId: string) => {
    const row = database.query("SELECT * FROM runs WHERE id = ?").get(runId)
    if (!row) throw new Error("Missing fixture run")

    const run = toRun(Object.assign({}, row, { status: "succeeded" }))
    if (!run) throw new Error("Invalid fixture run")
    runtime.kernel.publish({ type: "run.updated", run })
  }

  return { runs, enter, finish, database, kernel: runtime.kernel }
}

test("one bot waits across channels and direct messages while another bot works", async () => {
  const fixture = getFixture()
  await fixture.enter("first", "leo", "session-a")

  const second = fixture.enter("second", "leo", "session-b")
  const third = fixture.enter("third", "leo", "dm")
  await fixture.enter("independent", "bia", "session-bia")

  expect(fixture.runs.get("second")).toMatchObject({ status: "queued", queuePosition: 1 })
  expect(fixture.runs.get("third")).toMatchObject({ status: "queued", queuePosition: 2 })
  expect(fixture.runs.get("independent")?.status).toBe("running")

  fixture.finish("first")
  await expect(second).resolves.toEqual({ success: true, queued: true })
  expect(fixture.runs.get("third")?.status).toBe("queued")

  fixture.database.exec(`
    INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at)
      VALUES ('second-continued','session-b','leo','codex','retry','running',2);
    INSERT INTO browser_takeover_continuations VALUES ('second-continued','second','second',2);
  `)
  await fixture.runs.enter({
    runId: "second-continued",
    botId: "leo",
    threadId: "session-b",
    projectId: null,
    cwd: "/tmp",
    signal: new AbortController().signal,
  })
  fixture.finish("second-continued")
  await expect(third).resolves.toEqual({ success: true, queued: true })
  expect(fixture.runs.get("third")?.status).toBe("running")
})

test("queue eligibility is scoped to the bot across channel boundaries", () => {
  const queued = [
    { runId: "first", channelId: "a", botId: "leo", queuedAt: 1 },
    { runId: "second", channelId: "b", botId: "leo", queuedAt: 2 },
    { runId: "other", channelId: "a", botId: "bia", queuedAt: 3 },
  ]

  const next = getNextChannelBrowserRun({ queued, active: new Set(["leo"]) })

  expect(next?.runId).toBe("other")
})

test("the human wait keeps its owner and bot slot after the provider finishes", async () => {
  const fixture = getFixture()
  await fixture.enter("first", "leo", "session-a")
  fixture.database
    .query(`INSERT INTO browser_tabs(id,profile,owner_bot_id,owner_thread_id,url,state,created_at,last_used_at)
    VALUES ('tab','default','leo','session-a','https://example.test','live',1,1)`)
    .run()
  fixture.runs.needsYou("first", "login")

  fixture.finish("first")

  expect(fixture.runs.getForTab("tab")).toMatchObject({ status: "needs_you", requesterPersonId: "ana" })
  expect(fixture.runs.takeControl({ runId: "first", actorPersonId: "other" }).success).toBe(false)
  expect(fixture.runs.takeControl({ runId: "first", actorPersonId: "ana" }).success).toBe(true)
  expect(fixture.runs.isPreviewHidden("tab")).toBe(true)

  fixture.runs.cancelRequest("first")

  expect(fixture.runs.get("first")?.status).toBe("canceled")
  expect(fixture.runs.takeControl({ runId: "first", actorPersonId: "other" }).success).toBe(false)
})

test("a continuation that answers without another browser tool releases its original bot slot", async () => {
  const fixture = getFixture()
  await fixture.enter("first", "leo", "session-a", "source")
  fixture.runs.needsYou("first", "Synthetic handoff")
  fixture.finish("first")
  fixture.runs.returnControl({ runId: "first", actorPersonId: "ana" })
  fixture.database.exec(`
    INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at)
      VALUES ('resumed-turn','channel-a','leo','codex','retry','queued',2),
        ('resumed-child','session-a','leo','codex','retry','running',3);
    INSERT INTO browser_takeover_continuations(run_id,original_run_id,previous_run_id,created_at)
      VALUES ('resumed-child','first','first',3);
    UPDATE browser_channel_runs SET current_run_id='resumed-turn' WHERE run_id='first';
  `)

  fixture.finish("resumed-child")

  expect(fixture.runs.get("first")).toMatchObject({ status: "succeeded", activeRunId: "resumed-child" })
  await expect(fixture.enter("next", "leo", "session-b")).resolves.toEqual({ success: true })
  expect(fixture.runs.get("next")?.status).toBe("running")
})
