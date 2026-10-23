import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createRateLimiter } from "../../src/cli/auth/rateLimit"
import { openAuthStore } from "../../src/cli/auth/store"
import { createHeadlessHost } from "../../src/cli/host/headlessHost"
import { createSecretStore } from "../../src/cli/host/secretStore"
import { createWebGate } from "../../src/cli/web/gate"
import { createKernel } from "../../src/kernel"
import { openDatabase } from "../../src/kernel/db"
import { init as initNotify } from "../../src/notify"
import { init as initStore } from "../../src/store"
import { getMaximum, getPercentile } from "../fakes/latency"

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

test("the complete server stays responsive during migration and serves the workspace within two seconds", async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-command-boot-"))
  cleanups.add(() => rm(root, { recursive: true, force: true }))
  const db = openDatabase({ filename: join(root, "touri.db") })
  const fixture = (await Bun.file(new URL("../fixtures/ui-seed.json", import.meta.url)).json()) as {
    bots: Array<{ provider: string }>
  }
  seedRecovery(db, fixture.bots[0]?.provider ?? "fixture")
  db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<256)
    INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at)
    SELECT 'fixture-'||x,'Fixture',provider,'fixture',1,1 FROM n CROSS JOIN bots WHERE bots.id='bot';
    UPDATE schema_meta SET value='48' WHERE key='schema_version';
    BEGIN IMMEDIATE;`)
  const auth = await openAuthStore({ filename: join(root, "auth.db") })
  const { code } = await auth.createPairingCode()
  await auth.close()
  await Bun.write(join(root, "index.html"), "<html>fixture command workspace</html>")
  const port = await getFreePort()
  const probePath = join(root, "loop-probe.json")
  const preload = join(root, "loop-probe.ts")
  await Bun.write(
    preload,
    `
    const samples: number[] = []
    let expected = performance.now() + 5
    const timer = setInterval(() => {
      const now = performance.now()
      samples.push(Math.max(0, now - expected))
      expected = now + 5
    }, 5)
    setTimeout(async () => {
      clearInterval(timer)
      await Bun.write(${JSON.stringify(probePath)}, JSON.stringify(samples))
    }, 2500)
  `,
  )
  const started = performance.now()
  const child = Bun.spawn(
    [
      process.execPath,
      "--preload",
      preload,
      "sidecar/src/cli/main.ts",
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--data-dir",
      root,
      "--ui-dir",
      root,
    ],
    {
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, TOURI_APP_DATA: root, TOURI_SECRETS_KEY: "fixture-key" },
    },
  )
  cleanups.add(async () => {
    child.kill("SIGTERM")
    await child.exited
  })
  cleanups.add(() => db.close())
  const base = `http://127.0.0.1:${port}`

  const healthMs = await getHealthTime(base, started)
  expect(healthMs).toBeLessThan(500)
  const pulses = await Promise.all(
    Array.from({ length: 20 }, async () => {
      const before = performance.now()
      const response = await fetch(`${base}/healthz`)
      expect(response.status).toBe(200)
      return performance.now() - before
    }),
  )
  expect(Math.max(...pulses)).toBeLessThan(200)
  db.exec("COMMIT")
  const paired = await fetch(`${base}/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, name: "Fixture", client: true }),
  })
  const { token } = (await paired.json()) as { token: string }
  const ui = await fetch(base, { headers: { Authorization: `Bearer ${token}` } })
  const headers = { Authorization: `Bearer ${token}`, "X-Touri-Client": "boot-fixture" }
  const bots = await getReadyResponse(`${base}/api/v1/bots`, headers)
  const groups = await fetch(`${base}/api/v1/groups`, { headers })
  const activity = await fetch(`${base}/api/v1/workspace/activity`, { headers })
  const runs = await fetch(`${base}/api/v1/runs`, { headers })
  const uiMs = performance.now() - started

  expect(((await bots.json()) as { bots: unknown[] }).bots).toHaveLength(257)
  expect(groups.status).toBe(200)
  expect(activity.status).toBe(200)
  expect(runs.status).toBe(200)
  expect(await ui.text()).toContain("fixture command workspace")
  expect(healthMs).toBeLessThan(2000)
  expect(uiMs).toBeLessThan(2000)
  const samples = await getLoopSamples(probePath)
  console.info(
    JSON.stringify({
      probe: "server-command-restart",
      healthMs,
      uiMs,
      loopMaxMs: getMaximum(samples),
      loopP95Ms: getPercentile(samples, 0.95),
      loopP99Ms: getPercentile(samples, 0.99),
      interruptedRuns: 100,
      historyBytes: 26_214_400,
    }),
  )
  expect(samples.length).toBeGreaterThan(30)
  expect(getPercentile(samples, 0.95)).toBeLessThan(50)
  expect(getMaximum(samples)).toBeLessThan(200)
}, 30_000)

const getHealthTime = async (base: string, started: number): Promise<number> => {
  while (performance.now() - started < 2000) {
    const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) }).catch(() => null)
    if (response?.ok && (await response.json()).ok === true) return performance.now() - started

    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("BOOT_BUDGET_EXCEEDED")
}

const seedRecovery = (database: Database, provider: string): void => {
  database
    .query("INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES('bot','Fixture',?,?,1,1)")
    .run(provider, join(dirname(database.filename), "bots", "bot"))
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

const getReadyResponse = async (url: string, headers: Record<string, string>): Promise<Response> => {
  const deadline = performance.now() + 2000
  while (performance.now() < deadline) {
    const response = await fetch(url, { headers })
    if (response.ok) return response
    expect(response.status).toBe(503)
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("WORKSPACE_BOOT_BUDGET_EXCEEDED")
}

const getLoopSamples = async (path: string): Promise<number[]> => {
  const deadline = performance.now() + 5000
  while (performance.now() < deadline) {
    if (await Bun.file(path).exists()) return Bun.file(path).json()
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("LOOP_PROBE_TIMEOUT")
}
