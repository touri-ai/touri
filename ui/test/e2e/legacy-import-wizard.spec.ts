import { expect, type Page, test } from "@playwright/test"
import type { ImportReport } from "@touri/contracts"

const statusUrl = "**/api/v1/imports/import-fixture"

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
  await expect(page.getByRole("alert")).toContainText("Arquivo sintético indisponível.")
  await expect(page.locator(".success-card")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Tentar de novo", exact: true })).toBeEnabled()

  await completeImport(page, "succeeded", getReport(false))
  await page.getByRole("button", { name: "Tentar de novo", exact: true }).click()

  await expect(page.getByRole("heading", { name: "Importação concluída", exact: true })).toBeVisible()
  await expect(page.locator(".success-card")).toContainText("42 mensagens")
})

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
  warnings: ["Arquivo sintético indisponível."],
})

const getCounts = (created: number) => ({ created, updated: 0, unchanged: 0, skipped: 0 })
