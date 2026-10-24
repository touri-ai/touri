import type { Database } from "bun:sqlite"
import { afterEach, expect, mock, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { MessagePart, RecoveryTask, Run } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { createPerformanceStageTracker } from "../../src/kernel/performance"
import { init as initNotify, NOTIFICATION_HISTORY_RECONCILE_SQL } from "../../src/notify"
import { createNotifier } from "../../src/notify/notifier"
import { createRecoverySync } from "../../src/notify/recovery"
import { createSseHub } from "../../src/notify/sse"
import { createNotificationStore } from "../../src/notify/store"
import { createRuntimePersistence } from "../../src/runtime/persistence"
import { createWorkState } from "../../src/runtime/work-state"
import { init as initStore } from "../../src/store"

// Resource ownership stays at the test boundary; each fixture has its own database.
const cleanups = new Set<() => void | Promise<void>>()
afterEach(async () => {
  for (const close of Array.from(cleanups).reverse()) await close()
  cleanups.clear()
})

const getFixture = async (
  options: {
    beforeNotify?: (database: Database) => void
    native?: boolean
    yieldHistoryBatch?: () => Promise<void>
  } = {},
) => {
  const root = mkdtempSync(join(tmpdir(), "touri-recovery-center-"))
  const runtime = createKernel({ appData: root })
  const database = runtime.kernel.db as Database
  database.query("INSERT INTO settings (key, value_json, updated_at) VALUES ('nativeNotifications', 'false', 0)").run()
  cleanups.add(async () => {
    await runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  await initStore(runtime.kernel)
  database.exec(`INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES
    ('bot-a','Equipe A','codex','/tmp',1,1), ('bot-b','Equipe B','codex','/tmp',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES
    ('thread-a','bot-a','Notas',1,1), ('thread-b','bot-b','Revisão',1,1);`)
  options.beforeNotify?.(database)
  if (options.native) database.query("DELETE FROM settings WHERE key = 'nativeNotifications'").run()
  const hostCalls = mock(runtime.kernel.callHost)
  const stages = createPerformanceStageTracker(() => 0)
  await initNotify({ ...runtime.kernel, callHost: hostCalls }, stages.run, options.yieldHistoryBatch)
  await runtime.kernel.services.use("notify.recovery")?.ready

  const { token } = JSON.parse(readFileSync(join(root, "run", "handshake.json"), "utf8")) as { token: string }
  const request = (path: string, body?: object) =>
    fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, "X-Touri-Client": "test", "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  const getTasks = async (): Promise<RecoveryTask[]> => {
    const response = await request("/recovery")
    expect(response.status).toBe(200)

    const snapshot: { tasks: RecoveryTask[] } = await response.json()
    return snapshot.tasks
  }
  return {
    runtime,
    database,
    request,
    getTasks,
    hostCalls,
    stageCalls: () => stages.snapshot().map((timing) => timing.stage),
    work: createWorkState({ database, now: () => 100 }),
  }
}

const saveRun = (database: Database, id: string, status = "interrupted", parts: MessagePart[] = []) => {
  database
    .query(`INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,error_class,queued_at,finished_at)
    VALUES (?,'thread-a','bot-a','codex','user',?,'app_restart',100,200)`)
    .run(id, status)
  database
    .query(`INSERT INTO messages(id,thread_id,role,kind,status,run_id,parts_json,created_at,updated_at)
    VALUES (?,'thread-a','assistant','text','failed',?,?,100,200)`)
    .run(`reply-${id}`, id, JSON.stringify(parts))
}

const saveUncertainEffect = (work: ReturnType<typeof createWorkState>, turnId: string) => {
  work.beginEffect({
    turnId,
    threadId: "thread-a",
    key: "preview-key",
    description: "Prévia",
    effectId: "effect-preview",
  })
  work.recover({ observe: () => ({ kind: "unobservable", reason: "Outcome unavailable" }) })
}

test("aggregates interrupted turns, failed turns with effects, orphan journal work and failed routines without duplicates", async () => {
  const h = await getFixture()
  saveRun(h.database, "interrupted")
  saveRun(h.database, "failed", "failed", [{ type: "file_change", callId: "write", paths: ["notas.md"], diff: null }])
  saveRun(h.database, "no-effects", "failed")
  saveUncertainEffect(h.work, "orphan-turn")
  h.database.exec(`INSERT INTO routines(id,bot_id,name,prompt,cron,timezone,created_at,updated_at)
    VALUES ('routine','bot-b','Resumo','Organize as notas','0 9 * * *','UTC',1,1);
    INSERT INTO routine_runs(id,routine_id,scheduled_for,status,trigger_source,finished_at)
    VALUES ('routine-failed','routine',100,'failed','cron',200);`)

  const tasks = await h.getTasks()
  const repeated = await h.getTasks()

  expect(new Set(tasks.map((task) => task.id))).toEqual(
    new Set(["journal:orphan-turn", "routine:routine-failed", "run:failed", "run:interrupted"]),
  )
  expect(tasks.find((task) => task.id === "run:failed")?.effects[0]?.description).toBe("notas.md")
  expect(tasks.find((task) => task.id === "journal:orphan-turn")?.effects[0]?.acknowledgeKey).toBe("preview-key")
  expect(tasks.find((task) => task.routineId)?.notification.botName).toBe("Equipe B")
  expect(tasks.find((task) => task.id === "journal:orphan-turn")?.notification.title).toBe("Tarefas interrompidas")
  expect(tasks.find((task) => task.id === "journal:orphan-turn")?.notification.body).not.toContain("app_restart")
  expect(repeated.map((task) => task.notification.id)).toEqual(tasks.map((task) => task.notification.id))
})

test("restart recovery attributes synthetic journal scans and reconciliation stages", async () => {
  const h = await getFixture({
    beforeNotify: (database) => {
      const work = createWorkState({ database, now: () => 100 })
      for (let index = 0; index < 120; index++) saveUncertainEffect(work, `orphan-${index}`)
    },
  })

  expect(h.stageCalls()).toContain("notification_run_recovery_scan")
  expect(h.stageCalls()).toContain("notification_recovery_reconcile")
})

test("restart history reconcile uses bounded reads and a persisted stage marker", async () => {
  const progress: number[] = []
  const databaseRef: { database: Database | null } = { database: null }
  const h = await getFixture({
    beforeNotify: (database) => {
      databaseRef.database = database
      const saveRun = database.query(`INSERT INTO runs(
        id,thread_id,bot_id,provider,trigger,status,queued_at,finished_at
      ) VALUES (?,'thread-a','bot-a','codex','user','succeeded',1,2)`)
      const saveNotification = database.query(`INSERT INTO notifications(
        kind,level,bot_id,thread_id,title,body,created_at
      ) VALUES ('turn-failed','error','bot-a','thread-a',?,'synthetic',1)`)
      Array.from({ length: 120 }, (_, index) => index).forEach((index) => {
        saveRun.run(`completed-${index}`)
        saveNotification.run(`failed-${index}`)
      })
    },
    yieldHistoryBatch: async () => {
      const database = databaseRef.database
      if (!database) throw new Error("Missing synthetic database")
      const row = database
        .query("SELECT value_json FROM settings WHERE key = 'notification.history-reconcile'")
        .get() as { value_json: string } | null
      if (!row) throw new Error("History reconcile marker was not saved")
      const state = JSON.parse(row.value_json) as { stage: string; cursor: number; upper: number }
      expect(state).toMatchObject({ stage: "notification_history_reconcile", upper: 120 })
      progress.push(state.cursor)
      await Bun.sleep(0)
    },
  })
  expect(progress).toEqual([50, 100])
  expect(
    (
      h.database.query("SELECT COUNT(*) AS count FROM notifications WHERE resolved_at IS NULL").get() as {
        count: number
      }
    ).count,
  ).toBe(0)
  expect(h.database.query("SELECT value_json FROM settings WHERE key = 'notification.history-reconcile'").get()).toBe(
    null,
  )
})

test("historical reconciliation looks up runs by conversation instead of unrelated successful history", async () => {
  const h = await getFixture({
    beforeNotify: (database) => {
      database.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<200)
        INSERT INTO threads(id,bot_id,title,created_at,updated_at)
        SELECT 'other-'||x,'bot-a','Notas fictícias',1,1 FROM n;
        WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<20000)
        INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at,finished_at)
        SELECT 'other-run-'||x,'other-'||(1+x%200),'bot-a','codex','user','succeeded',1,2 FROM n;
        WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<50)
        INSERT INTO notifications(kind,level,bot_id,thread_id,title,body,created_at)
        SELECT 'turn-failed','error','bot-a','thread-a','Brisa fictícia parou','Revise a tarefa fictícia',3 FROM n;`)
    },
  })

  const plan = h.database.query(`EXPLAIN QUERY PLAN ${NOTIFICATION_HISTORY_RECONCILE_SQL}`).all(0, 50) as Array<{
    detail: string
  }>
  const runLookups = plan.map((step) => step.detail).filter((detail) => detail.startsWith("SEARCH r "))
  const samples = Array.from({ length: 10 }, () => {
    const start = performance.now()
    h.database.query(NOTIFICATION_HISTORY_RECONCILE_SQL).all(0, 50)
    return performance.now() - start
  })

  console.info(
    JSON.stringify({
      probe: "notification-history",
      unrelatedRuns: 20000,
      conversations: 200,
      notifications: 50,
      runLookups,
      samples,
    }),
  )
  expect(runLookups).toHaveLength(2)
  expect(runLookups.every((detail) => detail.includes("runs_thread (thread_id=?)"))).toBe(true)
  expect(plan.some((step) => step.detail.startsWith("SCAN r"))).toBe(false)
})

test.each(["root", "member", "direct", "routine"])(
  "restart keeps %s failure attention when only another bot succeeded",
  async (scope) => {
    const h = await getFixture({
      beforeNotify: (database) => saveHistoricalBotFailure(database, scope, "bot-b"),
    })

    const store = createNotificationStore({ db: h.database })
    const notification = store.byRequestId("recovery:run:failed-original")

    expect(notification?.resolvedAt).toBeNull()
    expect(h.database.query("SELECT status FROM runs WHERE id = 'failed-original'").get()).toEqual({ status: "failed" })
    expect(h.database.query("SELECT COUNT(*) AS count FROM runs").get()).toEqual({ count: 2 })
  },
)

test.each(["root", "member", "direct", "routine"])(
  "restart resolves %s failure attention after the same bot succeeded",
  async (scope) => {
    const h = await getFixture({
      beforeNotify: (database) => saveHistoricalBotFailure(database, scope, "bot-a"),
    })

    const notification = createNotificationStore({ db: h.database }).byRequestId("recovery:run:failed-original")

    expect(notification?.resolution).toBe("expired")
    expect(notification?.resolvedAt).not.toBeNull()
    expect(h.database.query("SELECT status FROM runs WHERE id = 'failed-original'").get()).toEqual({ status: "failed" })
  },
)

test("restart resolves a member's successful retry on a root owned by another bot", async () => {
  const h = await getFixture({
    beforeNotify: (database) => {
      saveHistoricalBotFailure(database, "root", "bot-a")
      database.query("UPDATE threads SET bot_id = 'bot-b' WHERE id = 'thread-a'").run()
    },
  })

  const notification = createNotificationStore({ db: h.database }).byRequestId("recovery:run:failed-original")

  expect(notification?.resolution).toBe("expired")
})

test.each(["bot-a", "bot-b"])("restart preserves uncertain effects after success by %s", async (botId) => {
  const h = await getFixture({
    beforeNotify: (database) => {
      saveHistoricalBotFailure(database, "root", botId)
      const work = createWorkState({ database, now: () => 100 })
      saveUncertainEffect(work, "failed-original")
    },
  })

  const notification = createNotificationStore({ db: h.database }).byRequestId("recovery:run:failed-original")
  const work = h.work.rebuild({ turnId: "failed-original" })

  expect(notification?.resolvedAt).toBeNull()
  expect(work).toHaveLength(1)
})

const saveHistoricalBotFailure = (database: Database, scope: string, laterBotId: string) => {
  if (scope === "root" || scope === "member")
    database.exec(`INSERT INTO bot_groups(id,name,color,avatar_shape,avatar_seed,coordinator_bot_id,created_at,updated_at)
      VALUES ('group-a','Caderno fictício','#2563eb','classic-none','fixture','bot-a',1,1);
      UPDATE threads SET group_id = 'group-a' WHERE id = 'thread-a'`)
  if (scope === "member")
    database.exec(`INSERT INTO threads(id,bot_id,title,group_thread_id,created_at,updated_at)
      VALUES ('member-a','bot-a','Brisa fictícia','thread-a',1,1)`)
  if (scope === "routine")
    database.exec(`INSERT INTO routines(id,bot_id,name,prompt,cron,timezone,created_at,updated_at)
      VALUES ('routine-a','bot-a','Resumo fictício','Organize notas fictícias','0 9 * * *','UTC',1,1)`)

  const executionThreadId = scope === "member" ? "member-a" : "thread-a"
  const kind = scope === "routine" ? "routine-failed" : "turn-failed"
  database
    .query(`INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at,finished_at)
    VALUES ('failed-original',?,'bot-a','codex','user','failed',1,2),
      ('later-success',?,?,'codex','user','succeeded',4,5)`)
    .run(executionThreadId, executionThreadId, laterBotId)
  if (scope === "routine")
    database.exec(`INSERT INTO routine_runs(id,routine_id,thread_id,run_id,scheduled_for,status,trigger_source,finished_at)
      VALUES ('routine-original','routine-a','thread-a','failed-original',1,'failed','cron',2);
      UPDATE runs SET routine_run_id = 'routine-original' WHERE id = 'failed-original'`)
  database
    .query(`INSERT INTO notifications(kind,level,bot_id,thread_id,request_id,title,body,created_at)
    VALUES (?,'error','bot-a','thread-a','recovery:run:failed-original','Brisa fictícia parou','Revise a tarefa fictícia',3)`)
    .run(kind)
}

test("uncertain effects require their existing journal key on every dismissal surface and preserve history", async () => {
  const h = await getFixture()
  saveRun(h.database, "interrupted")
  saveUncertainEffect(h.work, "interrupted")
  const tasks = await h.getTasks()
  const task = tasks[0]
  if (!task) throw new Error("Expected interruption")

  const missingKey = await h.request("/recovery/run%3Ainterrupted/dismiss", { acknowledgeKeys: [] })
  const wrongKey = await h.request("/recovery/run%3Ainterrupted/dismiss", { acknowledgeKeys: ["another-key"] })
  const bell = await h.request(`/notifications/${task.notification.id}/dismiss`, {})
  const clearAll = await h.request("/notifications/dismiss-all", {})

  expect([missingKey.status, wrongKey.status, bell.status, clearAll.status]).toEqual([409, 409, 409, 200])
  expect(await clearAll.json()).toEqual({ dismissed: 0, skipped: 1, skippedIds: [task.notification.id] })
  expect(h.work.isBlocked({ key: "preview-key" })).toBe(true)
  expect((await h.getTasks())[0]?.notification.resolvedAt).toBeNull()

  const response = await h.request("/recovery/run%3Ainterrupted/dismiss", { acknowledgeKeys: ["preview-key"] })
  const resolved = await h.getTasks()

  expect(response.status).toBe(200)
  expect(h.work.isBlocked({ key: "preview-key" })).toBe(false)
  expect(resolved[0]?.notification.resolution).toBe("dismissed")
  expect(h.database.query("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 1 })
  expect(h.database.query("SELECT COUNT(*) AS count FROM work_journal WHERE kind = 'acknowledged'").get()).toEqual({
    count: 1,
  })
})

test("a new chat turn resolves the same notification immediately while uncertain effects remain pending", async () => {
  const h = await getFixture()
  saveRun(h.database, "interrupted")
  saveRun(h.database, "uncertain")
  saveUncertainEffect(h.work, "uncertain")
  const task = (await h.getTasks()).find((item) => item.id === "run:interrupted")
  if (!task) throw new Error("Expected interruption")
  const run: Run = {
    id: "next-turn",
    threadId: "thread-a",
    botId: "bot-a",
    provider: "codex",
    trigger: "user",
    requestMessageId: null,
    replyMessageId: null,
    externalTurnId: null,
    status: "queued",
    errorClass: null,
    errorMessage: null,
    usage: null,
    routineRunId: null,
    queuedAt: Date.now() + 1,
    startedAt: null,
    finishedAt: null,
  }

  h.runtime.kernel.publish({ type: "run.updated", run })
  const resolved = await h.getTasks()

  const previous = resolved.find((item) => item.id === task.id)
  expect(previous?.notification.resolution).toBe("expired")
  expect(previous?.notification.id).toBe(task.notification.id)
  expect(previous?.notification.resolvedAt).not.toBeNull()
  expect(resolved.find((item) => item.id === "run:uncertain")?.notification.resolvedAt).toBeNull()
  expect(h.work.isBlocked({ key: "preview-key" })).toBe(true)
})

test("journal recovery keeps one identity when its turn is subsequently marked interrupted", async () => {
  const h = await getFixture()
  saveRun(h.database, "recovering", "running")
  saveUncertainEffect(h.work, "recovering")
  const before = await h.getTasks()

  h.database.query("UPDATE runs SET status = 'interrupted' WHERE id = ?").run("recovering")
  const after = await h.getTasks()

  expect(before).toHaveLength(1)
  expect(after).toHaveLength(1)
  expect(after[0]?.id).toBe(before[0]?.id)
  expect(after[0]?.notification.id).toBe(before[0]?.notification.id)
  expect(h.database.query("SELECT COUNT(*) AS count FROM notifications WHERE resolved_at IS NULL").get()).toEqual({
    count: 1,
  })
})

test("a later routine execution resolves a failure that never created a conversation", async () => {
  const h = await getFixture()
  h.database.exec(`INSERT INTO routines(id,bot_id,name,prompt,cron,timezone,created_at,updated_at)
    VALUES ('routine','bot-b','Resumo','Organize as notas','0 9 * * *','UTC',1,1);
    INSERT INTO routine_runs(id,routine_id,scheduled_for,status,trigger_source,finished_at)
    VALUES ('routine-failed','routine',100,'failed','cron',200);`)
  const before = await h.getTasks()

  h.database.exec(`INSERT INTO routine_runs(id,routine_id,scheduled_for,status,trigger_source,started_at,finished_at)
    VALUES ('routine-next','routine',300,'succeeded','manual',300,400);`)
  const after = await h.getTasks()

  expect(before).toHaveLength(1)
  expect(after[0]?.notification.id).toBe(before[0]?.notification.id)
  expect(after[0]?.notification.resolution).toBe("expired")
})

test("a task that no scan finds anymore stops asking for attention", async () => {
  const h = await getFixture()
  saveRun(h.database, "resumed-run")
  const before = await h.getTasks()

  h.database.query("UPDATE runs SET status = 'succeeded' WHERE id = 'resumed-run'").run()
  const after = await h.getTasks()
  const pending = await h.request("/notifications/pending")
  const { notifications }: { notifications: Array<{ id: number }> } = await pending.json()

  expect(before[0]?.notification.resolvedAt).toBeNull()
  expect(after.filter((task) => task.notification.resolvedAt === null)).toHaveLength(0)
  expect(notifications.map((item) => item.id)).not.toContain(before[0]?.notification.id)
})

test("a task whose thread disappeared stays listed for review while its effects are uncertain", async () => {
  const h = await getFixture()
  saveRun(h.database, "archived-uncertain")
  saveUncertainEffect(h.work, "archived-uncertain")
  const before = await h.getTasks()

  h.database.exec("PRAGMA foreign_keys = OFF; DELETE FROM threads WHERE id = 'thread-a'")
  const after = await h.getTasks()
  const pending = await h.request("/notifications/pending")
  const { notifications }: { notifications: Array<{ id: number }> } = await pending.json()

  expect(before[0]?.notification.resolvedAt).toBeNull()
  expect(after.map((task) => task.id)).toEqual(["run:archived-uncertain"])
  expect(after[0]?.notification.resolvedAt).toBeNull()
  expect(after[0]?.effects[0]?.acknowledgeKey).toBe("preview-key")
  expect(notifications).toHaveLength(1)
  expect(notifications[0]?.id).toBe(before[0]?.notification.id)
})

test("a restart clears an interrupted routine run once a later run of the routine succeeded in its thread", async () => {
  const h = await getFixture()
  h.database.exec(`INSERT INTO routines(id,bot_id,name,prompt,cron,timezone,created_at,updated_at)
    VALUES ('routine','bot-a','Resumo','Organize as notas','0 9 * * *','UTC',1,1);
    INSERT INTO routine_runs(id,routine_id,thread_id,scheduled_for,status,trigger_source,finished_at)
    VALUES ('routine-interrupted','routine','thread-a',100,'failed','cron',200);`)
  saveRun(h.database, "routine-turn")
  h.database.exec(`UPDATE runs SET routine_run_id = 'routine-interrupted' WHERE id = 'routine-turn';
    UPDATE routine_runs SET run_id = 'routine-turn' WHERE id = 'routine-interrupted';`)
  const before = await h.getTasks()

  h.database.exec(`INSERT INTO routine_runs(id,routine_id,thread_id,scheduled_for,status,trigger_source,started_at,finished_at)
    VALUES ('routine-next','routine','thread-a',300,'succeeded','cron',300,400);`)
  const store = createNotificationStore({ db: h.database })
  const notifier = createNotifier({ kernel: h.runtime.kernel, store, hub: createSseHub({ store }) })
  const restarted = await createRecoverySync(h.runtime.kernel, store, notifier)({ silent: true })
  const pending = await h.request("/notifications/pending")
  const { notifications }: { notifications: Array<{ id: number }> } = await pending.json()

  expect(before.filter((task) => task.notification.resolvedAt === null)).toHaveLength(1)
  expect(restarted.filter((task) => task.notification.resolvedAt === null)).toHaveLength(0)
  expect(notifications.map((item) => item.id)).not.toContain(before[0]?.notification.id)
})

test("newly discovered uncertainty requires another review without erasing an earlier acknowledgement", async () => {
  const h = await getFixture()
  saveRun(h.database, "recovering")
  h.work.beginEffect({
    turnId: "recovering",
    threadId: "thread-a",
    key: "preview-key",
    description: "Prévia",
    effectId: "effect-preview",
  })
  const previous = (await h.getTasks())[0]
  if (!previous) throw new Error("Expected interruption")
  const dismissal = await h.request(`/notifications/${previous.notification.id}/dismiss`, {})

  h.work.recover({ observe: () => ({ kind: "unobservable", reason: "Outcome unavailable" }) })
  const current = (await h.getTasks())[0]

  expect(dismissal.status).toBe(200)
  expect(current?.notification.id).not.toBe(previous.notification.id)
  expect(current?.notification.resolvedAt).toBeNull()
  expect(current?.effects[0]?.acknowledgeKey).toBe("preview-key")
  expect(h.database.query("SELECT resolution FROM notifications WHERE id = ?").get(previous.notification.id)).toEqual({
    resolution: "dismissed",
  })
  expect(h.work.isBlocked({ key: "preview-key" })).toBe(true)
})

test("clearing the bell includes old pending items and keeps uncertain work available for review", async () => {
  const h = await getFixture()
  saveRun(h.database, "ordinary")
  saveRun(h.database, "uncertain")
  saveUncertainEffect(h.work, "uncertain")
  const initial = await h.getTasks()
  const uncertain = initial.find((task) => task.runId === "uncertain")
  if (!uncertain) throw new Error("Expected uncertain task")
  h.database.query("UPDATE notifications SET created_at = 0").run()

  const response = await h.request("/notifications/dismiss-all", {})
  const tasks = await h.getTasks()

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ dismissed: 1, skipped: 1, skippedIds: [uncertain.notification.id] })
  expect(tasks.find((task) => task.runId === "ordinary")?.notification.resolution).toBe("dismissed")
  expect(tasks.find((task) => task.runId === "uncertain")?.notification.resolvedAt).toBeNull()
  expect(h.work.isBlocked({ key: "preview-key" })).toBe(true)
})

test("bounds history discovery and reuses the snapshot until the database changes", async () => {
  const h = await getFixture()
  saveRun(h.database, "pending")
  const pending = (await h.getTasks())[0]
  if (!pending) throw new Error("Expected pending interruption")
  Array.from({ length: 300 }, (_, index) => saveRun(h.database, `history-${index}`, "failed"))
  // Malformed old parts must never be inspected by the bounded discovery window.
  h.database.query("UPDATE messages SET parts_json = '[null]' WHERE run_id = 'history-0'").run()
  const store = createNotificationStore({ db: h.database })
  const hub = createSseHub({ store })
  const notifier = createNotifier({ kernel: h.runtime.kernel, store, hub })
  const sync = createRecoverySync(h.runtime.kernel, store, notifier)

  const tasks = await sync()
  const repeated = await sync()
  h.database.query("UPDATE messages SET parts_json = '[null]' WHERE run_id = 'history-299'").run()
  const afterUnrelatedWrite = await sync()
  saveRun(h.database, "new-interruption")
  const updated = await sync()

  expect(tasks.map((task) => task.id)).toEqual([pending.id])
  expect(repeated).toEqual(tasks)
  expect(afterUnrelatedWrite).toEqual(tasks)
  expect(updated.map((task) => task.id)).toContain("run:new-interruption")
  expect(updated.map((task) => task.id)).toContain("run:pending")
})

test("startup backfills old interrupted work without native notifications", async () => {
  const h = await getFixture({ native: true, beforeNotify: (database) => saveRun(database, "old-interruption") })

  const tasks = await h.getTasks()

  expect(tasks.map((task) => task.id)).toEqual(["run:old-interruption"])
  expect(tasks[0]?.notification.resolvedAt).toBeNull()
  expect(h.hostCalls).not.toHaveBeenCalled()
})

test("a terminal event discovers a run queued before the recent history window", async () => {
  const h = await getFixture()
  const delivered = Promise.withResolvers<void>()
  const unsubscribe = h.runtime.kernel.subscribe(({ event }) => {
    if (event.type === "run.updated" && event.run.id === "long-running") delivered.resolve()
  })
  cleanups.add(unsubscribe)
  saveRun(h.database, "long-running", "running")
  Array.from({ length: 150 }, (_, index) => saveRun(h.database, `later-${index}`, "succeeded"))
  expect(await h.getTasks()).toHaveLength(0)
  h.database.query("UPDATE runs SET status = 'interrupted' WHERE id = 'long-running'").run()
  const run: Run = {
    id: "long-running",
    botId: "bot-a",
    threadId: "thread-a",
    provider: "codex",
    trigger: "user",
    status: "interrupted",
    routineRunId: null,
    requestMessageId: null,
    replyMessageId: null,
    externalTurnId: null,
    errorClass: "app_restart",
    errorMessage: null,
    usage: null,
    queuedAt: 100,
    startedAt: null,
    finishedAt: 200,
  }

  h.runtime.kernel.publish({ type: "run.updated", run })
  // Large journal backlogs yield between delivery batches before this event reaches recovery.
  await delivered.promise
  const tasks = await h.getTasks()

  expect(tasks.map((task) => task.id)).toEqual(["run:long-running"])
})

test("a late routine failure remains discoverable outside the recent window", async () => {
  const h = await getFixture()
  h.database.exec(`INSERT INTO routines(id,bot_id,name,prompt,cron,timezone,created_at,updated_at)
    VALUES ('routine','bot-b','Resumo','Organize as notas','0 9 * * *','UTC',1,1);
    INSERT INTO routine_runs(id,routine_id,scheduled_for,status,trigger_source)
    VALUES ('old-routine-run','routine',0,'running','cron');`)
  const insert = h.database.query(`INSERT INTO routine_runs
    (id,routine_id,scheduled_for,status,trigger_source,finished_at) VALUES (?,'routine',?,'succeeded','cron',200)`)
  Array.from({ length: 150 }, (_, index) => insert.run(`later-${index}`, index + 1))
  expect(await h.getTasks()).toHaveLength(0)
  h.database.query("UPDATE routine_runs SET status = 'failed', finished_at = 1000 WHERE id = 'old-routine-run'").run()
  const persistence = createRuntimePersistence({ database: h.database })
  const routine = persistence.getRoutine("routine")
  const lastRun = persistence.getRoutineRun("old-routine-run")
  if (!routine || !lastRun) throw new Error("Expected stored routine failure")

  h.runtime.kernel.publish({ type: "routine.updated", routine, lastRun })
  const tasks = await h.getTasks()

  expect(tasks.map((task) => task.id)).toEqual(["routine:old-routine-run"])
})

const saveGroupRecovery = (database: Database) => {
  database.exec(`INSERT INTO bot_groups(id,name,color,avatar_shape,avatar_seed,created_at,updated_at)
    VALUES ('group','Projeto','blue','circle','group',1,1);
    UPDATE threads SET group_id = 'group' WHERE id = 'thread-a';`)
  saveRun(database, "root")
  saveRun(database, "child")
  saveRun(database, "member")
  database.exec(`UPDATE runs SET bot_id='bot-b', thread_id='thread-b' WHERE id='member';
    UPDATE threads SET group_thread_id='thread-a' WHERE id='thread-b';
    INSERT INTO group_turns VALUES ('root','group','["bot-a","bot-b"]');
    INSERT INTO group_run_links VALUES ('child','root',0),('member','root',1);`)
}

test("one logical group recovery retains every member effect and independent work", async () => {
  const h = await getFixture()
  saveGroupRecovery(h.database)
  saveRun(h.database, "independent")
  saveUncertainEffect(h.work, "root")
  h.work.beginEffect({
    turnId: "member",
    threadId: "thread-b",
    key: "member-key",
    description: "Member preview",
    effectId: "member-preview",
  })
  h.work.recover({ observe: () => ({ kind: "unobservable", reason: "Unknown" }) })

  const tasks = await h.getTasks()
  const group = tasks.find((task) => task.runId === "root")

  expect(tasks.filter((task) => task.notification.resolvedAt === null)).toHaveLength(2)
  expect(group?.effects.map((effect) => effect.acknowledgeKey)).toEqual(
    expect.arrayContaining(["preview-key", "member-key"]),
  )
  expect(tasks.some((task) => task.runId === "independent")).toBe(true)
  const partial = await h.request("/recovery/run%3Aroot/dismiss", { acknowledgeKeys: ["preview-key"] })
  expect(partial.status).toBe(409)
  expect(h.work.isBlocked({ key: "member-key" })).toBe(true)
  const complete = await h.request("/recovery/run%3Aroot/dismiss", { acknowledgeKeys: ["preview-key", "member-key"] })
  expect(complete.status).toBe(200)
  expect(h.work.isBlocked({ key: "member-key" })).toBe(false)
  expect((await h.getTasks()).find((task) => task.runId === "independent")?.notification.resolvedAt).toBeNull()
})

const saveLegacyRecovery = (database: Database, runId: string, person: string | null = null) => {
  const store = createNotificationStore({ db: database })
  const { notification } = store.insert({
    kind: "turn-failed",
    botId: "bot-a",
    threadId: "thread-a",
    requestId: `recovery:run:${runId}`,
    targetPersonId: person,
    title: "Interrupted",
    body: "Synthetic",
  })
  database.query("INSERT INTO recovery_tasks VALUES(?,?,?)").run(`run:${runId}`, notification.id, runId)
  return notification
}

test("reconciles persisted duplicates before dismissal without losing child effects", async () => {
  const h = await getFixture()
  saveGroupRecovery(h.database)
  saveUncertainEffect(h.work, "child")
  const root = saveLegacyRecovery(h.database, "root")
  const child = saveLegacyRecovery(h.database, "child")

  const tasks = await h.getTasks()
  const repeated = await h.getTasks()

  expect(tasks).toHaveLength(1)
  expect(repeated).toHaveLength(1)
  expect(tasks[0]?.notification.id).toBe(root.id)
  expect(tasks[0]?.effects.some((effect) => effect.acknowledgeKey === "preview-key")).toBe(true)
  expect(h.database.query("SELECT resolution FROM notifications WHERE id=?").get(child.id)).toEqual({
    resolution: "expired",
  })
  expect((await h.request(`/notifications/${root.id}/dismiss`, {})).status).toBe(409)
  expect((await h.request("/notifications/dismiss-all", {})).status).toBe(200)
  expect((await h.getTasks())[0]?.notification.resolvedAt).toBeNull()
  expect(h.database.query("SELECT COUNT(*) AS count FROM work_journal WHERE kind='acknowledged'").get()).toEqual({
    count: 0,
  })
})

test("keeps person-addressed recovery notices separate", async () => {
  const h = await getFixture()
  saveGroupRecovery(h.database)
  const root = saveLegacyRecovery(h.database, "root", "person-a")
  const child = saveLegacyRecovery(h.database, "child", "person-b")

  const tasks = await h.getTasks()

  expect(tasks.find((task) => task.notification.id === root.id)?.notification.targetPersonId).toBe("person-a")
  expect(tasks.find((task) => task.notification.id === child.id)?.notification.targetPersonId).toBe("person-b")
  expect(tasks.filter((task) => task.notification.resolvedAt === null)).toHaveLength(3)
})

test("group recovery includes actions of already completed members", async () => {
  const h = await getFixture()
  saveGroupRecovery(h.database)
  h.database.query("UPDATE runs SET status='succeeded' WHERE id='member'").run()
  h.database
    .query("UPDATE messages SET parts_json=? WHERE run_id='member'")
    .run(
      JSON.stringify([
        { type: "command", callId: "member-action", command: "printf synthetic", output: "synthetic", exitCode: 0 },
      ]),
    )

  const tasks = await h.getTasks()

  expect(tasks).toHaveLength(1)
  expect(tasks[0]?.effects.some((effect) => effect.description === "printf synthetic")).toBe(true)
})

test("the logical recovery identity survives coordination completion", async () => {
  const h = await getFixture()
  saveGroupRecovery(h.database)
  saveUncertainEffect(h.work, "child")
  const before = await h.getTasks()

  h.database.query("UPDATE runs SET status='succeeded' WHERE id='root'").run()
  const after = await h.getTasks()

  expect(after).toHaveLength(1)
  expect(after[0]?.id).toBe(before[0]?.id)
  expect(after[0]?.notification.id).toBe(before[0]?.notification.id)
  expect(after[0]?.notification.resolvedAt).toBeNull()
  expect(after[0]?.effects.some((effect) => effect.acknowledgeKey === "preview-key")).toBe(true)
})

test("logical recovery lookups use indexed execution links", async () => {
  const h = await getFixture()
  saveGroupRecovery(h.database)

  const plans = [
    h.database.query("EXPLAIN QUERY PLAN SELECT turn_id FROM group_run_links WHERE run_id=?").all("child"),
    h.database.query("EXPLAIN QUERY PLAN SELECT run_id FROM group_run_links WHERE turn_id=?").all("root"),
  ]

  expect(JSON.stringify(plans)).toContain("group_run_links_turn")
  expect(JSON.stringify(plans)).not.toContain("SCAN group_run_links")
})

test("reconciles live failure notices by execution identity while leaving independent notices alone", async () => {
  const h = await getFixture()
  saveGroupRecovery(h.database)
  saveUncertainEffect(h.work, "child")
  const store = createNotificationStore({ db: h.database })
  const child = store.insert({
    kind: "turn-failed",
    botId: "bot-a",
    threadId: "thread-a",
    requestId: "recovery:run:child",
    title: "Failure",
    body: "Synthetic",
  }).notification
  const independent = store.insert({
    kind: "turn-failed",
    botId: "bot-a",
    threadId: "thread-a",
    requestId: "another-request",
    title: "Failure",
    body: "Synthetic",
  }).notification
  const targeted = store.insert({
    kind: "turn-failed",
    botId: "bot-a",
    threadId: "thread-a",
    requestId: "recovery:run:root",
    targetPersonId: "person-a",
    title: "Failure",
    body: "Synthetic",
  }).notification

  const tasks = await h.getTasks()

  expect(tasks).toHaveLength(1)
  expect(store.get(child.id)?.resolution).toBe("expired")
  expect(store.get(independent.id)?.resolvedAt).toBeNull()
  expect(store.get(targeted.id)?.resolvedAt).toBeNull()
  expect(tasks[0]?.notification.targetPersonId).toBeNull()
  expect(tasks[0]?.notification.resolvedAt).toBeNull()
})

test("unchanged logical recovery snapshots do not rewrite member ownership", async () => {
  const h = await getFixture()
  saveGroupRecovery(h.database)
  await h.getTasks()
  await h.getTasks()
  h.database.exec(`CREATE TEMP TABLE recovery_ownership_writes (task_id TEXT NOT NULL);
    CREATE TEMP TRIGGER record_recovery_insert AFTER INSERT ON recovery_tasks
    BEGIN INSERT INTO recovery_ownership_writes VALUES (NEW.id); END;
    CREATE TEMP TRIGGER record_recovery_update AFTER UPDATE ON recovery_tasks
    BEGIN INSERT INTO recovery_ownership_writes VALUES (NEW.id); END;`)

  // Background maintenance can write other tables while recovery reads are in flight.
  h.database.query("UPDATE settings SET updated_at=updated_at+1 WHERE key='nativeNotifications'").run()
  await h.getTasks()
  await h.getTasks()

  expect(h.database.query("SELECT COUNT(*) AS count FROM recovery_ownership_writes").get()).toEqual({ count: 0 })
})

test.each(["channel", "all"])("archiving %s preserves one logical task with every uncertain effect", async (scope) => {
  const h = await getFixture()
  saveGroupRecovery(h.database)
  saveUncertainEffect(h.work, "root")
  h.work.beginEffect({
    turnId: "member",
    threadId: "thread-b",
    key: "member-key",
    description: "Member preview",
    effectId: "member-preview",
  })
  h.work.recover({ observe: () => ({ kind: "unobservable", reason: "Unknown" }) })
  await h.getTasks()

  h.database.query("UPDATE threads SET archived_at=300 WHERE id = 'thread-a' OR ? = 'all'").run(scope)
  const tasks = await h.getTasks()

  expect(tasks.filter((task) => task.notification.resolvedAt === null)).toHaveLength(1)
  expect(tasks[0]?.effects.map((effect) => effect.acknowledgeKey)).toEqual(
    expect.arrayContaining(["preview-key", "member-key"]),
  )
  const partial = await h.request("/recovery/run%3Aroot/dismiss", { acknowledgeKeys: ["preview-key"] })
  expect(partial.status).toBe(409)
  const complete = await h.request("/recovery/run%3Aroot/dismiss", { acknowledgeKeys: ["preview-key", "member-key"] })
  expect(complete.status).toBe(200)
})

test("recovery counts linked channel projections once while preserving distinct calls and journal acknowledgements", async () => {
  const h = await getFixture()
  saveGroupRecovery(h.database)
  const command: MessagePart = {
    type: "command",
    callId: "wait",
    command: "sleep 90",
    cwd: "/tmp",
    outputTail: "",
    exitCode: null,
  }
  h.database
    .query("UPDATE messages SET thread_id='thread-b', parts_json=? WHERE id='reply-child'")
    .run(JSON.stringify([command]))
  h.database
    .query(`INSERT INTO messages(id,thread_id,role,kind,status,run_id,parts_json,created_at,updated_at)
    VALUES ('mirror','thread-a','assistant','text','failed','child',?,100,200)`)
    .run(JSON.stringify([command]))
  h.database.query("INSERT INTO group_message_links VALUES ('reply-child','thread-b','mirror')").run()
  h.database
    .query("UPDATE messages SET parts_json=? WHERE id='reply-member'")
    .run(JSON.stringify([{ ...command, callId: "other-wait" }]))
  saveUncertainEffect(h.work, "child")

  const tasks = await h.getTasks()
  const effects = tasks[0]?.effects ?? []

  expect(tasks).toHaveLength(1)
  expect(effects.filter((effect) => effect.description === "sleep 90")).toHaveLength(2)
  expect(effects.filter((effect) => effect.acknowledgeKey === "preview-key")).toHaveLength(1)
  expect((await h.request("/recovery/run%3Aroot/dismiss", {})).status).toBe(409)
  expect((await h.request("/recovery/run%3Aroot/dismiss", { acknowledgeKeys: ["preview-key"] })).status).toBe(200)
  expect(h.database.query("SELECT id FROM messages WHERE id IN ('reply-child','mirror')").all()).toHaveLength(2)
})

test.each([false, true])(
  "recovery preserves unlinked calls and a mirror whose source is missing: %s",
  async (missingSource) => {
    const h = await getFixture()
    const command: MessagePart = {
      type: "command",
      callId: "wait",
      command: "sleep 90",
      cwd: "/tmp",
      outputTail: "",
      exitCode: null,
    }
    saveRun(h.database, "interrupted", "interrupted", [command])
    h.database
      .query(`INSERT INTO messages(id,thread_id,role,kind,status,run_id,parts_json,created_at,updated_at)
    VALUES ('second','thread-b','assistant','text','failed','interrupted',?,100,200)`)
      .run(JSON.stringify([command]))
    if (missingSource) {
      h.database.query("DELETE FROM messages WHERE id='reply-interrupted'").run()
      h.database.query("INSERT INTO group_message_links VALUES ('reply-interrupted','thread-a','second')").run()
    }

    const tasks = await h.getTasks()

    expect(tasks[0]?.effects).toHaveLength(missingSource ? 1 : 2)
  },
)

test("recovery preserves linked commands with the same call identifier in different executions", async () => {
  const h = await getFixture()
  saveGroupRecovery(h.database)
  const command: MessagePart = {
    type: "command",
    callId: "wait",
    command: "sleep 90",
    cwd: "/tmp",
    outputTail: "",
    exitCode: null,
  }
  h.database
    .query("UPDATE messages SET thread_id='thread-b', parts_json=? WHERE id='reply-child'")
    .run(JSON.stringify([command]))
  h.database.query("UPDATE messages SET parts_json=? WHERE id='reply-member'").run(JSON.stringify([command]))
  h.database.query("INSERT INTO group_message_links VALUES ('reply-child','thread-b','reply-member')").run()

  const tasks = await h.getTasks()

  expect(tasks).toHaveLength(1)
  expect(tasks[0]?.effects.filter((effect) => effect.description === "sleep 90")).toHaveLength(2)
  expect(h.database.query("SELECT id FROM messages WHERE id IN ('reply-child','reply-member')").all()).toHaveLength(2)
})
