import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BrowserChannelRunStatus } from "@touri/contracts"
import { getBrowserCancellationTarget } from "../../src/browser/channel-runs"
import type { AuthStore, PersonRole } from "../../src/cli/auth/store"
import { createWorkAccess } from "../../src/cli/work-access"
import { openDatabase } from "../../src/kernel/db"

const cleanups = new Set<() => Promise<void>>()

afterEach(async () => {
  await Promise.all(Array.from(cleanups, (cleanup) => cleanup()))
  cleanups.clear()
})

const getFixture = async (status: BrowserChannelRunStatus = "taken_over", currentRunId = "current-child") => {
  const root = await mkdtemp(join(tmpdir(), "touri-browser-cancel-"))
  const database = openDatabase({ filename: join(root, "test.db") })
  cleanups.add(async () => {
    database.close()
    await rm(root, { recursive: true, force: true })
  })
  database.exec(`
    INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at,responsible_person_id)
      VALUES ('bot','Fixture bot','codex','/workspace/bot',1,1,'responsible');
    INSERT INTO bot_groups(id,name,color,avatar_shape,avatar_seed,created_at,updated_at)
      VALUES ('team','Fixture team','#888888','circle','team',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at,group_id)
      VALUES ('channel','bot','Fixture channel',1,1,'team'), ('private','bot','Private fixture',1,1,NULL);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at,group_id,group_thread_id)
      VALUES ('session','bot','Fixture session',1,1,'team','channel');
    INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at)
      VALUES ('original-root','channel','bot','codex','user','succeeded',1),
        ('prior-root','channel','bot','codex','retry','succeeded',2),
        ('resumed-root','channel','bot','codex','retry','running',3),
        ('original-child','session','bot','codex','user','succeeded',1),
        ('prior-child','session','bot','codex','retry','succeeded',2),
        ('ordinary','channel','bot','codex','user','running',4),
        ('private-run','private','bot','codex','user','running',4);
    INSERT INTO group_turns(run_id,group_id,recipients_json)
      VALUES ('original-root','team','["bot"]'), ('prior-root','team','["bot"]'),
        ('resumed-root','team','["bot"]');
    INSERT INTO group_run_links(run_id,turn_id,depth)
      VALUES ('original-child','original-root',0), ('prior-child','prior-root',0);
    INSERT INTO browser_takeover_continuations(run_id,original_run_id,previous_run_id,created_at)
      VALUES ('prior-child','original-child','original-child',2);
  `)
  if (currentRunId === "current-child") {
    database.exec(`
      INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at)
        VALUES ('current-child','session','bot','codex','retry','running',3);
      INSERT INTO group_run_links(run_id,turn_id,depth) VALUES ('current-child','resumed-root',0);
      INSERT INTO browser_takeover_continuations(run_id,original_run_id,previous_run_id,created_at)
        VALUES ('current-child','original-child','prior-child',3);
    `)
  }
  database
    .query(`INSERT INTO browser_channel_runs
      (run_id,current_run_id,group_id,thread_id,bot_id,requester_person_id,responsible_person_id,
        controller_person_id,status,queued_at)
      VALUES ('original-child',?,'team','channel','bot','requester','responsible','responsible',?,1)`)
    .run(currentRunId, status)
  const authStore: Pick<AuthStore, "getPersonChannelIds" | "getPerson"> = {
    getPersonChannelIds: (personId: string) => (personId === "outsider" ? [] : ["team"]),
    getPerson: () => null,
  }
  const access = createWorkAccess({ database, authStore: authStore as AuthStore })
  const getCancelDecision = (runId: string, personId = "unrelated", role: PersonRole = "member") =>
    access.authorizeHttp({ personId, role, method: "POST", pathname: `/runs/${runId}/cancel`, body: null })

  return { database, access, getCancelDecision }
}

const aliases = ["original-child", "current-child", "prior-child", "original-root", "resumed-root", "prior-root"]
const activeStatuses: Array<BrowserChannelRunStatus> = ["queued", "running", "needs_you", "taken_over"]

test.each(aliases)("browser cancellation through %s requires requester or responsible ownership", async (runId) => {
  const fixture = await getFixture()

  const memberDecision = fixture.getCancelDecision(runId)
  const adminDecision = fixture.getCancelDecision(runId, "unrelated-admin", "admin")
  const requesterDecision = fixture.getCancelDecision(runId, "requester")
  const requesterAdminDecision = fixture.getCancelDecision(runId, "requester", "admin")
  const responsibleDecision = fixture.getCancelDecision(runId, "responsible")
  const responsibleAdminDecision = fixture.getCancelDecision(runId, "responsible", "admin")
  const outsiderDecision = fixture.getCancelDecision(runId, "outsider")

  expect(memberDecision).toMatchObject({ status: 403, json: { errorCode: "BROWSER_CONTROL_FORBIDDEN" } })
  expect(adminDecision).toMatchObject({ status: 403, json: { errorCode: "BROWSER_CONTROL_FORBIDDEN" } })
  expect(requesterDecision).toBeNull()
  expect(requesterAdminDecision).toBeNull()
  expect(responsibleDecision).toBeNull()
  expect(responsibleAdminDecision).toBeNull()
  expect(outsiderDecision).toMatchObject({ status: 404, json: { errorCode: "NOT_FOUND" } })
})

test.each(activeStatuses)("%s browser requests remain protected through every continuation alias", async (status) => {
  const fixture = await getFixture(status)

  const decisions = aliases.map((runId) => fixture.getCancelDecision(runId))

  expect(decisions).toEqual(
    aliases.map(() =>
      expect.objectContaining({
        status: 403,
        json: expect.objectContaining({ errorCode: "BROWSER_CONTROL_FORBIDDEN" }),
      }),
    ),
  )
})

test.each(["original-root", "prior-root", "resumed-root"])(
  "browser cancellation through %s stays protected before a resumed child is linked",
  async (runId) => {
    const fixture = await getFixture("running", "resumed-root")

    const unrelatedDecision = fixture.getCancelDecision(runId)
    const adminDecision = fixture.getCancelDecision(runId, "unrelated-admin", "admin")
    const requesterDecision = fixture.getCancelDecision(runId, "requester")
    const responsibleDecision = fixture.getCancelDecision(runId, "responsible")
    const outsiderDecision = fixture.getCancelDecision(runId, "outsider")

    expect(unrelatedDecision).toMatchObject({ status: 403, json: { errorCode: "BROWSER_CONTROL_FORBIDDEN" } })
    expect(adminDecision).toMatchObject({ status: 403, json: { errorCode: "BROWSER_CONTROL_FORBIDDEN" } })
    expect(requesterDecision).toBeNull()
    expect(responsibleDecision).toBeNull()
    expect(outsiderDecision).toMatchObject({ status: 404, json: { errorCode: "NOT_FOUND" } })
  },
)

test.each<BrowserChannelRunStatus>(["succeeded", "failed", "canceled"])(
  "%s browser requests retain ordinary cancellation authorization",
  async (status) => {
    const fixture = await getFixture(status)

    const memberDecisions = aliases.map((runId) => fixture.getCancelDecision(runId))
    const adminDecisions = aliases.map((runId) => fixture.getCancelDecision(runId, "unrelated-admin", "admin"))
    const outsiderDecisions = aliases.map((runId) => fixture.getCancelDecision(runId, "outsider"))

    expect(memberDecisions).toEqual(aliases.map(() => null))
    expect(adminDecisions).toEqual(aliases.map(() => null))
    expect(outsiderDecisions).toEqual(aliases.map(() => expect.objectContaining({ status: 404 })))
  },
)

test.each(["requester_person_id", "responsible_person_id"])(
  "inaccessible %s receives 404 before browser ownership is checked",
  async (column) => {
    const fixture = await getFixture()
    fixture.database.query(`UPDATE browser_channel_runs SET ${column} = 'outsider'`).run()

    const decisions = aliases.map((runId) => fixture.getCancelDecision(runId, "outsider"))

    expect(decisions).toEqual(
      aliases.map(() =>
        expect.objectContaining({ status: 404, json: expect.objectContaining({ errorCode: "NOT_FOUND" }) }),
      ),
    )
  },
)

test("nonbrowser cancellation, retry, and missing runs retain their authorization", async () => {
  const fixture = await getFixture()

  const ordinaryDecision = fixture.getCancelDecision("ordinary")
  const adminDecision = fixture.getCancelDecision("ordinary", "unrelated-admin", "admin")
  const outsiderDecision = fixture.getCancelDecision("ordinary", "outsider")
  const privateDecision = fixture.getCancelDecision("private-run")
  const missingDecision = fixture.getCancelDecision("missing")
  const retryDecision = fixture.access.authorizeHttp({
    personId: "unrelated",
    role: "member",
    method: "POST",
    pathname: "/runs/current-child/retry",
    body: null,
  })

  expect(ordinaryDecision).toBeNull()
  expect(adminDecision).toBeNull()
  expect(outsiderDecision).toMatchObject({ status: 404 })
  expect(privateDecision).toMatchObject({ status: 404 })
  expect(missingDecision).toMatchObject({ status: 404 })
  expect(retryDecision).toBeNull()
})

test("browser cancellation seeks indexed aliases with unrelated request history", async () => {
  const fixture = await getFixture()
  fixture.database.exec(`
    WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<12000)
      INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at)
      SELECT 'history-original-'||x,'session','bot','codex','user','succeeded',x FROM n
      UNION ALL SELECT 'history-alias-'||x,'session','bot','codex','retry','succeeded',x FROM n
      UNION ALL SELECT 'history-root-'||x,'channel','bot','codex','user','succeeded',x FROM n;
    INSERT INTO group_turns(run_id,group_id,recipients_json)
      SELECT id,'team','["bot"]' FROM runs WHERE id LIKE 'history-root-%';
    INSERT INTO group_run_links(run_id,turn_id,depth)
      SELECT id,replace(id,'original','root'),0 FROM runs WHERE id LIKE 'history-original-%';
    INSERT INTO browser_takeover_continuations(run_id,original_run_id,previous_run_id,created_at)
      SELECT id,replace(id,'alias','original'),replace(id,'alias','original'),queued_at
      FROM runs WHERE id LIKE 'history-alias-%';
    INSERT INTO browser_channel_runs(run_id,current_run_id,group_id,thread_id,bot_id,status,queued_at)
      SELECT id,replace(id,'original','alias'),'team','channel','bot','succeeded',queued_at
      FROM runs WHERE id LIKE 'history-original-%';
  `)
  const query = spyOn(fixture.database, "query")
  cleanups.add(async () => {
    query.mockRestore()
  })

  const decisions = aliases.map((runId) => fixture.getCancelDecision(runId))
  const sql = query.mock.calls.map(([statement]) => statement).find((statement) => statement.includes("LIMIT 1"))
  if (!sql) throw new Error("Missing browser authorization query")
  const plan = fixture.database
    .query<{ detail: string }, [string, string]>(`EXPLAIN QUERY PLAN ${sql}`)
    .all("resumed-root", "resumed-root")
    .map(({ detail }) => detail)
    .join("\n")

  expect(decisions).toEqual(aliases.map(() => expect.objectContaining({ status: 403 })))
  expect(plan).toContain("group_run_links_turn")
  expect(plan).toContain("browser_channel_runs_current")
  expect(plan).toContain("sqlite_autoindex_browser_channel_runs_1")
  expect(plan).toContain("sqlite_autoindex_browser_takeover_continuations_1")
  expect(plan).not.toMatch(/SCAN (?:browser|group_run_links|browser_takeover_continuations)\b/u)
  expect(plan).not.toContain("TEMP B-TREE")
  console.info(`Browser cancellation query plan (12000 historical requests):\n${plan}`)

  const queryOffset = query.mock.calls.length
  const target = getBrowserCancellationTarget(fixture.database, "resumed-root")
  const targetQueries = query.mock.calls.slice(queryOffset).map(([statement]) => statement)
  const targetPlan = targetQueries
    .flatMap((statement) => {
      const parameters = statement.includes("current_run_id IN")
        ? ["resumed-root"]
        : ["resumed-root", "resumed-root", "resumed-root"]
      return fixture.database.query<{ detail: string }, string[]>(`EXPLAIN QUERY PLAN ${statement}`).all(...parameters)
    })
    .map(({ detail }) => detail)
    .join("\n")

  expect(target).toMatchObject({ runId: "current-child", requestId: "original-child" })
  expect(targetQueries).toHaveLength(2)
  expect(targetPlan).toContain("group_run_links_turn")
  expect(targetPlan).toContain("browser_channel_runs_current")
  expect(targetPlan).toContain("sqlite_autoindex_browser_channel_runs_1")
  expect(targetPlan).toContain("sqlite_autoindex_browser_takeover_continuations_1")
  expect(targetPlan).not.toMatch(/SCAN (?:browser_channel_runs|group_run_links|browser_takeover_continuations)\b/u)
  expect(targetPlan).not.toContain("TEMP B-TREE")
  console.info(`Browser cancellation target plans (12000 historical requests):\n${targetPlan}`)
})
