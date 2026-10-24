import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"
import seed from "../../../sidecar/test/fixtures/ui-seed.json" with { type: "json" }
import { createWorkGoldenServer } from "./work-golden-server"

let server: Awaited<ReturnType<typeof createWorkGoldenServer>> | undefined
let releasePanel = () => {}

test.setTimeout(90_000)

test.afterEach(async () => {
  releasePanel()
  await server?.dispose()
  server = undefined
})

for (const width of [1440, 390]) {
  test(`a delayed bot panel preserves the conversation at ${width}px`, async ({ page }) => {
    const current = await createWorkGoldenServer()
    server = current
    await current.api("/bots", "POST", {
      name: "Lia",
      provider: seed.bots[0]?.provider,
      access: "read-only",
      approvals: "on-request",
    })
    await current.install(page)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    const requested = Promise.withResolvers<void>()
    const pending = Promise.withResolvers<void>()
    releasePanel = pending.resolve
    await page.route("**/assets/BotPanel-*.js", async (route) => {
      requested.resolve()
      await pending.promise
      await route.continue()
    })

    await page.goto(current.serverUrl)
    await expect(page.getByRole("textbox", { name: "Mensagem para Lia" })).toBeVisible()
    const evidence = process.env.TOURI_PANEL_LOADING_EVIDENCE
    if (evidence) {
      await mkdir(evidence, { recursive: true })
      await page.addStyleTag({ content: ".composer-model, .bot-model-line, .model-pill { visibility: hidden; }" })
      await page.screenshot({ path: join(evidence, `chat-initial-${width}.png`), animations: "disabled" })
    }
    await page.getByRole("button", { name: "Painel do bot", exact: true }).click()
    await requested.promise
    await expect(page.getByRole("status").filter({ hasText: "Carregando" })).toBeVisible()
    if (evidence) {
      await page.screenshot({ path: join(evidence, `panel-loading-${width}.png`), animations: "disabled" })
    }

    await expect(page.locator(".chat-panel")).toBeVisible()
    const audit = await new AxeBuilder({ page }).include("#bot-panel").analyze()
    expect(audit.violations).toEqual([])
    if (width === 390)
      await expect(page.getByRole("button", { name: "Fechar painel do bot", exact: true })).toBeFocused()
    await page.getByRole("button", { name: "Fechar painel do bot", exact: true }).click()
    await expect(page.getByRole("textbox", { name: "Mensagem para Lia" })).toBeVisible()
    releasePanel()
    await page.getByRole("button", { name: "Painel do bot", exact: true }).click()
    await expect(page.getByRole("complementary", { name: "Painel de Lia" })).toBeVisible()
    if (width === 390)
      await expect(page.getByRole("button", { name: "Fechar painel do bot", exact: true })).toBeFocused()
    if (evidence) {
      await page.screenshot({ path: join(evidence, `panel-ready-${width}.png`), animations: "disabled" })
    }
  })
}
