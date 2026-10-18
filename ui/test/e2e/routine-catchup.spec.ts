import { expect, test } from "@playwright/test"
import { showBotRoutines } from "./home-navigation"

test.use({ channel: "chromium" })
test.setTimeout(90_000)

test("routine history distinguishes scheduler lateness from downtime", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/test/e2e/routine-catchup-harness.html")
  await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()

  await showBotRoutines(page)
  await page.getByText("Histórico de execuções", { exact: true }).click()

  await expect(
    page.getByText("Rotina “Daily brief” não executada: o atraso ultrapassou a janela de recuperação.", {
      exact: true,
    }),
  ).toBeVisible()
  await expect(
    page.getByText("Rotina “Daily brief” não executada: o touri não estava em execução no horário agendado.", {
      exact: true,
    }),
  ).toBeVisible()
  await expect(page.getByText("Recuperação após indisponibilidade", { exact: true })).toHaveCount(0)
  await page.locator(".routine-run-history").scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath("routine-catchup.png"), animations: "disabled" })
})
