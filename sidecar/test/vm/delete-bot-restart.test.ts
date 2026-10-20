import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, Kernel } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { profileProviders } from "../../src/kernel/provider-profiles"
import { init as initStore } from "../../src/store"
import { deleteBotRoutes } from "../../src/vm/delete-bot"
import { createVmRuntime } from "../../src/vm/runtime"
import { fakeVmProvider } from "./fake-provider"

const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  // Reverse only a fresh copy so connections close before their temporary directory.
  for (const cleanup of Array.from(cleanups).reverse()) await cleanup()
  cleanups.clear()
})

test("a fresh kernel resumes a committed record-purge checkpoint from the database", async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-purge-restart-"))
  cleanups.add(() => rm(root, { recursive: true, force: true }))
  const first = await startFixture(root)
  const created = await first.request("/bots", "POST", {
    name: "Synthetic restart",
    provider: profileProviders[0],
    machine: "local",
  })
  const { bot } = (await created.json()) as { bot: Bot }
  first.database
    .query(`WITH RECURSIVE entries(value) AS (
    SELECT 1 UNION ALL SELECT value + 1 FROM entries WHERE value < 2000
  ) INSERT INTO runs(id, thread_id, bot_id, provider, trigger, status, queued_at, finished_at)
    SELECT 'restart-run-' || value, ?, ?, ?, 'user', 'succeeded', 1, 2 FROM entries`)
    .run(bot.mainThreadId ?? "", bot.id, bot.provider)

  const response = await first.request(`/bots/${bot.id}`, "DELETE", { name: bot.name })
  await waitUntil(() => {
    const row = first.database.query("SELECT phase, cursor FROM bot_deletions WHERE bot_id = ?").get(bot.id) as {
      phase: string
      cursor: number
    } | null

    return row?.phase === "records:25" && row.cursor > 0
  })
  first.kernel.services.use("storage.botDeletion")?.dispose()
  const checkpoint = first.database.query("SELECT phase, cursor FROM bot_deletions WHERE bot_id = ?").get(bot.id)
  await first.stop()
  const second = await startFixture(root)
  await waitUntil(() => !second.database.query("SELECT 1 FROM bot_deletions WHERE bot_id = ?").get(bot.id))

  expect(response.status).toBe(202)
  expect(checkpoint).toMatchObject({ phase: "records:25" })
  expect(second.database.query("SELECT id FROM bots WHERE id = ?").get(bot.id)).toBeNull()
  expect(second.database.query("SELECT id FROM runs WHERE bot_id = ?").all(bot.id)).toEqual([])
  expect(second.database.query("PRAGMA foreign_key_check").all()).toEqual([])
}, 30_000)

const startFixture = async (root: string) => {
  const runtime = createKernel({ appData: join(root, "data") })
  await initStore(runtime.kernel)
  const callHost = (async (method: string) => {
    if (method === "keychain.delete") return { success: true, value: {} }
    return { success: false, errorCode: "HOST_UNAVAILABLE", error: "Synthetic host method unavailable" }
  }) as Kernel["callHost"]
  const kernel: Kernel = { ...runtime.kernel, callHost }
  const fake = fakeVmProvider()
  const vm = createVmRuntime({
    kernel,
    provider: fake.provider,
    hostHome: root,
    capability: { available: true, reason: null, provider: "fake" },
    connectionKeys: { rotate: async () => Buffer.alloc(32), remove: async () => {} },
  })
  kernel.services.provide("vm.runtime", vm.service)
  kernel.registerRoutes({ name: "restart-test", routes: deleteBotRoutes(kernel, vm.service) })
  const stop = async () => {
    await vm.dispose()
    await runtime.stop()
  }
  cleanups.add(stop)
  const request = (path: string, method: string, body: unknown) =>
    fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1${path}`, {
      method,
      headers: { Authorization: "Bearer dev-ui-token", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

  return { kernel, database: kernel.db as Database, request, stop }
}

const waitUntil = async (condition: () => boolean) => {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (condition()) return
    await Bun.sleep(1)
  }
  throw new Error("Deletion did not reach the expected checkpoint")
}
