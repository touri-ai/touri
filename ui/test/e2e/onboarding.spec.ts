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
  test(`first-run ${device}: local start is one click and returning preserves the home`, async ({ page }, testInfo) => {
    const fixture = await start()
    await fixture.install(page, theme)
    await page.setViewportSize({ width, height })
    await page.goto(fixture.url)
    const welcome = page.getByRole("heading", { name: "Seus bots, perto de você" })
    await expect(welcome).toBeVisible()
    const welcomeMs = await page.evaluate(() => performance.getEntriesByName("onboarding-welcome")[0]?.startTime)
    expect(welcomeMs).toBeLessThan(300)
    await capture(page, testInfo, `${device}-welcome`)

    const started = performance.now()
    await page.getByRole("button", { name: /Começar neste computador/ }).click()
    await expect(page.getByRole("button", { name: "Criar meu primeiro bot" })).toBeVisible()
    const localStartMs = performance.now() - started
    await expect.poll(() => fixture.eventConnections).toBeGreaterThan(0)
    await capture(page, testInfo, `${device}-home`, ".onboarding-landing")
    await page.reload()
    await expect(page.getByRole("button", { name: "Criar meu primeiro bot" })).toBeVisible()
    await expect(welcome).toHaveCount(0)
    expect((await fixture.api("/onboarding")).completed).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.getByRole("button", { name: "Usar um servidor touri", exact: true }).click()
    await expect(page.getByRole("region", { name: "Usar um servidor touri", exact: true })).toBeVisible()
    await capture(page, testInfo, `${device}-settings`, ".server-mode-settings")
    await page.getByRole("button", { name: "Gerar código para outro aparelho" }).click()
    await expect(page.locator(".setup-pair-code")).toBeVisible()
    await capture(page, testInfo, `${device}-settings-code`, ".server-mode-settings")
    console.log(JSON.stringify({ device, welcomeMs, localStartMs }))
  })

  test(`first-run ${device}: server chooser, discovery, pairing errors and real code consumption`, async ({
    page,
  }, testInfo) => {
    const fixture = await start()
    await fixture.install(page, theme)
    await page.setViewportSize({ width, height })
    await page.goto(fixture.url)
    await page.getByRole("button", { name: /Usar meu servidor/ }).click()
    await expect(page.getByRole("heading", { name: "Meu servidor" })).toBeFocused()
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
    await page.getByRole("button", { name: /Usar meu servidor/ }).click()
    await page.getByRole("button", { name: /Rodar neste/ }).click()
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
