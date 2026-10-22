import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import AxeBuilder from "@axe-core/playwright"
import { test as base, expect } from "@playwright/test"

const test = base.extend<{ panelModule: { requested: Promise<void> } }>({
  panelModule: async ({ page }, use) => {
    const requested = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    await page.route("**/src/components/GroupPanel.tsx", async (route) => {
      requested.resolve()
      await release.promise
      await route.continue()
    })
    await use({ requested: requested.promise })
    release.resolve()
    await page.unrouteAll({ behavior: "wait" })
  },
})

const viewportWidths = [1440, 390]

viewportWidths.forEach((width) => {
  test(`closes the channel panel during module loading at ${width}px`, async ({ page, panelModule }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto("/test/e2e/groups-harness.html")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark", exact: true })).toBeVisible()
    if (width === 390) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    await page.getByRole("tab", { name: /^Work,/ }).click()
    await page.getByRole("button", { name: "Novo canal", exact: true }).click()
    const create = page.getByRole("dialog", { name: "Criar canal", exact: true })
    await create.getByRole("textbox", { name: "Nome do canal" }).fill("Produto")
    await create.getByRole("checkbox", { name: "mark", exact: true }).check()

    await expect(create.locator("..")).toHaveCSS("z-index", "1000")
    await create.getByRole("button", { name: "Personalizar", exact: true }).click()
    await expect(create.getByRole("radio", { name: "Cor Automática", exact: true })).toBeVisible()
    await create.getByRole("button", { name: "Personalizar", exact: true }).click()
    const evidence = process.env.TOURI_E2E_EVIDENCE_DIR
    if (evidence) {
      await mkdir(evidence, { recursive: true })
      await page.screenshot({ path: resolve(evidence, `channel-create-${width}.png`) })
    }
    await create.getByRole("button", { name: "Criar canal", exact: true }).click()
    await expect(page.getByRole("textbox", { name: "Mensagem para Produto", exact: true })).toBeVisible()

    const toggle = page.getByRole("button", { name: /^Membros do canal:/ })
    await toggle.click()
    await panelModule.requested
    const loading = page.getByRole("complementary", { name: "Carregando…" })
    await expect(loading).toBeVisible()
    if (evidence) {
      await mkdir(evidence, { recursive: true })
      await page.screenshot({ path: resolve(evidence, `loading-panel-${width}.png`) })
    }
    const close = loading.getByRole("button", { name: "Fechar painel do canal" })
    await expect(close).toBeVisible()
    if (width === 390) await expect(close).toBeFocused()
    const violations = (
      await new AxeBuilder({ page }).include(".group-panel").withTags(["wcag2a", "wcag2aa"]).analyze()
    ).violations
    expect(violations).toEqual([])
    await close.click()

    await expect(loading).toHaveCount(0)
    await expect(page.getByRole("textbox", { name: "Mensagem para Produto", exact: true })).toBeVisible()
    await expect(toggle).toBeFocused()
  })
})
