import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createKernel } from "../../src/kernel"
import { init as initRuntime } from "../../src/runtime"
import { init as initStore } from "../../src/store"

let runtime: ReturnType<typeof createKernel> | null = null
let appData: string | null = null

afterEach(async () => {
  const current = runtime
  runtime = null
  if (!current) return

  await current.kernel.services
    .use("runtime.shutdown")?.()
    .catch(() => {})
  await current.stop()
  if (appData) rmSync(appData, { recursive: true, force: true })
  appData = null
})

test("health and the runs route report when the server is draining", async () => {
  appData = mkdtempSync(join(tmpdir(), "touri-drain-"))
  runtime = createKernel({ appData })
  await initStore(runtime.kernel)
  await initRuntime(runtime.kernel)
  const base = `http://127.0.0.1:${runtime.handshake.port}/api/v1`
  const headers = { Authorization: "Bearer dev-ui-token", Origin: "tauri://localhost" }
  const get = (path: string) => fetch(`${base}${path}`, { headers })

  const healthBefore = await (await get("/health")).json()
  const runsBefore = await (await get("/runs")).json()
  expect(healthBefore).toMatchObject({ draining: false })
  expect(runsBefore).toMatchObject({ draining: false })

  const beginDrain = runtime.kernel.services.use("runtime.beginDrain")
  if (!beginDrain) throw new Error("Drain service unavailable")
  await beginDrain()

  const healthDuring = await (await get("/health")).json()
  const runsDuring = await (await get("/runs")).json()
  expect(healthDuring).toMatchObject({ draining: true })
  expect(runsDuring).toMatchObject({ draining: true })
})
