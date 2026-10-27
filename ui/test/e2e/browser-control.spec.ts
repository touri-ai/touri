import { type ChildProcess, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline"
import AxeBuilder from "@axe-core/playwright"
import { expect, type Page, test } from "@playwright/test"
import { build } from "vite"

type ControlMetrics = {
  frames: number[]
  longTasks: number[]
  clickAt: number
  latencies: number[]
  probe: { id: number; x: number; y: number; width: number; height: number; green: boolean } | null
}
type ControlWindow = Window & { browserControlMetrics: ControlMetrics }

const token = randomUUID()
const baseline = process.env.TOURI_BROWSER_PHASE === "before"
let child: ChildProcess
let endpoint = ""
let viewerRoot = ""
let probePath = ""
const evidenceRoot = process.env.TOURI_E2E_EVIDENCE_DIR

test.use({ video: "on", hasTouch: true })
test.beforeAll(async () => {
  viewerRoot = await mkdtemp(join(tmpdir(), "touri-browser-control-ui-"))
  const compilation = await build({
    root: resolve("."),
    configFile: resolve("vite.config.ts"),
    base: "/viewer/",
    build: {
      outDir: viewerRoot,
      emptyOutDir: true,
      rollupOptions: {
        input: {
          viewer: resolve("test/e2e/browser-control-harness.html"),
          probe: resolve("test/e2e/browser-control-probe.worker.ts"),
        },
      },
    },
  })
  const builds = Array.isArray(compilation) ? compilation : [compilation]
  const chunks = builds.flatMap((result) => ("output" in result ? result.output : []))
  const probe = chunks.find((chunk) => chunk.type === "chunk" && chunk.name === "probe")
  if (!probe) throw new Error("Production probe worker missing")
  probePath = `/viewer/${probe.fileName}`
  const port = await getAvailablePort()
  child = spawn("bun", [resolve("test/e2e/browser-control-server.ts")], {
    stdio: ["ignore", "pipe", "pipe"],
    env: Object.assign({}, process.env, {
      TOURI_BROWSER_CONTROL_TOKEN: token,
      TOURI_BROWSER_CONTROL_PORT: String(port),
      TOURI_BROWSER_CONTROL_UI_ORIGIN: `http://127.0.0.1:${port}`,
      TOURI_BROWSER_CONTROL_UI_ROOT: viewerRoot,
    }),
  })
  await new Promise<void>((accept, reject) => {
    const timer = setTimeout(() => reject(new Error("Local browser fixture did not start")), 30_000)
    if (!child.stdout) throw new Error("Fixture output missing")
    const lines = createInterface({ input: child.stdout })
    lines.on("line", (line) => {
      if (!line.startsWith("BROWSER_CONTROL:")) return
      endpoint = `http://127.0.0.1:${Number(line.split(":")[1])}`
      clearTimeout(timer)
      accept()
    })
    child.stderr?.on("data", (value) => process.stderr.write(value))
    child.once("exit", () => {
      clearTimeout(timer)
      reject(new Error("Local browser fixture exited"))
    })
  })
})
test.afterAll(async () => {
  if (viewerRoot) await rm(viewerRoot, { recursive: true, force: true })
  if (!child || child.exitCode !== null) return
  await new Promise<void>((done) => {
    child.once("exit", () => done())
    child.kill("SIGTERM")
  })
})

const post = async (body: object) => {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  })
  expect(response.ok).toBe(true)
  return response.json()
}

type Bounds = { x: number; y: number; left: number; top: number; width: number; height: number }
type State = {
  width: number
  height: number
  serverLagP99Ms: number
  serverLagMaxMs: number
  scrollY: number
  name: string
  clicks: string
  captcha: boolean
  selection: string
  next: boolean
  continued: boolean
  held: boolean
  nameBounds: Bounds
  clickBounds: Bounds
  captchaBounds: Bounds
  selectionBounds: Bounds
  nextBounds: Bounds
}
const getState = async (): Promise<State> => post({ step: "inspect" })
const getScreen = (page: Page) => page.getByRole("application", { name: "Página atual do navegador" })
const getPoint = async (page: Page, target: Bounds, state: State) => {
  const bounds = await getScreen(page).boundingBox()
  if (!bounds) throw new Error("Live page missing")
  return {
    x: bounds.x + (target.x / state.width) * bounds.width,
    y: bounds.y + (target.y / state.height) * bounds.height,
  }
}
const clickTarget = async (
  page: Page,
  key: "nameBounds" | "clickBounds" | "captchaBounds" | "nextBounds",
  touch = false,
) => {
  await expect(page.getByRole("button", { name: "Digitar no navegador" })).toBeEnabled()
  const state = await getState()
  const point = await getPoint(page, state[key], state)
  if (touch) await page.touchscreen.tap(point.x, point.y)
  else await page.mouse.click(point.x, point.y)
}

for (const width of [1440, 390]) {
  for (const theme of ["light", "dark"]) {
    test(`typed browser input keeps the address and whole reason ${width} ${theme}`, async ({ page }, info) => {
      test.setTimeout(60_000)
      const phase = baseline ? "before" : "after"
      const evidence = evidenceRoot ?? info.outputDir
      const reason = "Validação do touri: teste clique, rolagem e digitação nesta aba da página de teste local"
      await mkdir(evidence, { recursive: true })
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.addInitScript((transport) => Object.assign(window, { browserControlTransport: transport }), {
        endpoint,
        token,
        probeUrl: `${endpoint}${probePath}`,
      })

      await page.goto(
        `${endpoint}/viewer/test/e2e/browser-control-harness.html?theme=${theme}&reason=${encodeURIComponent(reason)}`,
      )
      await page.getByRole("button", { name: "Assumir navegador de teste" }).click()
      await clickTarget(page, "nameBounds", width === 390)
      await page.keyboard.type("teste local", { delay: 40 })
      await expect.poll(async () => (await getState()).name).toBe("teste local")
      await page.locator(".browser-takeover-reason").scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(evidence, `review-${phase}-${width}-${theme}.png`) })

      await expect.soft(page.getByRole("textbox", { name: "Endereço do navegador" })).toHaveValue(`${endpoint}/page`)
      await expect.soft(page.locator(".browser-takeover-reason")).toHaveText(reason)
      const accessibility = await new AxeBuilder({ page }).include(".browser-takeover-view").analyze()
      expect(accessibility.violations).toEqual([])
      await page.getByRole("button", { name: "Devolver para Lia" }).click()
      await expect.poll(async () => (await getState()).continued).toBe(true)
    })

    test(`browser control local form, scrolling and continuation ${width} ${theme}`, async ({ page }, info) => {
      test.setTimeout(150_000)
      const phase = baseline ? "before" : "after"
      const evidence = evidenceRoot ?? info.outputDir
      await mkdir(evidence, { recursive: true })
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.addInitScript(() => {
        const metrics: ControlMetrics = { frames: [], longTasks: [], clickAt: 0, latencies: [], probe: null }
        Object.assign(window, { browserControlMetrics: metrics })
        const observer = new PerformanceObserver((entries) =>
          metrics.longTasks.push(...entries.getEntries().map((entry) => entry.duration)),
        )
        observer.observe({ entryTypes: ["longtask"] })
        const verify = async (image: string) => {
          const probe = metrics.probe
          if (!probe || !metrics.clickAt) return
          const bitmap = await createImageBitmap(
            await (await fetch(image)).blob(),
            Math.floor(probe.x),
            Math.floor(probe.y),
            1,
            1,
          )
          const surface = new OffscreenCanvas(1, 1)
          const context = surface.getContext("2d", { willReadFrequently: true })
          context?.drawImage(bitmap, 0, 0)
          const color = context?.getImageData(0, 0, 1, 1).data
          bitmap.close()
          if (!color || metrics.probe !== probe) return
          const matches = probe.green ? color[1] > color[2] : color[2] > color[1]
          if (!matches) return
          metrics.latencies.push(performance.timeOrigin + performance.now() - metrics.clickAt)
          metrics.probe = null
        }
        const NativeWorker = window.Worker
        window.Worker = class extends NativeWorker {
          constructor(url: string | URL, options?: WorkerOptions) {
            const transport = (window as Window & { browserControlTransport: { probeUrl: string } })
              .browserControlTransport
            const source = String(url).includes("browserTakeover.worker") ? new URL(transport.probeUrl) : url
            super(source, options)
            this.addEventListener("message", (event) => {
              if (event.data.type === "visual-probe" && metrics.probe?.id === event.data.id) {
                metrics.latencies.push(event.data.latency)
                metrics.probe = null
                return
              }
              if (event.data.type !== "drawn") return
              metrics.frames.push(performance.now())
            })
          }
          postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
            const frame = message as { type?: string }
            const payload =
              frame.type === "frame"
                ? Object.assign({}, frame, {
                    probe: metrics.probe ? { ...metrics.probe, clickAt: metrics.clickAt } : null,
                  })
                : message
            if (Array.isArray(options)) super.postMessage(payload, options)
            else super.postMessage(payload, options)
          }
        }
        document.addEventListener(
          "load",
          (event) => {
            if (
              !(event.target instanceof HTMLImageElement) ||
              !event.target.classList.contains("browser-takeover-image")
            )
              return
            metrics.frames.push(performance.now())
            void verify(event.target.src)
          },
          true,
        )
      })
      await page.addInitScript((transport) => Object.assign(window, { browserControlTransport: transport }), {
        endpoint,
        token,
        probeUrl: `${endpoint}${probePath}`,
      })
      await page.goto(`${endpoint}/viewer/test/e2e/browser-control-harness.html?theme=${theme}`)
      await page.getByRole("button", { name: "Assumir navegador de teste" }).click()
      await expect(page.getByRole("button", { name: "Digitar no navegador" })).toBeEnabled({ timeout: 20_000 })
      await expect
        .poll(async () => page.evaluate(() => (window as ControlWindow).browserControlMetrics.frames.length))
        .toBeGreaterThan(0)
      if (!baseline) {
        const view = page.getByRole("region", { name: "Controle remoto do navegador" })
        await expect(view).toHaveAttribute("data-full-view", width === 390 ? "true" : "false")
        const screen = await getScreen(page).boundingBox()
        expect(screen?.width).toBeGreaterThan(width === 390 ? 370 : 1000)
        await expect
          .poll(async () =>
            Math.abs((await getState()).width - Math.round((await getScreen(page).boundingBox())?.width ?? 0)),
          )
          .toBe(0)
      }
      await page.screenshot({ path: join(evidence, `${phase}-${width}-${theme}.png`) })
      if (baseline && width === 390) {
        await page.getByRole("button", { name: "Expandir navegador em tela cheia" }).click()
        await expect(page.getByRole("region", { name: "Controle remoto do navegador" })).toHaveAttribute(
          "data-full-view",
          "true",
        )
        await expect(page.getByRole("button", { name: "Digitar no navegador" })).toBeEnabled()
      }
      await page.evaluate(() => {
        const control = window as ControlWindow
        control.browserControlMetrics.longTasks = []
      })
      await getScreen(page).evaluate((element) => {
        element.addEventListener("pointerup", () => {
          const control = window as ControlWindow
          control.browserControlMetrics.clickAt = performance.timeOrigin + performance.now()
        })
      })
      for (let index = 0; index < 20; index += 1) {
        const state = await getState()
        await page.evaluate(
          (probe) => {
            const control = window as ControlWindow
            control.browserControlMetrics.probe = probe
          },
          {
            id: index,
            x: state.clickBounds.left + 8,
            y: state.clickBounds.top + 8,
            width: state.width,
            height: state.height,
            green: Number(state.clicks) % 2 === 0,
          },
        )
        await clickTarget(page, "clickBounds", width === 390)
        await expect
          .poll(() => page.evaluate(() => (window as ControlWindow).browserControlMetrics.latencies.length))
          .toBe(index + 1)
      }
      const latencies = await page.evaluate(() => (window as ControlWindow).browserControlMetrics.latencies)
      const fpsStart = await page.evaluate(() => performance.now())
      await page.waitForTimeout(2_000)
      const frames = await page.evaluate(
        (start) => (window as ControlWindow).browserControlMetrics.frames.filter((time) => time >= start).length,
        fpsStart,
      )
      const fps = frames / 2
      const serverMetrics = await getState()
      const longTasks = await page.evaluate(() => (window as ControlWindow).browserControlMetrics.longTasks)
      await writeFile(
        join(evidence, `${phase}-${width}-${theme}-metrics.json`),
        JSON.stringify(
          {
            phase,
            width,
            theme,
            fps,
            serverLagP99Ms: serverMetrics.serverLagP99Ms,
            serverLagMaxMs: serverMetrics.serverLagMaxMs,
            uiLongTaskCount: longTasks.length,
            uiLongTaskMaxMs: Math.max(0, ...longTasks),
            clickToVisibleFrameMs: latencies,
            p95: latencies.toSorted((a, b) => a - b)[Math.ceil(latencies.length * 0.95) - 1],
          },
          null,
          2,
        ),
      )
      if (baseline) return
      expect(fps).toBeGreaterThanOrEqual(20)
      expect(latencies.toSorted((a, b) => a - b).at(-1)).toBeLessThan(500)
      expect((await getState()).continued).toBe(false)

      if (width === 1440) {
        const state = await getState()
        const start = await getPoint(page, { ...state.selectionBounds, x: state.selectionBounds.left + 4 }, state)
        const end = await getPoint(page, { ...state.selectionBounds, x: state.selectionBounds.left + 240 }, state)
        await page.mouse.move(start.x, start.y)
        await page.mouse.down()
        await page.mouse.move(end.x, end.y, { steps: 5 })
        await page.mouse.up()
        await expect.poll(async () => (await getState()).selection.length).toBeGreaterThan(5)
      }
      await clickTarget(page, "nameBounds", width === 390)
      // Human cadence sends one character per batch; none of them may become an app-wide redaction.
      await page.keyboard.type("teste local", { delay: 40 })
      await expect.poll(async () => (await getState()).name).toBe("teste local")
      await page.screenshot({ path: join(evidence, `typed-${phase}-${width}-${theme}.png`) })
      await expect(page.getByRole("textbox", { name: "Endereço do navegador" })).toHaveValue(`${endpoint}/page`)
      await page.keyboard.press("Control+A")
      await page.getByRole("textbox", { name: "Entrada de teclado para o navegador" }).evaluate((element) => {
        const transfer = new DataTransfer()
        transfer.setData("text/plain", "nome ficticio")
        element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }))
      })
      await expect.poll(async () => (await getState()).name).toBe("nome ficticio")
      await clickTarget(page, "captchaBounds", width === 390)
      await expect.poll(async () => (await getState()).captcha).toBe(true)
      const screen = getScreen(page)
      await screen.hover()
      if (width === 390) {
        const bounds = await screen.boundingBox()
        if (!bounds) throw new Error("Touch page missing")
        const touch = await page.context().newCDPSession(page)
        await touch.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x: bounds.x + 150, y: bounds.y + 450 }],
        })
        await touch.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: bounds.x + 150, y: bounds.y + 100 }],
        })
        await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
        await touch.detach()
      } else await page.mouse.wheel(0, 700)
      await expect.poll(async () => (await getState()).scrollY).toBeGreaterThan(200)
      await page.mouse.wheel(0, -1200)
      await expect.poll(async () => (await getState()).scrollY).toBe(0)
      const address = page.getByRole("textbox", { name: "Endereço do navegador" })
      await address.fill(`${endpoint}/page?next=1`)
      await address.press("Enter")
      await expect.poll(async () => (await getState()).next).toBe(true)
      await page.getByRole("button", { name: "Voltar página" }).click()
      await expect.poll(async () => (await getState()).next).toBe(false)
      await page.getByRole("button", { name: "Avançar página" }).click()
      await expect.poll(async () => (await getState()).next).toBe(true)
      await page.getByRole("button", { name: "Recarregar página" }).click()
      await expect.poll(async () => (await getState()).next).toBe(true)
      await page.setViewportSize({ width: width === 390 ? 410 : 1280, height: width === 390 ? 800 : 820 })
      await expect
        .poll(async () =>
          Math.abs((await getState()).width - Math.round((await getScreen(page).boundingBox())?.width ?? 0)),
        )
        .toBe(0)
      await clickTarget(page, "nameBounds", width === 390)
      await page.keyboard.type("estado preservado")
      await expect.poll(async () => (await getState()).name).toBe("estado preservado")
      await page.getByRole("button", { name: "Devolver para Lia" }).click()
      await expect.poll(async () => (await getState()).continued).toBe(true)
      expect((await getState()).name).toBe("estado preservado")
      expect((await getState()).held).toBe(false)
      await expect(page.getByText("Lia retomou o trabalho.")).toBeVisible()
    })
  }
}
test.afterEach(async ({ page }, info) => {
  const video = page.video()
  await page.close()
  if (evidenceRoot && video)
    await video.saveAs(
      join(
        evidenceRoot,
        `${baseline ? "before" : "after"}-${info.title.match(/(1440|390) (light|dark)/)?.[0].replace(" ", "-")}.webm`,
      ),
    )
})

const getAvailablePort = async (): Promise<number> => {
  for (let port = 18800; port <= 18899; port += 1) {
    const available = await new Promise<boolean>((done) => {
      const server = createServer()
      server.once("error", () => done(false))
      server.listen(port, "127.0.0.1", () => server.close(() => done(true)))
    })
    if (available) return port
  }
  throw new Error("No local fixture port is available")
}
