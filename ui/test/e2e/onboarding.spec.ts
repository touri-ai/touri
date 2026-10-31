import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import AxeBuilder from "@axe-core/playwright"
import { expect, type Page, type TestInfo, test } from "@playwright/test"
import { createOnboardingFixture } from "./onboarding-fixture"

test.setTimeout(120_000)
const fixtures: Array<Awaited<ReturnType<typeof createOnboardingFixture>>> = []
test.afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
})
const start = async () => {
  const fixture = await createOnboardingFixture()
  fixtures.push(fixture)
  return fixture
}

for (const [device, width, height, theme] of [
  ["desktop", 1440, 900, "light"],
  ["phone", 390, 844, "light"],
  ["desktop-dark", 1440, 900, "dark"],
  ["phone-dark", 390, 844, "dark"],
] as const) {
  test(`first-run ${device}: local setup keeps answers and access opt-in`, async ({ page }) => {
    const fixture = await start()
    await fixture.install(page, theme)
    await page.setViewportSize({ width, height })
    await page.goto(fixture.url)
    await expect(page.getByRole("heading", { name: "Seu time e seus agentes, no mesmo chat" })).toBeVisible()

    await page.getByRole("button", { name: /^Começar/ }).click()
    await page.getByRole("button", { name: /Este (Mac|PC)/ }).click()
    await page.getByRole("textbox", { name: "Nome", exact: true }).fill("Equipe exemplo")
    await page.getByRole("button", { name: /^Continuar/ }).click()
    await page.keyboard.press("Escape")
    await expect(page.getByRole("textbox", { name: "Nome", exact: true })).toHaveValue("Equipe exemplo")
    await page.getByRole("button", { name: /^Continuar/ }).click()
    await page.getByRole("button", { name: "Pular" }).click()
    await page.getByRole("button", { name: "Pular" }).click()

    await expect(page.getByRole("heading", { name: "O que seus agentes podem usar?" })).toBeVisible()
    await expect(page.getByRole("checkbox", { name: /Comandos sem aprovação/ })).not.toBeChecked()
    expect((await fixture.api("/onboarding")).completed).toBe(false)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })

  test(`first-run ${device}: server chooser, discovery, pairing errors and real code consumption`, async ({
    page,
  }, testInfo) => {
    const fixture = await start()
    await fixture.install(page, theme)
    await page.setViewportSize({ width, height })
    await page.goto(fixture.url)
    await page.evaluate(() => window.dispatchEvent(new Event("touri-open-onboarding")))
    await expect(page.getByRole("heading", { name: "Onde seus agentes vão morar?" })).toBeFocused()
    await capture(page, testInfo, `${device}-chooser`)
    await page.getByRole("button", { name: /Conectar ao meu servidor/ }).click()
    await expect(page.getByRole("button", { name: "Usar studio.example.ts.net" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Usar Este computador" })).toBeVisible()
    await capture(page, testInfo, `${device}-discovery`)
    await page.getByRole("button", { name: "Usar studio.example.ts.net" }).click()
    await expect(page.getByLabel("Endereço do servidor")).toHaveValue("https://studio.example.ts.net:8445")
    await page.getByRole("button", { name: "← Voltar" }).click()
    await page.getByLabel("Endereço do servidor").fill("http://insecure.example")
    await page.getByRole("button", { name: "Conectar ao servidor" }).click()
    await expect(page.getByRole("alert")).toContainText("HTTPS")
    await page.getByLabel("Endereço do servidor").fill(fixture.base)
    await page.getByRole("button", { name: "Conectar ao servidor" }).click()
    await page.getByLabel("Código de pareamento").fill("WRONG-CODE")
    await page.getByRole("button", { name: "Parear e continuar" }).click()
    await expect(page.getByRole("alert")).toContainText("Gere outro código")
    await expect(page.getByLabel("Código de pareamento")).toHaveValue("")
    const pairing = { code: await fixture.getCode() }
    await page.getByLabel("Código de pareamento").fill(pairing.code)
    await capture(page, testInfo, `${device}-pairing`)
    await page.getByRole("button", { name: "Parear e continuar" }).click()
    await expect(page.getByRole("button", { name: "Criar meu primeiro bot" })).toBeVisible()
    expect(fixture.commands).toContain("server_mode_pair")
    const spent = await fetch(`${fixture.base}/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: pairing.code, client: true, name: "Test device" }),
    })
    expect(spent.status).toBe(401)
  })

  test(`first-run ${device}: run here saves identity and enables private phone access`, async ({ page }, testInfo) => {
    const fixture = await start()
    await fixture.install(page, theme)
    await page.setViewportSize({ width, height })
    await page.goto(fixture.url)
    await page.evaluate(() => window.dispatchEvent(new Event("touri-open-onboarding")))
    await page.getByRole("button", { name: /Este (Mac|PC)/ }).click()
    await page.getByLabel("Seu nome").fill("Pessoa Exemplo")
    await page.getByLabel("Seu email").fill("person@example.com")
    await expect(page.getByRole("switch")).toBeEnabled()
    await page.getByRole("switch").check()
    await capture(page, testInfo, `${device}-run-here`)
    await page.getByRole("button", { name: "Começar", exact: true }).scrollIntoViewIfNeeded()
    await capture(page, testInfo, `${device}-run-here-end`)
    await page.getByRole("button", { name: "Começar", exact: true }).click()
    await expect(page.getByRole("heading", { name: "Pronto para acessar de outro aparelho" })).toBeVisible()
    await expect(page.getByText("https://local.example.ts.net:8445/")).toBeVisible()
    await capture(page, testInfo, `${device}-access`)
    await page.getByRole("button", { name: "Abrir meu espaço" }).click()
    await expect(page.getByRole("button", { name: "Criar meu primeiro bot" })).toBeVisible()
    const status = await fixture.api("/onboarding")
    const health = await fixture.api("/health")
    console.log(JSON.stringify({ device, eventLoop: health.eventLoop }))
    expect(status.remoteUrl).toBe("https://local.example.ts.net:8445/")
  })
}

const getScreenshotPath = async (name: string) => {
  const directory = process.env.TOURI_E2E_EVIDENCE_DIR ?? resolve(import.meta.dirname, "../../../docs/qa/onboarding")
  await mkdir(directory, { recursive: true })
  return join(directory, `${name}.png`)
}

const capture = async (page: Page, testInfo: TestInfo, name: string, selector = ".setup-card") => {
  if (await page.locator(selector).count()) {
    const accessibility = await new AxeBuilder({ page }).include(selector).analyze()
    expect(accessibility.violations).toEqual([])
    const overflow = await page.locator(selector).evaluate((element) => element.scrollWidth - element.clientWidth)
    expect(overflow).toBeLessThanOrEqual(1)
  }
  await testInfo.attach(name, {
    body: await page.screenshot({ path: await getScreenshotPath(name), mask: [page.locator(".setup-pair-code")] }),
    contentType: "image/png",
  })
}
