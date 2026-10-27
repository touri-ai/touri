import { type ChildProcess, spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { resolve } from "node:path"
import { createInterface } from "node:readline"
import AxeBuilder from "@axe-core/playwright"
import { expect, type Page, test } from "@playwright/test"

let child: ChildProcess | undefined
let endpoint = ""
let botId = ""
const evidence = process.env.TOURI_E2E_EVIDENCE_DIR
const phase = process.env.TOURI_COMPUTER_PHASE ?? "after"
const text = "ç á ã ê ~ ^ ` ´ @ ¹ ² ³"

test.skip(!process.env.TOURI_TERMINAL_DOCKER, "Requires the real bot image")
test.use({ channel: "chromium" })
test.beforeAll(async ({ baseURL }) => {
  test.setTimeout(240_000)
  const port = await getPort()
  child = spawn("bun", [resolve("test/e2e/computer-terminal-server.ts")], {
    stdio: ["ignore", "pipe", "pipe"],
    env: Object.assign({}, process.env, { TOURI_TERMINAL_ORIGIN: baseURL, TOURI_TERMINAL_PORT: String(port) }),
  })
  await new Promise<void>((accept, reject) => {
    const timer = setTimeout(() => reject(new Error("Computer fixture timed out")), 180_000)
    if (!child?.stdout) throw new Error("Missing fixture output")
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.startsWith("TERMINAL_FIXTURE:")) return
      const parts = line.split(":")
      endpoint = `http://127.0.0.1:${parts[1]}`
      botId = parts[2] ?? ""
      clearTimeout(timer)
      accept()
    })
    child.stderr?.on("data", (chunk) => process.stderr.write(chunk))
    child.once("exit", () => {
      clearTimeout(timer)
      reject(new Error("Computer fixture exited"))
    })
  })
})
test.afterAll(async () => {
  if (!child || child.exitCode !== null) return
  const running = child
  await new Promise<void>((done) => {
    running.once("exit", () => done())
    running.kill("SIGTERM")
  })
})

test("real computer keyboard, frame timing and CPU evidence", async ({ page }) => {
  test.setTimeout(240_000)
  let receivedFrames = 0
  page.on("websocket", (socket) => {
    if (!socket.url().includes("/desktop/")) return
    socket.on("framereceived", () => {
      receivedFrames += 1
    })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/test/e2e/fixtures/desktop.html?running&endpoint=${encodeURIComponent(endpoint)}&bot=${botId}`)
  await expect(page.getByRole("button", { name: "Assumir controle", exact: true })).toBeEnabled({ timeout: 60_000 })
  await page.getByRole("button", { name: "Assumir controle", exact: true }).click()
  const keyboard = page.getByLabel("Digitar na VM")
  await expect(keyboard).toBeEnabled({ timeout: 30_000 })
  if (phase !== "before") await page.getByLabel("Layout do teclado").selectOption("br")
  await keyboard.fill(`printf '%s\\n' '${text}' > ~/terminal-proof.txt`)
  await keyboard.press("Enter")
  await expect.poll(() => requestEvidence({ command: "cat /workspace/.home/terminal-proof.txt" })).toBe(`${text}\n`)
  await page.locator(".desktop-canvas canvas").click({ position: { x: 200, y: 160 } })
  await page.keyboard.type("printf '%s\\n' '")
  await page.keyboard.insertText(text)
  await page.keyboard.type("' >> ~/terminal-proof.txt")
  await page.keyboard.press("Enter")
  await expect
    .poll(() => requestEvidence({ command: "cat /workspace/.home/terminal-proof.txt" }))
    .toBe(`${text}\n${text}\n`)

  const latency = await measureInputLatency(page)
  await keyboard.fill("for i in $(seq 1 400); do printf '\\rframe %04d' $i; sleep 0.05; done")
  await keyboard.press("Enter")
  const control = await measureScreenActivity(page)
  await page.getByRole("button", { name: "Devolver ao bot", exact: true }).click()
  await expect(keyboard).toBeDisabled()
  await expect(page.getByRole("button", { name: "Assumir controle", exact: true })).toBeEnabled({ timeout: 30_000 })
  const watching = await measureScreenActivity(page)
  const metrics = { phase, latency, control, watching }
  console.log(`COMPUTER_METRICS ${JSON.stringify(metrics)}`)
  if (evidence) {
    await mkdir(evidence, { recursive: true })
    await writeFile(resolve(evidence, `computer-${phase}.json`), JSON.stringify(metrics, null, 2))
  }

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme })
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme
      }, colorScheme)
      await page.getByRole("button", { name: "Assumir controle", exact: true }).click()
      await expect(keyboard).toBeEnabled({ timeout: 30_000 })
      await keyboard.press("Control+c")
      if (phase !== "before") {
        await expect(page.getByText("Você está no controle · Lia aguarda", { exact: true })).toBeVisible()
        const layout = await page.getByLabel("Layout do teclado").boundingBox()
        expect(layout?.height).toBeGreaterThanOrEqual(44)
        const accessibility = await new AxeBuilder({ page }).include(".desktop-panel").analyze()
        expect(accessibility.violations.filter(({ impact }) => impact === "serious" || impact === "critical")).toEqual(
          [],
        )
      }
      await page.screenshot({
        path: test.info().outputPath(`computer-${phase}-${width}-${colorScheme}.png`),
        fullPage: true,
      })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.getByRole("button", { name: "Devolver ao bot", exact: true }).click()
      await expect(page.getByRole("button", { name: "Assumir controle", exact: true })).toBeEnabled({ timeout: 30_000 })
    }
  }

  if (phase === "before") return
  await verifyBrowserAndHandback(page)
  await expect(page.getByRole("button", { name: "Assumir controle", exact: true })).toBeEnabled({ timeout: 30_000 })
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true })
    document.dispatchEvent(new Event("visibilitychange"))
  })
  const beforeHide = receivedFrames
  // Observe beyond the liveness deadline: one already requested update may still arrive.
  await page.waitForTimeout(9_000)
  expect(receivedFrames - beforeHide).toBeLessThanOrEqual(1)
  await expect(page.getByRole("button", { name: "Assumir controle", exact: true })).toBeEnabled()
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false })
    document.dispatchEvent(new Event("visibilitychange"))
  })
  const beforeResume = receivedFrames
  await expect.poll(() => receivedFrames).toBeGreaterThan(beforeResume)
})

const verifyBrowserAndHandback = async (page: Page) => {
  await requestEvidence({ action: "browser-open" })
  await expect.poll(() => requestEvidence({ action: "browser-focus" }), { timeout: 30_000 }).toBe("complete")
  await page.getByRole("button", { name: "Assumir controle", exact: true }).click()
  const keyboard = page.getByLabel("Digitar na VM")
  await expect(keyboard).toBeEnabled({ timeout: 30_000 })
  await keyboard.focus()
  await page.keyboard.insertText(`${text} €`)
  await expect.poll(() => requestEvidence({ action: "browser-value" }), { timeout: 15_000 }).toBe(`${text} €`)
  await keyboard.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }))
    element.dispatchEvent(new CompositionEvent("compositionend", { data: " ação", bubbles: true }))
  })
  await expect.poll(() => requestEvidence({ action: "browser-value" })).toBe(`${text} € ação`)
  await keyboard.evaluate((element) => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "q",
        code: "KeyQ",
        ctrlKey: true,
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
  })
  await expect.poll(() => requestEvidence({ action: "browser-value" })).toBe(`${text} € ação/`)

  expect(await requestEvidence({ action: "wait-for-handback" })).toBe("waiting")
  expect(await requestEvidence({ action: "handback-status" })).toBe("false")
  await page.getByRole("button", { name: "Devolver ao bot", exact: true }).click()
  await expect.poll(() => requestEvidence({ action: "handback-status" })).toBe("true")
  await expect(keyboard).toBeDisabled()
}

const measureInputLatency = async (page: Page) => {
  const keyboard = page.getByLabel("Digitar na VM")
  // Repeating each echo distinguishes a real character from cursor/heartbeat pixels.
  const copies = Array.from({ length: 16 }, () => '"$key"').join(" ")
  await keyboard.fill(
    `printf 'latency-ready\\n' >> ~/terminal-proof.txt; while IFS= read -rsn1 key; do printf '\\r'; printf '%s' ${copies}; done`,
  )
  await keyboard.press("Enter")
  await expect
    .poll(() => requestEvidence({ command: "cat /workspace/.home/terminal-proof.txt" }))
    .toContain("latency-ready")
  const samples = []
  for (const index of Array.from({ length: 13 }, (_, index) => index)) {
    await keyboard.evaluate((element) => {
      const canvas = document.querySelector("canvas")
      if (!canvas) throw new Error("Missing canvas")
      const pixels = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data
      Object.assign(window, { computerPixels: pixels })
      element.addEventListener(
        "beforeinput",
        () => {
          Object.assign(window, { computerInputAt: performance.now() })
        },
        { once: true },
      )
    })
    await page.keyboard.type(index % 2 ? "w" : "m")
    await page.waitForFunction(
      () => {
        const state = window as typeof window & {
          computerPixels: Uint8ClampedArray
          computerInputAt: number
          computerLatency: number
        }
        const at = performance.now()
        const canvas = document.querySelector("canvas")
        const pixels = canvas?.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data
        if (!pixels || !state.computerInputAt) return false
        // Stop once the glyph echo is identified; pixel comparison time is not latency.
        let changed = 0
        for (let offset = 0; offset < pixels.length; offset += 1) {
          if (pixels[offset] !== state.computerPixels[offset]) changed += 1
          if (changed < 800) continue
          state.computerLatency = at - state.computerInputAt
          return true
        }
        return false
      },
      undefined,
      { polling: "raf", timeout: 10_000 },
    )
    samples.push(await page.evaluate(() => (window as typeof window & { computerLatency: number }).computerLatency))
  }
  await keyboard.press("Control+c")
  return samples.slice(1)
}

const measureScreenActivity = async (page: Page) => {
  const before = JSON.parse(await requestEvidence({ action: "cpu" })) as {
    sidecar: { user: number; system: number }
    guest: string
  }
  const intervals = await page.evaluate(async () => {
    const canvas = document.querySelector("canvas")
    if (!canvas) throw new Error("Missing canvas")
    const context = canvas.getContext("2d")
    if (!context) throw new Error("Missing display context")
    const start = performance.now()
    const frames: number[] = []
    let previous = ""
    await new Promise<void>((done) => {
      const sample = () => {
        if (!canvas.isConnected || !canvas.width || !canvas.height) return done()
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
        let hash = 0
        for (let offset = 0; offset < pixels.length - canvas.width * 8 * 4; offset += 16)
          hash = (hash * 31 + (pixels[offset] ?? 0)) | 0
        if (String(hash) !== previous) frames.push(performance.now())
        previous = String(hash)
        if (performance.now() - start >= 3000) return done()
        requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    })
    return frames.slice(1).map((at, index) => at - (frames[index] ?? at))
  })
  const after = JSON.parse(await requestEvidence({ action: "cpu" })) as typeof before
  const getGuest = (value: string) => Number(/usage_usec (\d+)/.exec(value)?.[1] ?? 0)
  return {
    intervals,
    sidecarCpuMs: (after.sidecar.user + after.sidecar.system - before.sidecar.user - before.sidecar.system) / 1000,
    guestCpuMs: (getGuest(after.guest) - getGuest(before.guest)) / 1000,
    windowMs: 3000,
  }
}

const requestEvidence = async (body: { action?: string; command?: string }): Promise<string> => {
  const response = await fetch(`${endpoint}/api/v1/terminal-evidence`, {
    method: "POST",
    headers: { Authorization: "Bearer dev-ui-token", "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`Computer evidence request failed (${response.status})`)
  const result = (await response.json()) as { stdout?: string }
  return result.stdout ?? ""
}
const getPort = async (): Promise<number> => {
  for (const port of Array.from({ length: 100 }, (_, index) => 18800 + index)) {
    const available = await new Promise<boolean>((accept) => {
      const server = createServer()
      server.once("error", () => accept(false))
      server.listen(port, "127.0.0.1", () => server.close(() => accept(true)))
    })
    if (available) return port
  }
  throw new Error("No free staging port")
}
