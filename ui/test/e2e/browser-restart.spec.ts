import { type ChildProcess, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { createInterface } from "node:readline"
import { chromium, expect, test } from "@playwright/test"

const token = randomUUID()
let child: ChildProcess | undefined
let endpoint = ""

test.beforeAll(async ({ baseURL }) => {
  if (!baseURL) throw new Error("The fixture URL is missing")
  child = spawn("bun", [resolve("test/e2e/browser-restart-server.ts")], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      TOURI_CHROME_BIN: chromium.executablePath(),
      TOURI_BROWSER_HEADLESS: "1",
      TOURI_BROWSER_FLOW_TOKEN: token,
      TOURI_BROWSER_RESTART_PORT: "18883",
      TOURI_BROWSER_FLOW_FIXTURE_URL: new URL("/test/e2e/fixtures/travel-search.html", baseURL).toString(),
    },
  })
  const spawned = child
  await new Promise<void>((accept, reject) => {
    const timer = setTimeout(() => reject(new Error("The recovery fixture did not start")), 20_000)
    const lines = createInterface({ input: spawned.stdout as NodeJS.ReadableStream })
    lines.on("line", (line) => {
      if (!line.startsWith("BROWSER_RESTART_FIXTURE:")) return
      endpoint = `http://127.0.0.1:${Number(line.split(":")[1])}`
      clearTimeout(timer)
      accept()
    })
    spawned.once("exit", () => {
      clearTimeout(timer)
      reject(new Error("The fixture exited"))
    })
    spawned.stderr?.on("data", (chunk) => globalThis.process.stderr.write(chunk))
  })
})

test.afterAll(async () => {
  const spawned = child
  if (!spawned || spawned.exitCode !== null) return
  await new Promise<void>((done) => {
    spawned.once("exit", () => done())
    spawned.kill("SIGTERM")
  })
})

const requestFixture = async (body: unknown) =>
  fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

for (const width of [1440, 390]) {
  test(`same unloaded tab fails safely after real engine restart at ${width}px`, async ({ page }, info) => {
    test.setTimeout(90_000)
    await page.setViewportSize({ width, height: width < 500 ? 844 : 900 })
    await page.route("**/__browser-restart-fixture", async (route) => {
      const response = await requestFixture(JSON.parse(route.request().postData() ?? "{}"))
      await route.fulfill({ status: response.status, contentType: "application/json", body: await response.text() })
    })
    await page.goto("/test/e2e/browser-restart-harness.html")
    await page.getByRole("button", { name: "Abrir página pública fictícia" }).click()
    const directory = process.env.TOURI_E2E_EVIDENCE_DIR ?? info.outputDir
    await mkdir(directory, { recursive: true })
    const takeover = page.getByRole("button", { name: "Assumir", exact: true })
    await expect(takeover).toBeEnabled({ timeout: 30_000 })
    await takeover.click()
    const view = page.getByRole("region", { name: "Controle remoto do navegador" })
    await expect(view).toBeVisible()
    await expect(view.getByRole("button", { name: "Digitar no navegador" })).toBeEnabled({ timeout: 20_000 })
    await page.screenshot({ path: resolve(directory, `browser-restart-live-${width}.png`), fullPage: true })
    await view.getByRole("button", { name: /Devolver para/ }).click()
    await expect(view).toHaveCount(0)

    const restart = await requestFixture({ step: "restart" })
    expect(restart.ok).toBe(true)
    const restored = (await restart.json()) as { tabId: string; state: string }
    expect(restored.tabId).not.toBe("")
    expect(restored.state).toBe("unloaded")
    const request = await requestFixture({ step: "request-takeover" })
    expect(request.ok).toBe(true)
    await takeover.click()

    await expect(
      page.getByText(
        "Esta sessão do navegador está indisponível. Devolva o controle e peça ao bot para abrir novamente uma página pública. Nenhuma página foi reaberta.",
      ),
    ).toBeVisible({ timeout: 20_000 })
    // The person sees the outcome where they clicked, before any assertion that could fail on old layouts.
    await page.screenshot({ path: resolve(directory, `browser-restart-recovery-${width}.png`) })
    await expect(view).toHaveCount(0)
    await expect(page.getByText(/Você está no controle/)).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Digitar no navegador" })).toHaveCount(0)
    const outcome = page.getByRole("alert").filter({ hasText: "Esta sessão do navegador está indisponível." })
    const handback = page.getByRole("button", { name: "Devolver para Lia" })
    for (const element of [outcome, handback]) {
      await expect(element).toBeInViewport({ ratio: 1 })
      // Inside the scrolling action log the result would need a second, hidden scroll to be found.
      expect(await element.evaluate((node) => node.closest(".browser-activity-log") === null)).toBe(true)
    }
    const takeoverBox = await takeover.boundingBox()
    const outcomeBox = await outcome.boundingBox()
    if (!takeoverBox || !outcomeBox) throw new Error("Missing takeover layout")
    expect(outcomeBox.y).toBeGreaterThan(takeoverBox.y)

    await page.getByRole("button", { name: "Devolver para Lia" }).click()
    await expect(page.getByRole("button", { name: "Devolver para Lia" })).toHaveCount(0)
    await expect(page.getByText("Esta sessão do navegador está indisponível.", { exact: false })).toHaveCount(0)
    const metadata = await requestFixture({ step: "metadata" })
    const tabs = (await metadata.json()) as { tabs: Array<{ tabId: string; state: string; heldByUser: boolean }> }
    expect(tabs.tabs).toHaveLength(1)
    expect(tabs.tabs[0]).toMatchObject({ tabId: restored.tabId, state: "unloaded", heldByUser: false })
  })
}
