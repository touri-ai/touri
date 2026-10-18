import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, Routine } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { init as initNotify } from "../../src/notify"
import { init as initRuntime } from "../../src/runtime"
import { createRuntimeEngine } from "../../src/runtime/engine"
import { init as initStore } from "../../src/store"

const cleanups = new Set<() => Promise<void>>()
const startedAt = Date.parse("2026-10-19T08:00:00Z")

afterEach(async () => {
  for (const close of cleanups) await close()
  cleanups.clear()
})

test.each([0, 1, 30_000, 120_000])("zero catch-up runs a live slot %i ms late exactly once", async (lateBy) => {
  const fixture = await makeFixture()
  const routine = makeRoutine(fixture)
  const due = routine.nextRunAt ?? 0

  await fixture.engine.tick(due + lateBy)
  await fixture.engine.tick(due + lateBy)

  expect(fixture.engine.listRoutineRuns(routine.id)).toEqual([
    expect.objectContaining({ scheduledFor: due, status: "running", triggerSource: "cron" }),
  ])
  expect(fixture.engine.listRuns(fixture.bot.mainThreadId ?? "")).toEqual([
    expect.objectContaining({ status: "queued", trigger: "routine" }),
  ])
  expect(fixture.engine.listRoutines()[0]?.nextRunAt).toBe(due + 15 * 60_000)
})

test.each([0, 10])("a live slot beyond catch-up plus grace reports lateness (%i minutes)", async (catchUpMinutes) => {
  const fixture = await makeFixture()
  const routine = makeRoutine(fixture, catchUpMinutes)
  const due = routine.nextRunAt ?? 0

  await fixture.engine.tick(due + (catchUpMinutes + 2) * 60_000 + 1)

  expect(fixture.engine.listRoutineRuns(routine.id)).toEqual([
    expect.objectContaining({
      scheduledFor: due,
      status: "skipped",
      summary: "Rotina “Notas QA” não executada: o atraso ultrapassou a janela de recuperação.",
    }),
  ])
  expect(fixture.engine.listRuns(fixture.bot.mainThreadId ?? "")).toEqual([])
  expect(await fixture.getNotifications()).toEqual([
    expect.objectContaining({ body: "Rotina “Notas QA” não executada: o atraso ultrapassou a janela de recuperação." }),
  ])
})

test("catch-up includes the grace in addition to the configured window", async () => {
  const fixture = await makeFixture()
  const routine = makeRoutine(fixture, 10)
  const due = routine.nextRunAt ?? 0

  await fixture.engine.tick(due + 12 * 60_000)

  expect(fixture.engine.listRoutineRuns(routine.id)).toEqual([
    expect.objectContaining({ scheduledFor: due, status: "running", triggerSource: "catch-up" }),
  ])
})

test("zero catch-up does not replay even a recent downtime slot", async () => {
  const fixture = await makeFixture()
  const routine = makeRoutine(fixture)
  const due = startedAt - 30_000
  fixture.engine.updateRoutine({ routineId: routine.id, patch: { nextRunAt: due }, fromTool: false })

  await fixture.engine.tick(startedAt)

  expect(fixture.engine.listRoutineRuns(routine.id)).toEqual([
    expect.objectContaining({
      scheduledFor: due,
      status: "skipped",
      summary: "Rotina “Notas QA” não executada: o touri não estava em execução no horário agendado.",
    }),
  ])
})

test("configured catch-up labels a recent downtime slot as catch-up", async () => {
  const fixture = await makeFixture()
  const routine = makeRoutine(fixture, 10)
  const due = startedAt - 30_000
  fixture.engine.updateRoutine({ routineId: routine.id, patch: { nextRunAt: due }, fromTool: false })

  await fixture.engine.tick(startedAt)

  expect(fixture.engine.listRoutineRuns(routine.id)).toEqual([
    expect.objectContaining({ scheduledFor: due, status: "running", triggerSource: "catch-up" }),
  ])
})

test.each([false, true])(
  "zero catch-up reports downtime for persisted and missing next slots (%s)",
  async (missingNextSlot) => {
    const fixture = await makeFixture()
    const routine = makeRoutine(fixture)
    const due = startedAt - 15 * 60_000
    fixture.engine.updateRoutine({
      routineId: routine.id,
      patch: { nextRunAt: missingNextSlot ? null : due },
      fromTool: false,
    })

    await fixture.engine.tick(startedAt - 1)

    expect(fixture.engine.listRoutineRuns(routine.id)).toEqual([
      expect.objectContaining({
        scheduledFor: due,
        status: "skipped",
        summary: "Rotina “Notas QA” não executada: o touri não estava em execução no horário agendado.",
      }),
    ])
    expect(await fixture.getNotifications()).toEqual([
      expect.objectContaining({
        body: "Rotina “Notas QA” não executada: o touri não estava em execução no horário agendado.",
      }),
    ])
  },
)

test.each([false, true])("HTTP PATCH only changes catchUpMinutes and preserves enabled=%s", async (enabled) => {
  const fixture = await makeFixture()
  await fixture.engine.shutdown()
  await initRuntime(fixture.runtime.kernel)
  const created = await fixture.request("POST", "/routines", getRoutineInput(fixture.bot.id, 30, enabled))
  expect(created.status).toBe(201)
  const { routine } = (await created.json()) as { routine: Routine }

  const response = await fixture.request("PATCH", `/routines/${routine.id}`, { catchUpMinutes: 0 })
  const result = (await response.json()) as { routine: Routine }
  const listed = (await (await fixture.request("GET", "/routines")).json()) as { routines: Routine[] }

  expect(response.status).toBe(200)
  expect(result.routine).toEqual(Object.assign({}, routine, { catchUpMinutes: 0, updatedAt: expect.any(Number) }))
  expect(listed.routines).toEqual([result.routine])
})

const makeFixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-routine-catchup-"))
  const runtime = createKernel({ appData: root })
  await initStore(runtime.kernel)
  await initNotify(runtime.kernel)
  const engine = createRuntimeEngine({ kernel: runtime.kernel, maxConcurrentRuns: 0, getNow: () => startedAt })
  await engine.ready
  const request = (method: string, path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1${path}`, {
      method,
      headers: {
        Authorization: "Bearer dev-ui-token",
        "Content-Type": "application/json",
        "x-touri-client": "routine-test",
      },
      body: body === undefined ? null : JSON.stringify(body),
    })

  cleanups.add(async () => {
    await runtime.kernel.services.use("runtime.shutdown")?.()
    await engine.shutdown()
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  const response = await request("POST", "/bots", { name: "Notas QA", machine: "local" })
  expect(response.status).toBe(201)
  const { bot } = (await response.json()) as { bot: Bot }

  return {
    runtime,
    engine,
    bot,
    request,
    getNotifications: async () => {
      const response = await request("GET", "/notifications")
      const result = (await response.json()) as { notifications: Array<{ body: string }> }
      return result.notifications
    },
  }
}

const makeRoutine = (fixture: Awaited<ReturnType<typeof makeFixture>>, catchUpMinutes = 0) => {
  const result = fixture.engine.createRoutine({
    input: getRoutineInput(fixture.bot.id, catchUpMinutes),
    forceDisabled: false,
  })
  if (!result.success) throw new Error(result.error)

  const scheduled = fixture.engine.updateRoutine({
    routineId: result.routine.id,
    patch: { nextRunAt: startedAt + 15 * 60_000 },
    fromTool: false,
  })
  if (!scheduled.success) throw new Error(scheduled.error)

  return scheduled.routine
}

const getRoutineInput = (botId: string, catchUpMinutes: number, enabled = true) => ({
  botId,
  name: "Notas QA",
  prompt: "Organize as notas de exemplo",
  cron: "*/15 * * * *",
  timezone: "UTC",
  enabled,
  continuity: "main-thread" as const,
  resultsThreadId: null,
  groupId: null,
  timeoutMinutes: 20,
  overlap: "queue" as const,
  catchUpMinutes,
})
