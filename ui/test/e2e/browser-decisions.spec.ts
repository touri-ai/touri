import { type ChildProcess, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { createInterface } from "node:readline"
import AxeBuilder from "@axe-core/playwright"
import { chromium, expect, test } from "@playwright/test"

test.describe.configure({ mode: "default" })
test.use({ video: "on" })
let child: ChildProcess
let endpoint = ""
const token = randomUUID()
const post = async (step: string, mode?: string) => {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ step, mode }),
    signal: AbortSignal.timeout(40_000),
  })
  expect(response.ok, response.ok ? "" : await response.text()).toBe(true)
  return response.json()
}

test.beforeAll(async () => {
  child = spawn("bun", [resolve("test/e2e/browser-decisions-server.ts")], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      TOURI_CHROME_BIN: chromium.executablePath(),
      TOURI_BROWSER_HEADLESS: "1",
      TOURI_DECISION_TEST_TOKEN: token,
    },
  })
  await new Promise<void>((accept, reject) => {
    const timeout = setTimeout(() => reject(new Error("Browser fixture did not start")), 20000)
    const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream })
    lines.on("line", (line) => {
      if (!line.startsWith("DECISION_FIXTURE:")) return
      endpoint = `http://127.0.0.1:${Number(line.split(":")[1])}`
      clearTimeout(timeout)
      accept()
    })
    child.once("exit", () => {
      clearTimeout(timeout)
      reject(new Error("Browser fixture exited"))
    })
    child.stderr?.on("data", (chunk) => process.stderr.write(chunk))
  })
})

test.afterAll(async () => {
  if (!child || child.exitCode !== null) return
  await new Promise<void>((done) => {
    child.once("exit", () => done())
    child.kill("SIGTERM")
  })
})

for (const theme of ["dark", "light"] as const) {
  test(`browser decisions: successful real-page choices and takeover (${theme})`, async ({ page }, info) => {
    test.setTimeout(60000)
    await post("open", "selected")
    await page.route("**/__browser-decision-fixture", async (route) => {
      const { step } = route.request().postDataJSON()
      await route.fulfill({ json: await post(step) })
    })
    await page.goto("/test/e2e/browser-decisions-harness.html")
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme
    }, theme)
    for (const step of ["destination", "option", "cabin", "calendar", "date", "submit"]) {
      const response = page.waitForResponse("**/__browser-decision-fixture")
      await page.getByRole("button", { name: step, exact: true }).click()
      const result = await (await response).json()
      expect(result.result.success).toBe(true)
      if (step === "submit") {
        expect(result.result.structured).toMatchObject({ status: "waiting_for_person" })
      }
      if (step === "option")
        expect(
          result.snapshot.elements.find((element: { name: string }) => element.name === "Destination primary")?.value,
        ).toBe("Lisboa, Portugal")
      if (step === "date") expect(result.snapshot.text).toContain("Departure date October 24")
    }
    await expect(page.getByText("Esta ação precisa de você. Assuma o controle da aba para continuar.")).toBeVisible()
    const security = await post("sensitive")
    expect(security.result.errorCode).toBe("TAB_HELD_BY_USER")
    expect(security.requestCount).toBe(4)
    for (const step of ["keyboard-enter", "keyboard-space"]) {
      const keyboard = await post(step)
      expect(keyboard.result.errorCode).toBe("TAB_HELD_BY_USER")
      expect(keyboard.requestCount).toBe(4)
    }
    const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()
    expect(accessibility.violations).toEqual([])
    const screenshot = await page.screenshot({ fullPage: true })
    await info.attach(`after-browser-decisions-${theme}`, { body: screenshot, contentType: "image/png" })
    if (process.env.TOURI_DECISION_SHOTS) {
      await mkdir(process.env.TOURI_DECISION_SHOTS, { recursive: true })
      await page.screenshot({
        path: resolve(process.env.TOURI_DECISION_SHOTS, `after-browser-decisions-${theme}.png`),
        fullPage: true,
      })
    }
  })
}

for (const mode of ["missing_key", "no_credit", "unavailable", "ask"] as const) {
  test(`browser decisions: ${mode} keeps the browser usable`, async ({ page }, info) => {
    test.setTimeout(60000)
    await post("open", mode)
    await page.route("**/__browser-decision-fixture", async (route) => {
      const { step } = route.request().postDataJSON()
      await route.fulfill({ json: await post(step) })
    })
    await page.goto("/test/e2e/browser-decisions-harness.html")
    const response = page.waitForResponse("**/__browser-decision-fixture")
    await page.getByRole("button", { name: "destination", exact: true }).click()
    const failed = await (await response).json()
    expect(failed.result.success).toBe(false)
    expect(failed.requestCount).toBe(mode === "missing_key" ? 0 : 1)
    const message =
      mode === "missing_key"
        ? /A ajuda nas escolhas está desativada/
        : mode === "no_credit"
          ? /está sem crédito/
          : mode === "ask"
            ? /Não foi possível escolher com segurança/
            : /assistente do navegador está indisponível/
    await expect(page.getByText(message).first()).toBeVisible()
    await expect(page.locator("body")).not.toContainText("synthetic-decision-key")
    const screenshot = await page.screenshot({ fullPage: true })
    await info.attach(`after-browser-${mode}`, { body: screenshot, contentType: "image/png" })
    if (process.env.TOURI_DECISION_SHOTS)
      await page.screenshot({
        path: resolve(process.env.TOURI_DECISION_SHOTS, `after-browser-${mode}.png`),
        fullPage: true,
      })

    const continued = page.waitForResponse("**/__browser-decision-fixture")
    await page.getByRole("button", { name: "exact", exact: true }).click()
    expect((await (await continued).json()).result.success).toBe(true)
  })
}

test("browser decisions: consent is off until explicitly selected", async ({ page }, info) => {
  await page.goto("/test/e2e/api-models-harness.html")
  await page.getByLabel("Chave de API").fill("fixture-private-key")
  await page.getByLabel("Identificador do modelo").fill("demo-model")
  await page.getByRole("button", { name: "Salvar modelo por API" }).click()
  await expect(page.getByLabel("Chave de API")).toHaveValue("")
  await page.getByText("Chave guardada no cofre · ••••••••").scrollIntoViewIfNeeded()
  const consent = page.getByRole("switch", { name: "Usar esta chave para ajudar nas escolhas do navegador" })
  const phase = process.env.TOURI_DECISION_PHASE ?? "after"
  if (process.env.TOURI_DECISION_SHOTS) {
    await mkdir(process.env.TOURI_DECISION_SHOTS, { recursive: true })
    await consent
      .locator("..")
      .screenshot({ path: resolve(process.env.TOURI_DECISION_SHOTS, `${phase}-browser-consent.png`) })
  }
  await expect(consent).not.toBeChecked()
  await consent.check()
  await expect(consent).toBeChecked()
  await consent.uncheck()
  await expect(consent).not.toBeChecked()
  await expect(page.locator("body")).not.toContainText("fixture-private-key")
  await info.attach("browser-consent", { body: await consent.locator("..").screenshot(), contentType: "image/png" })
})
