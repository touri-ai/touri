import type { Database } from "bun:sqlite"
import { afterEach, expect, mock, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { MessagePart, RecoveryTask, Run } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { createPerformanceStageTracker } from "../../src/kernel/performance"
import { init as initNotify } from "../../src/notify"
import { createNotifier } from "../../src/notify/notifier"
import { createRecoverySync } from "../../src/notify/recovery"
import { createSseHub } from "../../src/notify/sse"
import { createNotificationStore } from "../../src/notify/store"
import { createRuntimePersistence } from "../../src/runtime/persistence"
import { createWorkState } from "../../src/runtime/work-state"
import { init as initStore } from "../../src/store"

// Resource ownership stays at the test boundary; each fixture has its own database.
const cleanups = new Set<() => void>()
afterEach(() => {
  cleanups.forEach((close) => {
    close()
  })
  cleanups.clear()
})

const getFixture = async (options: { beforeNotify?: (database: Database) => void; native?: boolean } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "touri-recovery-center-"))
  const runtime = createKernel({ appData: root })
  const database = runtime.kernel.db as Database
  database.query("INSERT INTO settings (key, value_json, updated_at) VALUES ('nativeNotifications', 'false', 0)").run()
  cleanups.add(() => {
    runtime.stop()
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
  await initNotify({ ...runtime.kernel, callHost: hostCalls }, stages.run)

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

  expect(h.stageCalls()).toContain("notification_journal_recovery_scan")
  expect(h.stageCalls()).toContain("notification_recovery_reconcile")
})

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

  const tasks = sync()
  const repeated = sync()
  h.database.query("UPDATE messages SET parts_json = '[null]' WHERE run_id = 'history-299'").run()
  const afterUnrelatedWrite = sync()
  saveRun(h.database, "new-interruption")
  const updated = sync()

  expect(tasks.map((task) => task.id)).toEqual([pending.id])
  expect(repeated).toBe(tasks)
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
