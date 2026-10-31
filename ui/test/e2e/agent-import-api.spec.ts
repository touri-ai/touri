import { type ChildProcess, spawn } from "node:child_process"
import { mkdir } from "node:fs/promises"
import { createServer } from "node:net"
import { join, resolve } from "node:path"
import { expect, test } from "@playwright/test"

test.use({ video: process.env.TOURI_IMPORT_EVIDENCE ? { mode: "on", size: { width: 1280, height: 1000 } } : "off" })

const children = new Set<ChildProcess>()
test.afterEach(async () => {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const exited = new Promise<void>((done) => child.once("exit", () => done()))
    const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000)
    child.kill("SIGTERM")
    await exited
    clearTimeout(deadline)
  }
  children.clear()
})

const getFreePort = async (port = 18800): Promise<number> => {
  if (port > 18899) throw new Error("No free fixture port")
  const available = await new Promise<boolean>((done) => {
    const server = createServer()
    server.once("error", () => done(false))
    server.listen(port, "127.0.0.1", () => server.close(() => done(true)))
  })
  return available ? port : getFreePort(port + 1)
}

const startServer = async (backendRoot?: string): Promise<number> => {
  const port = await getFreePort()
  const child = spawn("bun", [resolve("test/e2e/agent-import-api-server.ts"), String(port)], {
    env: {
      ...process.env,
      TOURI_UI_TOKEN: "fixture",
      ...(backendRoot ? { TOURI_IMPORT_BACKEND_ROOT: backendRoot } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  children.add(child)
  child.stderr?.on("data", () => undefined)
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => reject(new Error("Fixture startup timed out")), 20_000)
    child.once("exit", () => {
      clearTimeout(timer)
      reject(new Error("Fixture exited"))
    })
    child.stdout?.on("data", (chunk) => {
      if (String(chunk).includes('"port"')) {
        clearTimeout(timer)
        done()
      }
      if (String(chunk).includes('"measurement"')) console.info(String(chunk).trim())
    })
  })
  return port
}

test("typed client previews, imports and undoes through the real server without stalling the browser", async ({
  page,
}, info) => {
  test.setTimeout(90_000)
  const shots = process.env.TOURI_IMPORT_EVIDENCE
  if (shots) await mkdir(shots, { recursive: true })
  const saveVideo = async (name: string) => {
    if (!shots) return
    const video = page.video()
    await page.context().close()
    if (video) await video.saveAs(join(shots, name))
  }
  const port = await startServer(process.env.TOURI_IMPORT_BACKEND_ROOT)
  await page.route("**/api/v1/import/**", async (route) => {
    const url = new URL(route.request().url())
    const response = await route.fetch({ url: `http://127.0.0.1:${port}${url.pathname}` })
    await route.fulfill({ response })
  })
  await page.setViewportSize({ width: 1280, height: 1000 })
  await page.goto("/test/e2e/agent-import-api-harness.html")
  await expect(page.getByRole("button", { name: "Revisar exportação" })).toBeEnabled()
  await page.evaluate(() => document.fonts.ready)
  await page.evaluate(() => {
    const metrics = { longTasks: [] as number[], events: [] as number[], paints: [] as number[], cls: 0 }
    const observers = [
      new PerformanceObserver((list) =>
        list.getEntries().forEach((entry) => {
          metrics.longTasks.push(entry.duration)
        }),
      ),
      new PerformanceObserver((list) =>
        list.getEntries().forEach((entry) => {
          metrics.cls += (entry as PerformanceEntry & { value: number; hadRecentInput: boolean }).hadRecentInput
            ? 0
            : (entry as PerformanceEntry & { value: number }).value
        }),
      ),
    ]
    const eventObserver = new PerformanceObserver((list) =>
      list.getEntries().forEach((entry) => {
        metrics.events.push(entry.duration)
      }),
    )
    eventObserver.observe({ type: "event", durationThreshold: 16, buffered: false } as PerformanceObserverInit)
    observers.push(eventObserver)
    observers[0]?.observe({ type: "longtask", buffered: false })
    observers[1]?.observe({ type: "layout-shift", buffered: false })
    document.addEventListener("click", () => {
      const started = performance.now()
      requestAnimationFrame(() => requestAnimationFrame(() => metrics.paints.push(performance.now() - started)))
    })
    Object.assign(window, { importMetrics: metrics, importObservers: observers })
  })
  await page.getByRole("button", { name: "Revisar exportação" }).click()
  if (process.env.TOURI_IMPORT_BACKEND_ROOT) {
    await expect(page.getByTestId("output")).toContainText("TOURI-E1002")
    if (shots) {
      await page.waitForTimeout(700)
      await page.screenshot({ path: join(shots, "before-api.png") })
    }
    await saveVideo("before-api.webm")
    return
  }
  await expect(page.getByTestId("output")).toContainText('"previewId"')
  if (shots) {
    await page.waitForTimeout(700)
    await page.screenshot({ path: join(shots, "after-preview.png") })
  }
  await page.getByRole("button", { name: "Importar", exact: true }).click()
  await expect(page.getByTestId("output")).toContainText('"pausedRoutines": 1')
  if (shots) {
    await page.waitForTimeout(700)
    await page.screenshot({ path: join(shots, "after-apply.png") })
  }
  await page.getByRole("button", { name: "Desfazer", exact: true }).click()
  await expect(page.getByTestId("output")).toContainText('"removedBots": 1')
  await page.waitForTimeout(shots ? 700 : 180)
  const metrics = await page.evaluate(() => {
    const state = window as Window & {
      importMetrics?: { longTasks: number[]; events: number[]; paints: number[]; cls: number }
      importObservers?: PerformanceObserver[]
    }
    state.importObservers?.forEach((observer) => {
      observer.disconnect()
    })
    return state.importMetrics
  })
  if (!metrics) throw new Error("Missing performance measurements")
  const paints = metrics.paints.toSorted((left, right) => left - right)
  const p95 = paints[Math.max(0, Math.ceil(paints.length * 0.95) - 1)] ?? 0
  console.info(
    JSON.stringify({
      measurement: "agent-import-api-browser",
      interactionToPaintP95Ms: p95,
      cls: metrics.cls,
      longTasks: metrics.longTasks,
      eventTimingMs: metrics.events,
    }),
  )
  await info.attach("api-performance", { body: JSON.stringify(metrics), contentType: "application/json" })

  expect(paints.length).toBeGreaterThanOrEqual(3)
  expect(p95).toBeLessThan(100)
  expect(metrics.longTasks.filter((duration) => duration > 50)).toEqual([])
  expect(metrics.cls).toBeLessThan(0.001)
  await saveVideo("api-import.webm")
})
