import AxeBuilder from "@axe-core/playwright"
import { test as base, expect } from "@playwright/test"
import { openGlobalPage } from "./home-navigation"
import { createServerModeFixture } from "./server-mode-fixture"

type ImportServer = Awaited<ReturnType<typeof createServerModeFixture>>
const test = base.extend<{ server: ImportServer }>({
  // biome-ignore lint/correctness/noEmptyPattern: The isolated server fixture has no dependencies.
  server: async ({}, use) => use(await createServerModeFixture()),
})

test.setTimeout(180_000)
test.afterEach(async ({ server }) => server.dispose())

for (const width of [1440, 390]) {
  for (const theme of ["dark", "light"] as const) {
    test(`legacy import app ${width} ${theme}`, async ({ page, server }, info) => {
      const getCounts = (created: number) => ({ created, updated: 0, unchanged: 0, skipped: 0 })
      const report = {
        importId: "import-fixture",
        origin: "synthetic-archive",
        dryRun: false,
        bots: getCounts(1),
        threads: getCounts(7),
        messages: getCounts(42),
        routines: getCounts(0),
        attachments: getCounts(0),
        codexSessions: getCounts(0),
        memoryFiles: getCounts(0),
        droppedMessageKinds: {},
        warnings: [],
      }
      const capture = async (state: string) => {
        await expect(page.getByRole("dialog", { name: "Importar seus bots", exact: true })).toBeVisible()
        await page.screenshot({ path: info.outputPath(`${width}-${theme}-${state}.png`), animations: "disabled" })
        const audit = await new AxeBuilder({ page })
          .include(".modal-card")
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze()
        expect(audit.violations).toEqual([])
        const overflow = await page
          .locator(".modal-card")
          .evaluate((element) => element.scrollWidth > element.clientWidth)
        expect(overflow).toBe(false)
        if (width !== 390) return

        const wrappedWords = await page.locator(".wizard-active .wizard-step-label").evaluate((label) => {
          const text = label.firstChild
          if (!text) throw new Error("The current import step has no label")

          return Array.from((text.textContent ?? "").matchAll(/\S+/g)).flatMap((word) => {
            const range = document.createRange()
            range.setStart(text, word.index)
            range.setEnd(text, word.index + word[0].length)

            return range.getClientRects().length > 1 ? [word[0]] : []
          })
        })
        expect(wrappedWords).toEqual([])
      }
      await server.api("/bots", "POST", { name: "Arquivo exemplo", provider: "codex" })
      await server.install(page)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await page.route("**/api/v1/imports/legacy", (route) =>
        route.fulfill({ status: 202, json: { importId: "import-fixture" } }),
      )
      await page.route("**/api/v1/imports/import-fixture", (route) =>
        route.fulfill({ json: { status: "running", report: null } }),
      )
      await page.goto(server.relayUrl)
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value
      }, theme)
      const drawer = page.getByRole("button", { name: "Abrir menu", exact: true })
      if (width === 390) await drawer.click()
      await openGlobalPage(page, "Importar")
      await capture("source")
      await page.locator("#legacy-root").fill("/archive")
      await page.getByRole("button", { name: "Continuar", exact: true }).click()
      await capture("choose")
      await page.getByRole("button", { name: "Revisar importação", exact: true }).click()
      await capture("review")
      await page.getByRole("button", { name: "Simular importação", exact: true }).click()
      await capture("running")
      await page.unroute("**/api/v1/imports/import-fixture")
      await page.route("**/api/v1/imports/import-fixture", (route) =>
        route.fulfill({ json: { status: "succeeded", report: { ...report, dryRun: true } } }),
      )
      await expect(page.locator(".import-report")).toBeVisible()
      const grid = page.locator(".import-report-grid")
      await expect(grid.locator("dd")).toHaveText(["1", "7", "42", "0"])
      await expect(grid).toHaveCSS("display", "grid")
      await capture("dry-run")
      const warnings = Array.from({ length: 100 }, (_, index) => `Arquivo sintético ${index + 1} indisponível.`)

      await page.unroute("**/api/v1/imports/import-fixture")
      await page.route("**/api/v1/imports/import-fixture", (route) =>
        route.fulfill({
          json: { status: "failed", report: { ...report, warnings } },
        }),
      )
      await page.getByRole("button", { name: "Importar agora", exact: true }).click()
      await expect(page.getByRole("alert")).toBeVisible()
      await expect(page.getByRole("button", { name: "Importar agora", exact: true })).toHaveCount(0)
      const alert = page.getByRole("alert")
      await expect(alert).toContainText("Arquivo sintético 100 indisponível.")

      await page.getByRole("region", { name: "Detalhes da importação" }).focus()
      await page.keyboard.press("End")

      await expect(grid).toBeInViewport()

      await alert.focus()
      await page.keyboard.press("End")

      await expect(alert.getByText("Arquivo sintético 100 indisponível.", { exact: true })).toBeInViewport()
      await expect(page.getByRole("button", { name: "Tentar de novo", exact: true })).toBeInViewport()

      await page.keyboard.press("Home")
      await expect(alert.getByText("Arquivo sintético 1 indisponível.", { exact: true })).toBeInViewport()
      await capture("failure")
      await page.unroute("**/api/v1/imports/import-fixture")
      await page.route("**/api/v1/imports/import-fixture", (route) =>
        route.fulfill({ json: { status: "succeeded", report } }),
      )
      await page.getByRole("button", { name: "Tentar de novo", exact: true }).click()
      await expect(page.locator(".success-card")).toBeVisible()
      await capture("success")
      await page.getByRole("button", { name: "Ver etapas da migração", exact: true }).click()
      await capture("checklist")
    })
  }
}
