import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ApiRoutes, Bot, Kernel, RouteModule, Thread } from "@touri/contracts"
import { init as initGroups } from "../../src/groups"
import { createKernel } from "../../src/kernel"
import { writeDatabaseAsync } from "../../src/kernel/database-write"
import { bindDeviceSession } from "../../src/kernel/device-session"
import { createRuntimeEngine } from "../../src/runtime/engine"
import { init as initStore } from "../../src/store"
import {
  getRoutineThreadCandidateIds,
  getRoutineThreadTitleQuery,
  getRoutineThreadTitles,
} from "../../src/store/routine-thread-title"

// Own only disposable fixtures and route registrations, never application state.
const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  await Array.from(cleanups).reduceRight(async (previous, cleanup) => {
    await previous
    await cleanup()
  }, Promise.resolve())
  cleanups.clear()
})

const getFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-routine-title-"))
  const runtime = createKernel({ appData: root })
  cleanups.add(async () => {
    await runtime.stop()
    await rm(root, { recursive: true, force: true })
  })
  const routes = new Map<string, RouteModule["routes"][number]>()
  const kernel: Kernel = {
    ...runtime.kernel,
    registerRoutes: (module) => {
      module.routes.forEach((route) => {
        routes.set(`${route.method} ${route.path}`, route)
      })
      runtime.kernel.registerRoutes(module)
    },
  }
  await initStore(kernel)
  await initGroups(kernel)
  const signal = new AbortController().signal
  bindDeviceSession(signal, {
    deviceId: "qa-device",
    active: () => true,
    person: { id: "nina", name: "Nina QA", email: null, avatarSeed: "qa", role: "member" },
  })
  kernel.services.provide("work.personChannelIds", () => ["planning"])
  kernel.services.provide("work.canAccessGroup", ({ groupId }) => groupId === "planning")
  kernel.services.provide("work.canAccessThread", () => false)
  const invoke = async (key: string, params = {}, query = {}, body: unknown = {}) => {
    const route = routes.get(key)
    if (!route) throw new Error("Missing fixture route")

    return route.handler({ params, query, body, signal })
  }
  const settings = kernel.services.use("store.settings")?.()
  if (!settings) throw new Error("Missing fixture settings")
  const botResponse = await invoke("POST /bots", {}, {}, { name: "qa", provider: settings.defaultProvider })
  expect(botResponse.status).toBe(201)
  if (!("json" in botResponse)) throw new Error("Missing fixture bot")
  const { bot } = botResponse.json as { bot: Bot }
  const db = kernel.db as Database
  const store = kernel.services.use("store.api")
  if (!store) throw new Error("Missing fixture store")
  db.query(`INSERT INTO bot_groups(id,name,color,avatar_shape,avatar_seed,created_at,updated_at)
    VALUES(?,?,'#dc2626','classic-none','qa',1,1)`).run("planning", "Planejamento")
  db.query(`INSERT INTO bot_groups(id,name,color,avatar_shape,avatar_seed,created_at,updated_at)
    VALUES(?,?,'#dc2626','classic-none','qa',1,1)`).run("private", "Privado")
  const member = db.query("INSERT INTO group_members(group_id,bot_id,position) VALUES(?,?,0)")
  const groupIds = ["planning", "private"]
  groupIds.forEach((groupId) => {
    member.run(groupId, bot.id)
  })
  const title = "Checagem de QA no canal · 10/23/26, 2:00 AM"
  const makeThread = (groupId?: string, name = title) => {
    const result = store.createThread({ botId: bot.id, kind: "chat", title: name, ...(groupId ? { groupId } : {}) })
    if (!result.success) throw new Error("Missing fixture conversation")
    db.query(`INSERT INTO routines(id,bot_id,name,prompt,cron,timezone,group_id,created_at,updated_at)
      VALUES(?,?,'Checagem de QA no canal','private routine prompt','0 2 * * *','America/Sao_Paulo',?,1,1)`).run(
      `routine-${result.thread.id}`,
      bot.id,
      groupId ?? null,
    )
    db.query(`INSERT INTO routine_runs(id,routine_id,scheduled_for,status,thread_id,trigger_source)
      VALUES(?,?,?,'succeeded',?,'cron')`).run(
      `run-${result.thread.id}`,
      `routine-${result.thread.id}`,
      Date.UTC(2026, 9, 23, 5),
      result.thread.id,
    )
    db.query("INSERT INTO messages_fts(text,thread_id,message_id) VALUES('syntheticroutine',?,?)").run(
      result.thread.id,
      `message-${result.thread.id}`,
    )

    return result.thread
  }

  return { db, invoke, makeThread, title, kernel }
}

test("ordinary conversation lists never start a routine metadata read", async () => {
  const threads = Array.from({ length: 257 }, (_, index) => ({ id: `chat-${index}`, title: "Planejamento" }))
  const reader = {
    getRows: async <Row>(): Promise<Row[]> => {
      throw new Error("Ordinary conversations must not start a reader")
    },
  }

  const titles = await getRoutineThreadTitles(
    reader,
    getRoutineThreadCandidateIds(threads),
    new AbortController().signal,
  )

  expect(titles.size).toBe(0)
})

test("channel members get only verified date metadata for authorized saved routine titles", async () => {
  const { db, invoke, makeThread, title } = await getFixture()
  const visible = makeThread("planning")
  const manual = makeThread("planning", "Minha revisão · 10/23/26, 2:00 AM")
  makeThread("private")
  makeThread()

  const search = await invoke("GET /search", {}, { q: "syntheticroutine" })
  const channel = await invoke("GET /groups/:id/threads", { id: "planning" })
  const denied = await invoke("GET /groups/:id/threads", { id: "private" })
  if (!("json" in search) || !("json" in channel)) throw new Error("Missing fixture response")
  const matches = search.json as ApiRoutes["GET /search"]["res"]
  const threads = (channel.json as { threads: Thread[] }).threads
  const identity = {
    sourceTitle: title,
    name: "Checagem de QA no canal",
    scheduledFor: Date.UTC(2026, 9, 23, 5),
    timezone: "America/Sao_Paulo",
  }

  expect(new Set(matches.hits.map((hit) => hit.threadId))).toEqual(new Set([visible.id, manual.id]))
  expect(matches.hits.find((hit) => hit.threadId === visible.id)?.thread).toMatchObject({
    title,
    routineTitle: identity,
  })
  expect(threads.find((thread) => thread.id === visible.id)?.routineTitle).toEqual(identity)
  expect(threads.find((thread) => thread.id === manual.id)?.routineTitle).toBeUndefined()
  expect(denied.status).toBe(404)
  expect(JSON.stringify(search.json)).not.toContain("private routine prompt")
  expect(db.query("SELECT title FROM threads WHERE id = ?").get(visible.id)).toEqual({ title })
})

test("metadata uses indexed initial execution candidates and ignores changed timezone and deleted routines", async () => {
  const { db, invoke, makeThread } = await getFixture()
  const visible = makeThread("planning")
  const writer = new Database(db.filename)
  cleanups.add(async () => writer.close())
  const query = getRoutineThreadTitleQuery([visible.id])
  const plan = db.query(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.bindings)

  const initial = await invoke("GET /groups/:id/threads", { id: "planning" })
  await writeDatabaseAsync(writer, () =>
    writer.query("UPDATE routines SET timezone = 'UTC' WHERE id = ?").run(`routine-${visible.id}`),
  )
  const changed = await invoke("GET /groups/:id/threads", { id: "planning" })
  await writeDatabaseAsync(writer, () => writer.query("DELETE FROM routines WHERE id = ?").run(`routine-${visible.id}`))
  const legacy = await invoke("GET /groups/:id/threads", { id: "planning" })

  expect(JSON.stringify(plan)).toContain("routine_runs_thread")
  expect(JSON.stringify(plan)).not.toContain("USE TEMP B-TREE")
  expect(JSON.stringify(plan)).not.toMatch(/SCAN (?:rr|routine_runs|r|t)\b/)
  expect(JSON.stringify(initial)).toContain("routineTitle")
  expect(JSON.stringify(changed)).not.toContain("routineTitle")
  expect(JSON.stringify(legacy)).not.toContain("routineTitle")
})

test.each([undefined, "planning"])("new routine threads publish presentation immediately (%s)", async (groupId) => {
  const { db, kernel, makeThread } = await getFixture()
  const previous = makeThread(groupId)
  db.query("UPDATE bots SET automatic_conversation_mode = 'task' WHERE id = ?").run(previous.botId)
  const engine = createRuntimeEngine({ kernel, maxConcurrentRuns: 0 })
  cleanups.add(() => engine.shutdown())
  await engine.ready
  const published = Promise.withResolvers<Thread>()
  const unsubscribe = kernel.subscribe(({ event }) => {
    if (event.type === "thread.updated" && event.thread.routineTitle) published.resolve(event.thread)
  })
  cleanups.add(async () => {
    unsubscribe()
  })
  const scheduledFor = Date.UTC(2026, 9, 24, 5)

  const result = engine.runRoutine({ routineId: `routine-${previous.id}`, triggerSource: "manual", scheduledFor })
  if (!result.success && result.error !== "Group runtime unavailable") throw new Error(result.error)

  expect(await published.promise).toMatchObject({
    title: "Checagem de QA no canal · 10/24/26, 2:00 AM",
    routineTitle: {
      sourceTitle: "Checagem de QA no canal · 10/24/26, 2:00 AM",
      name: "Checagem de QA no canal",
      scheduledFor,
      timezone: "America/Sao_Paulo",
    },
  })
})
