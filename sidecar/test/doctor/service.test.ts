import type { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DoctorReport } from "@touri/contracts"
import { createDoctorService, installDoctor } from "../../src/doctor"
import { check } from "../../src/doctor/check"
import { createKernel } from "../../src/kernel"
import { initModules } from "../../src/main"
import { stop as stopMcp } from "../../src/mcp"
import { MCP_STARTUP_MESSAGE } from "../../src/runtime/mcp-startup"

const deferred = <T>() => {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test("startup checks are deferred, concurrent refreshes share a run, and snapshots are cached", async () => {
  const pending = deferred<ReturnType<typeof check>[]>()
  let calls = 0
  const service = createDoctorService(async () => {
    calls += 1
    return pending.promise
  })
  service.start()
  expect(calls).toBe(0)
  expect(service.snapshot()).toMatchObject({ checks: [], checkedAt: null, running: true })
  service.start()
  service.snapshot(true)
  await Promise.resolve()
  expect(calls).toBe(1)
  pending.resolve([check("example", "Verificação", "pass", "Pronto.")])
  await service.settled()
  const ready = service.snapshot()
  expect(ready.running).toBe(false)
  expect(ready.checkedAt).toBeGreaterThan(0)
  expect(ready.checks).toHaveLength(1)
  expect(calls).toBe(1)
  ready.checks.length = 0
  expect(service.snapshot().checks).toHaveLength(1)
  const item = service.snapshot().checks[0]
  if (item) item.detail = "changed outside the service"
  expect(service.snapshot().checks[0]?.detail).toBe("Pronto.")
  service.snapshot(true)
  await service.settled()
  expect(calls).toBe(2)
  service.dispose()
})

test("shutdown before deferred startup does not execute the collector", async () => {
  let calls = 0
  const service = createDoctorService(async () => {
    calls += 1
    return []
  })
  service.start()
  service.dispose()
  await service.settled()
  expect(calls).toBe(0)
  expect(service.snapshot().running).toBe(false)
})

test("collector errors produce a local explanation and a retry can recover", async () => {
  let fail = true
  const service = createDoctorService(async () => {
    if (fail) throw new Error("private error payload")
    return [check("example", "Verificação", "pass", "Pronto.")]
  })
  service.start()
  await service.settled()
  expect(service.snapshot().checks[0]?.status).toBe("fail")
  expect(JSON.stringify(service.snapshot())).not.toContain("private error")
  fail = false
  service.snapshot(true)
  await service.settled()
  expect(service.snapshot().checks[0]?.status).toBe("pass")
  service.dispose()
})

test("a stuck collector times out, aborts its probes and permits a retry", async () => {
  const late = deferred<ReturnType<typeof check>[]>()
  let probeSignal: AbortSignal | undefined
  let calls = 0
  const service = createDoctorService(async (signal) => {
    probeSignal = signal
    calls += 1
    return calls === 1 ? late.promise : [check("recovered", "Verificação", "pass", "Pronto.")]
  }, 20)
  service.start()
  await service.settled()
  expect(probeSignal?.aborted).toBe(true)
  expect(service.snapshot()).toMatchObject({ running: false, checks: [{ id: "doctor", status: "fail" }] })
  service.snapshot(true)
  await service.settled()
  late.resolve([check("late", "Verificação", "pass", "Pronto.")])
  await Promise.resolve()
  expect(service.snapshot().checks[0]?.id).toBe("recovered")
  service.dispose()
})

test("disposed services abort probes and reject late completion without replacing the cached report", async () => {
  const pending = deferred<ReturnType<typeof check>[]>()
  let abort: AbortSignal | undefined
  const service = createDoctorService(async (signal) => {
    abort = signal
    return pending.promise
  })
  service.start()
  await Promise.resolve()
  service.dispose()
  expect(abort?.aborted).toBe(true)
  pending.resolve([check("late", "Verificação", "pass", "Pronto.")])
  await service.settled()
  expect(service.snapshot(true)).toEqual({ checks: [], checkedAt: null, running: false })
})

test("authenticated /doctor responds immediately, supports refresh, and kernel shutdown cancels it", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-doctor-http-"))
  const runtime = createKernel({ appData: root })
  let probeSignal: AbortSignal | undefined
  const pending = deferred<ReturnType<typeof check>[]>()
  const refreshPending = deferred<ReturnType<typeof check>[]>()
  let runs = 0
  const service = installDoctor(runtime.kernel, async (signal) => {
    probeSignal = signal
    runs += 1
    return runs === 1 ? pending.promise : refreshPending.promise
  })
  const headers = { Authorization: "Bearer dev-ui-token", Origin: "tauri://localhost" }
  const url = `http://127.0.0.1:${runtime.handshake.port}/api/v1/doctor`
  try {
    expect((await fetch(url, { headers: { Origin: "tauri://localhost" } })).status).toBe(401)
    expect(probeSignal).toBeUndefined()
    const response = await fetch(url, { headers })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ running: true, checks: [] })
    pending.resolve([check("http-example", "Verificação", "warn", "Aviso.", "codex login")])
    await service.settled()
    const ready = (await (await fetch(url, { headers })).json()) as DoctorReport
    expect(ready).toMatchObject({ running: false, checks: [{ id: "http-example", status: "warn" }] })
    expect(await (await fetch(`${url}?refresh=true`, { headers })).json()).toMatchObject({ running: true })
    runtime.stop()
    expect(probeSignal?.aborted).toBe(true)
    refreshPending.resolve([])
    await service.settled()
  } finally {
    // stop is called exactly once; unrelated processes and containers are untouched.
    if (!probeSignal?.aborted) runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test("module initialization starts Doctor in the background without waiting for probes", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-doctor-startup-"))
  const runtime = createKernel({ appData: root })
  let started = false
  let stopped = false
  // Replace just the registry entry installed by store so no real probes run in this test.
  const provide = runtime.kernel.services.provide.bind(runtime.kernel.services)
  runtime.kernel.services.provide = (name, impl) => {
    provide(
      name,
      name === "doctor"
        ? ({
            start: () => {
              started = true
            },
            dispose: () => {
              stopped = true
            },
          } as typeof impl)
        : impl,
    )
  }
  try {
    await initModules(runtime)
    expect(started).toBe(true)
  } finally {
    runtime.emitHostNotification({ method: "app.willQuit", params: {} })
    await stopMcp({ kernel: runtime.kernel })
    await runtime.stop()
    expect(stopped).toBe(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test.each(["local", "vm"] as const)(
  "cached Doctor reports reflect a new %s MCP failure and recovery without rerunning probes",
  async (machine) => {
    const prefix = machine === "vm" ? "vm-mcp" : "local-mcp"
    const root = mkdtempSync(join(tmpdir(), "touri-doctor-mcp-"))
    const runtime = createKernel({ appData: root })
    const db = runtime.kernel.db as Database
    let calls = 0
    const service = installDoctor(runtime.kernel, async () => {
      calls++
      return [
        check("example", "Local", "pass", "Pronto."),
        check(`${prefix}:bot`, "Cached tools", "pass", "Cached result"),
      ]
    })
    const read = async () =>
      (await (
        await fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1/doctor`, {
          headers: { Authorization: "Bearer dev-ui-token", Origin: "tauri://localhost" },
        })
      ).json()) as DoctorReport
    try {
      service.start()
      await service.settled()
      db.query(
        "INSERT INTO bots (id, name, provider, machine, home_dir, created_at, updated_at) VALUES ('bot', 'Checkout', 'codex', ?, ?, 1, 1)",
      ).run(machine, root)
      db.query(
        "INSERT INTO threads (id, bot_id, kind, title, created_at, updated_at) VALUES ('thread', 'bot', 'chat', 'Checkout', 1, 1)",
      ).run()
      expect((await read()).checks).toContainEqual(expect.objectContaining({ id: `${prefix}:bot`, status: "warn" }))
      db.query(
        "INSERT INTO runs (id, thread_id, bot_id, provider, trigger, status, error_class, error_message, queued_at) VALUES ('failed', 'thread', 'bot', 'codex', 'user', 'failed', 'cli_protocol', ?, 1)",
      ).run(MCP_STARTUP_MESSAGE)
      expect((await read()).checks).toContainEqual(
        expect.objectContaining({
          id: `${prefix}:bot`,
          status: "fail",
          detail: expect.stringContaining(MCP_STARTUP_MESSAGE),
        }),
      )
      if (machine === "local") {
        const failed = (await read()).checks.find((item) => item.id === `${prefix}:bot`)
        expect(failed?.detail).toContain("instalação do touri")
        expect(failed?.detail).not.toContain("inicie a máquina")
        expect((await read()).checks.filter((item) => item.id === `${prefix}:bot`)).toHaveLength(1)
      }
      db.query(
        "INSERT INTO runs (id, thread_id, bot_id, provider, trigger, status, queued_at) VALUES ('recovered', 'thread', 'bot', 'codex', 'user', 'succeeded', 2)",
      ).run()
      expect((await read()).checks).toContainEqual(expect.objectContaining({ id: `${prefix}:bot`, status: "pass" }))
      expect(calls).toBe(1)
    } finally {
      runtime.stop()
      rmSync(root, { recursive: true, force: true })
    }
  },
)
