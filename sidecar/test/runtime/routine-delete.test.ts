import type { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AppSettings, Bot, Routine, UiEvent } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { init as initRuntime } from "../../src/runtime"
import { createRuntimePersistence } from "../../src/runtime/persistence"
import { init as initStore } from "../../src/store"

test("DELETE removes the schedule through the real API, publishes deletion and rejects later runs and edits", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-routine-delete-"))
  const runtime = createKernel({ appData: root })
  try {
    await initStore(runtime.kernel)
    await initRuntime(runtime.kernel)
    const request = (method: string, path: string, body?: unknown) =>
      fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1${path}`, {
        method,
        headers: {
          Authorization: "Bearer dev-ui-token",
          "Content-Type": "application/json",
          "x-touri-client": "routine-test",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    const { settings } = (await (await request("GET", "/settings")).json()) as { settings: AppSettings }
    const { bot } = (await (
      await request("POST", "/bots", { name: "Notas", provider: settings.defaultProvider, machine: "local" })
    ).json()) as { bot: Bot }
    const created = await request("POST", "/routines", {
      botId: bot.id,
      name: "Organizar notas",
      prompt: "Organize notas",
      cron: "0 9 * * *",
      timezone: "UTC",
      enabled: false,
    })
    expect(created.status).toBe(201)
    const { routine } = (await created.json()) as { routine: Routine }
    const events: UiEvent[] = []
    runtime.kernel.subscribe(({ event }) => events.push(event))
    expect((await request("DELETE", `/routines/${routine.id}`)).status).toBe(200)
    expect(events).toContainEqual({ type: "routine.deleted", routineId: routine.id })
    expect(await (await request("GET", "/routines")).json()).toMatchObject({ routines: [] })
    expect((await request("POST", `/routines/${routine.id}/run`, {})).status).toBe(404)
    expect((await request("PATCH", `/routines/${routine.id}`, { enabled: true })).status).toBe(404)
    expect((await request("DELETE", `/routines/${routine.id}`)).status).toBe(404)
    const db = runtime.kernel.db as Database
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([])
    expect(createRuntimePersistence({ database: db }).getRoutine(routine.id)).toBeNull()
  } finally {
    await runtime.kernel.services.use("runtime.shutdown")?.()
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
})
