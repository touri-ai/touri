import AxeBuilder from "@axe-core/playwright"
import { expect, type Page, test } from "@playwright/test"
import type { ImportReport } from "@touri/contracts"

const statusUrl = "**/api/v1/imports/import-fixture"
const sourceWarning = "Unknown synthetic warning /archive/synthetic-id"
const translatedWarning =
  "O arquivo de origem contém um item que não pôde ser importado. Confira a origem e tente novamente."

test("legacy import waits for its report before showing real counts and cut-over", async ({ page }) => {
  await openReview(page)

  await page.getByRole("button", { name: "Importar agora", exact: true }).click()
  await expect(page.getByRole("button", { name: "Importar agora", exact: true })).toBeDisabled()
  await expect(page.getByRole("heading", { name: "Importação concluída", exact: true })).toHaveCount(0)
  await expect(page.locator(".success-card")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Voltar", exact: true })).toBeDisabled()

  await completeImport(page, "succeeded", getReport(false))

  await expect(page.getByRole("heading", { name: "Importação concluída", exact: true })).toBeVisible()
  await expect(page.locator(".success-card")).toContainText("42 mensagens")
  await expect(page.locator(".success-card")).toContainText("7 conversas")
})

test("legacy dry run stays in review and shows the completed report", async ({ page }) => {
  await openReview(page)

  await page.getByRole("button", { name: "Simular importação", exact: true }).click()
  await expect(page.getByRole("button", { name: "Importar agora", exact: true })).toBeDisabled()
  await expect(page.locator(".import-report")).toHaveCount(0)

  await completeImport(page, "succeeded", getReport(true))

  await expect(page.locator(".import-report")).toContainText("42")
  await expect(page.locator(".import-report")).toContainText("7")
  await expect(page.getByRole("button", { name: "Importar agora", exact: true })).toBeEnabled()
  await expect(page.getByRole("heading", { name: "Importação concluída", exact: true })).toHaveCount(0)
})

test("legacy import failure keeps its warnings visible and permits retry", async ({ page }) => {
  await openReview(page)

  await page.getByRole("button", { name: "Importar agora", exact: true }).click()
  await completeImport(page, "failed", getReport(false))

  await expect(page.getByRole("alert")).toBeVisible()
  await expect(page.getByRole("alert")).toContainText(translatedWarning)
  await expect(page.getByRole("alert")).not.toContainText(sourceWarning)
  await expect(page.locator(".success-card")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Tentar de novo", exact: true })).toBeEnabled()

  await completeImport(page, "succeeded", getReport(false))
  await page.getByRole("button", { name: "Tentar de novo", exact: true }).click()

  await expect(page.getByRole("heading", { name: "Importação concluída", exact: true })).toBeVisible()
  await expect(page.locator(".success-card")).toContainText("42 mensagens")
  await expect(page.locator(".import-report")).toContainText(translatedWarning)
  await expect(page.locator(".import-report")).not.toContainText(sourceWarning)
})

for (const width of [1440, 390]) {
  test(`legacy import warning recovery at ${width}px`, async ({ page }, info) => {
    test.setTimeout(90_000)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" })
    await openReview(page)
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "light"
    })
    const report = {
      ...getReport(true),
      warnings: [
        "No cwd mapping for synthetic-bot; using /archive/private-id",
        "Selected bot not found: synthetic-one",
        "Selected bot not found: synthetic-two",
        "Attachment not found in allowlisted attachments/: foto.png",
        "Failed import staging retained at /archive/private-id until 2026-11-08T02:24:34.375Z",
      ],
    }
    const capture = async (state: string) => {
      const dialog = page.locator(".modal-card")
      await expect(dialog).not.toContainText(/private-id|synthetic-one|synthetic-two|2026-11|temporários/)
      expect(await dialog.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(false)
      const audit = await new AxeBuilder({ page })
        .include(".modal-card")
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
      expect(audit.violations).toEqual([])
      if (process.env.TOURI_IMPORT_REVIEW_SCREENSHOTS) {
        const filename = `${width}-light-${state}.png`
        const directory = process.env.TOURI_E2E_EVIDENCE_DIR ?? process.env.TOURI_E2E_OUTPUT_DIR
        const path = directory ? `${directory}/${filename}` : info.outputPath(filename)
        await page.screenshot({ path, animations: "disabled" })
      }
    }

    await completeImport(page, "succeeded", report)
    await page.getByRole("button", { name: "Simular importação", exact: true }).click()
    await expect(page.locator(".import-report")).toContainText("2 ocorrências")
    await expect(page.locator(".import-report")).toContainText("1 anexo não foi copiado: foto.png")
    await expect(page.locator(".import-report")).toContainText("configurações de cada bot")
    await page.locator(".import-report").scrollIntoViewIfNeeded()
    await capture("report")

    await completeImport(page, "failed", {
      ...report,
      warnings: [...report.warnings, "Source messages.db must be a regular file inside the source root"],
    })
    await page.getByRole("button", { name: "Importar agora", exact: true }).click()
    await expect(page.getByRole("alert")).toContainText("Não encontramos o histórico nesta pasta")
    await expect(page.getByRole("button", { name: "Corrigir caminho", exact: true })).toHaveClass(/button-dark/)
    await expect(page.getByRole("button", { name: "Tentar de novo", exact: true })).toHaveClass(/button-quiet/)
    await capture("failure")

    await page.getByRole("button", { name: "Corrigir caminho", exact: true }).click()
    await expect(page.locator("#legacy-root")).toBeFocused()
    await expect(page.locator("#legacy-root")).toHaveValue("/archive")
    await capture("source")

    await page.getByRole("button", { name: "Continuar", exact: true }).click()
    await page.getByRole("button", { name: "Revisar importação", exact: true }).click()
    await completeImport(page, "succeeded", { ...report, dryRun: false })
    await page.getByRole("button", { name: "Importar agora", exact: true }).click()
    await expect(page.locator(".success-card")).toBeVisible()
    await page.locator(".import-report").scrollIntoViewIfNeeded()
    await capture("success")
  })
}

const openReview = async (page: Page): Promise<void> => {
  await page.route("**/api/v1/imports/legacy", (route) =>
    route.fulfill({ status: 202, json: { importId: "import-fixture" } }),
  )
  await page.route(statusUrl, (route) => route.fulfill({ json: { status: "running", report: null } }))
  await page.goto("/test/e2e/legacy-import-wizard-harness.html")
  await page.locator("#legacy-root").fill("/archive")
  await page.getByRole("button", { name: "Continuar", exact: true }).click()
  await page.getByRole("button", { name: "Revisar importação", exact: true }).click()
}

const completeImport = async (page: Page, status: "succeeded" | "failed", report: ImportReport): Promise<void> => {
  await page.unroute(statusUrl)
  await page.route(statusUrl, (route) => route.fulfill({ json: { status, report } }))
}

const getReport = (dryRun: boolean): ImportReport => ({
  importId: "import-fixture",
  origin: "synthetic-archive",
  dryRun,
  bots: getCounts(1),
  threads: getCounts(7),
  messages: getCounts(42),
  routines: getCounts(0),
  attachments: getCounts(0),
  codexSessions: getCounts(0),
  memoryFiles: getCounts(0),
  droppedMessageKinds: {},
  warnings: [sourceWarning],
})

const getCounts = (created: number) => ({ created, updated: 0, unchanged: 0, skipped: 0 })
