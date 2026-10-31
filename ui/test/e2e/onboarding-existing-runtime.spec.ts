import { join } from "node:path"
import { test as base, expect } from "@playwright/test"
import { createServerModeFixture } from "./server-mode-fixture"

type Server = Awaited<ReturnType<typeof createServerModeFixture>>
const test = base.extend<{ server: Server }>({
  // biome-ignore lint/correctness/noEmptyPattern: The fixture runner discovers dependencies from this pattern.
  server: async ({}, use) => use(await createServerModeFixture({ directCli: true })),
})

test.afterEach(async ({ server }) => server.dispose())

for (const width of [1440, 390]) {
  test(`an existing local workspace opens without the optional onboarding API at ${width}px`, async ({
    page,
    server,
  }, info) => {
    const { settings } = await server.api("/settings")
    await server.api("/bots", "POST", { name: "Brisa fictícia", provider: settings.defaultProvider })
    await server.install(page)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    const status = page.waitForResponse((response) => response.url().endsWith("/api/v1/onboarding"))

    const started = performance.now()
    await page.goto(server.relayUrl)

    expect((await status).status()).toBe(404)
    const composer = page.getByRole("textbox", { name: "Mensagem para Brisa fictícia", exact: true })
    const phase = process.env.TOURI_ONBOARDING_PHASE ?? "after"
    const capture = async () => {
      const name = `existing-workspace-${phase}-${width}.png`
      const path = join(process.env.TOURI_ONBOARDING_EVIDENCE_DIR ?? info.outputDir, name)
      await info.attach(name, {
        body: await page.screenshot({
          path,
          animations: "disabled",
          mask: [page.locator(".user-chip"), page.locator(".composer-model")],
        }),
        contentType: "image/png",
      })
    }
    await expect(composer)
      .toBeVisible()
      .catch(async (error: unknown) => {
        await capture()
        throw error
      })
    console.log(JSON.stringify({ width, workspaceReadyMs: performance.now() - started }))
    await capture()
    await composer.fill("Continuar meu trabalho fictício.")
    expect(await page.evaluate(() => localStorage.getItem("touri.onboarding.completed.v1"))).toBeNull()
    await expect(page.getByRole("heading", { name: "Seus bots, perto de você" })).toHaveCount(0)

    const reopened = page.waitForResponse((response) => response.url().endsWith("/api/v1/onboarding"))
    await page.evaluate(() => window.dispatchEvent(new Event("touri-open-onboarding")))
    expect((await reopened).status()).toBe(404)
    await page.getByRole("button", { name: /Conectar ao meu servidor/ }).click()
    await expect(page.getByRole("textbox", { name: "Endereço do servidor", exact: true })).toBeVisible()
  })
}
