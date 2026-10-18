import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { MessagePart, RecoveryTask, Run } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { init as initNotify } from "../../src/notify"
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

const getFixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-recovery-center-"))
  const runtime = createKernel({ appData: root })
  cleanups.add(() => {
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  await initStore(runtime.kernel)
  await initNotify(runtime.kernel)
  const database = runtime.kernel.db as Database
  database.exec(`INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES
    ('bot-a','Equipe A','codex','/tmp',1,1), ('bot-b','Equipe B','codex','/tmp',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES
    ('thread-a','bot-a','Notas',1,1), ('thread-b','bot-b','Revisão',1,1);`)
  const { token } = JSON.parse(readFileSync(join(root, "run", "handshake.json"), "utf8")) as { token: string }
  const request = (path: string, body?: object) =>
    fetch(`http://127.0.0.1:${runtime.handshake.port}${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, "X-Touri-Client": "test", "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  const getTasks = async (): Promise<RecoveryTask[]> => (await (await request("/recovery")).json()).tasks
  return { runtime, database, request, getTasks, work: createWorkState({ database, now: () => 100 }) }
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
  expect(repeated.map((task) => task.notification.id)).toEqual(tasks.map((task) => task.notification.id))
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

  expect([missingKey.status, wrongKey.status, bell.status, clearAll.status]).toEqual([409, 409, 409, 409])
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
