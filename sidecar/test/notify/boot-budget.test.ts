import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRateLimiter } from "../../src/cli/auth/rateLimit"
import { openAuthStore } from "../../src/cli/auth/store"
import { createHeadlessHost } from "../../src/cli/host/headlessHost"
import { createSecretStore } from "../../src/cli/host/secretStore"
import { createWebGate } from "../../src/cli/web/gate"
import { createKernel } from "../../src/kernel"
import { openDatabase } from "../../src/kernel/db"
import { init as initNotify } from "../../src/notify"
import { init as initStore } from "../../src/store"

// Only this registry owns these disposable fixtures and their blocked background work.
const cleanups = new Set<() => void | Promise<void>>()

afterEach(async () => {
  await Array.from(cleanups).reduceRight(async (previous, cleanup) => {
    await previous
    await cleanup()
  }, Promise.resolve())
  cleanups.clear()
})

test("health and the UI serve within two seconds while restart recovery is still running", async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-boot-budget-"))
  cleanups.add(() => rm(root, { recursive: true, force: true }))
  const database = openDatabase({ filename: join(root, "touri.db") })
  const fixture = (await Bun.file(new URL("../fixtures/ui-seed.json", import.meta.url)).json()) as {
    bots: Array<{ provider: string }>
  }
  seedRecovery(database, fixture.bots[0]?.provider ?? "fixture")
  database.close()
  const auth = await openAuthStore({ filename: join(root, "auth.db") })
  cleanups.add(() => auth.close())
  const secrets = createSecretStore({ dir: root, env: { TOURI_SECRETS_KEY: "fixture-key" } })
  const port = await getFreePort()
  const reached = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const started = performance.now()
  const runtime = createKernel({
    appData: root,
    web: {
      hostname: "127.0.0.1",
      port,
      host: createHeadlessHost({ secrets }),
      intercept: createWebGate({
        store: auth,
        secrets,
        limiter: createRateLimiter({ maxFailures: 8, windowMs: 60_000 }),
        ui: {
          source: "embedded",
          get: () => ({ file: new Blob(["<html>fixture workspace</html>"]), type: "text/html", immutable: false }),
        },
      }),
    },
  })
  cleanups.add(() => runtime.stop())
  cleanups.add(() => release.resolve())
  await initStore(runtime.kernel)

  await initNotify(runtime.kernel, undefined, async () => {
    reached.resolve()
    await release.promise
  })
  const base = `http://127.0.0.1:${port}`
  const health = await fetch(`${base}/healthz`)
  const healthMs = performance.now() - started
  const { code } = await auth.createPairingCode()
  const paired = await fetch(`${base}/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, name: "Fixture", client: true }),
  })
  const { token } = (await paired.json()) as { token: string }
  const ui = await fetch(base, { headers: { Authorization: `Bearer ${token}` } })
  const uiMs = performance.now() - started

  expect(health.status).toBe(200)
  expect(await health.json()).toEqual({ ok: true })
  expect(await ui.text()).toContain("fixture workspace")
  expect(healthMs).toBeLessThan(2000)
  expect(uiMs).toBeLessThan(2000)
  await reached.promise
  expect(
    (runtime.kernel.db as Database).query("SELECT 1 FROM settings WHERE key='notification.history-reconcile'").get(),
  ).not.toBeNull()
  console.info(JSON.stringify({ probe: "restart", healthMs, uiMs, interruptedRuns: 100, historyBytes: 26_214_400 }))
  release.resolve()
  await runtime.kernel.services.use("notify.recovery")?.ready
  expect((runtime.kernel.db as Database).query("SELECT COUNT(*) AS n FROM recovery_tasks").get()).toEqual({ n: 100 })
}, 30_000)

const seedRecovery = (database: Database, provider: string): void => {
  database
    .query("INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES('bot','Fixture',?,'/tmp',1,1)")
    .run(provider)
  database.exec(`
    INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES('thread','bot','Fixture',1,1);
    WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100)
    INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,error_class,queued_at,finished_at)
    SELECT 'run-'||x,'thread','bot','fixture','user','interrupted','app_restart',1,2 FROM n;
    INSERT INTO messages(id,thread_id,role,kind,status,run_id,text,parts_json,created_at,updated_at)
    SELECT 'message-'||id,'thread','assistant','text','failed',id,'fixture',
      json_array(json_object('type','text','text',replace(hex(zeroblob(131072)),'0','a'))),1,2 FROM runs;
    WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<120)
    INSERT INTO notifications(kind,level,bot_id,thread_id,title,body,created_at)
    SELECT 'turn-failed','error','bot','thread','Fixture','Fixture',1 FROM n;
    UPDATE schema_meta SET value=(SELECT MAX(id) FROM transcript_entries) WHERE key='transcript_event_checkpoint';`)
}

const getFreePort = async (): Promise<number> => {
  for (const port of Array.from({ length: 100 }, (_, index) => 18800 + index)) {
    const server = createServer()
    const available = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false))
      server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)))
    })
    if (available) return port
  }
  throw new Error("FIXTURE_PORT_UNAVAILABLE")
}
