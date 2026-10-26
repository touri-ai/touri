import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, RouteModule } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { profileProviders } from "../../src/kernel/provider-profiles"
import { init as initNotify } from "../../src/notify"
import { init as initStore } from "../../src/store"
import { stopBotHomeWriter } from "../../src/store/bot-home"

const cleanups = new Set<() => void | Promise<void>>()
afterEach(async () => {
  await Array.from(cleanups).reduceRight(async (previous, cleanup) => {
    await previous
    await cleanup()
  }, Promise.resolve())
  cleanups.clear()
})

const makeFixture = async ({ withNotify = false } = {}) => {
  const root = await mkdtemp(join(tmpdir(), "touri-send-events-"))
  cleanups.add(() => rm(root, { recursive: true, force: true }))
  const runtime = createKernel({ appData: root })
  cleanups.add(runtime.stop)
  const modules = new Set<RouteModule>()
  const kernel = Object.assign({}, runtime.kernel, { registerRoutes: (module: RouteModule) => modules.add(module) })
  await initStore(kernel)
  cleanups.add(() => stopBotHomeWriter(kernel))
  if (withNotify) await initNotify(kernel)
  const getRoute = (method: string, path: string) => {
    const route = Array.from(modules)
      .flatMap((module) => module.routes)
      .find((route) => route.method === method && route.path === path)
    if (!route) throw new Error("Missing store route")
    return route
  }
  const signal = new AbortController().signal
  const created = await getRoute("POST", "/bots").handler({
    params: {},
    query: {},
    body: { name: "Fixture", provider: profileProviders[0] },
    signal,
  })
  if (!("json" in created)) throw new Error("Expected bot response")
  const { bot } = created.json as { bot: Bot }
  return { kernel, bot, getRoute, signal }
}

const admitEvent = (kernel: ReturnType<typeof createKernel>["kernel"]) => {
  const blocker = new Database(kernel.paths.db)
  cleanups.add(() => blocker.close())
  blocker.exec("BEGIN IMMEDIATE")
  kernel.publish({ type: "import.progress", importId: "fixture", phase: "saving", done: 1, total: 1 })
  blocker.exec("COMMIT")
}

test("a message send waits for admitted events before opening its transaction", async () => {
  const { kernel, bot, getRoute, signal } = await makeFixture()
  admitEvent(kernel)

  const response = await getRoute("POST", "/threads/:id/messages").handler({
    params: { id: bot.mainThreadId ?? "" },
    query: {},
    body: { text: "Synthetic message" },
    signal,
  })

  expect(response.status).toBe(503)
  expect("json" in response && response.json).toMatchObject({
    errorCode: "RUNTIME_UNAVAILABLE",
    message: { text: "Synthetic message" },
  })
  expect((kernel.db as Database).query("SELECT count(*) AS count FROM messages WHERE role = 'user'").get()).toEqual({
    count: 1,
  })
})

test("a notification reply waits for admitted events before opening its transaction", async () => {
  const { kernel, bot, getRoute, signal } = await makeFixture({ withNotify: true })
  admitEvent(kernel)

  const response = await getRoute("POST", "/bots/:id/messages").handler({
    params: { id: bot.id },
    query: {},
    body: { text: "Synthetic notification reply", sendId: "notification-reply" },
    signal,
  })

  expect(response.status).toBe(503)
  expect("json" in response && response.json).toMatchObject({
    errorCode: "RUNTIME_UNAVAILABLE",
    message: { text: "Synthetic notification reply" },
  })
})

test("concurrent notification replies preserve chronology and replay their original parent", async () => {
  const { kernel, bot, getRoute, signal } = await makeFixture({ withNotify: true })
  const send = (sendId: string) =>
    getRoute("POST", "/bots/:id/messages").handler({
      params: { id: bot.id },
      query: {},
      body: { text: `Synthetic reply ${sendId}`, sendId },
      signal,
    })

  const responses = await Promise.all([send("first"), send("second")])
  const replay = await send("first")

  expect(responses.map((response) => response.status)).toEqual([503, 503])
  expect(replay.status).toBe(503)
  const database = kernel.db as Database
  expect(database.query("SELECT id, parent_id FROM messages WHERE role = 'user' ORDER BY rowid").all()).toEqual([
    { id: "send:first", parent_id: null },
    { id: "send:second", parent_id: "send:first" },
  ])
  expect(kernel.services.use("store.api")?.getThread({ threadId: bot.mainThreadId ?? "" })?.activeLeafId).toBe(
    "send:second",
  )
})
