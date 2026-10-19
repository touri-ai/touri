import { expect, test } from "@playwright/test"

test.use({ channel: "chromium", timezoneId: "UTC" })

test("failed group turn explains that its conversation was removed", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" })
  await page.addInitScript(() => localStorage.setItem("touri.appearance.v1", "light"))
  await page.goto("/?mockScenario=group-context-missing")

  await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
  await page.getByRole("button", { name: /houve uma resposta depois/ }).click()
  const notice = page.getByRole("alert")
  await expect(notice).toContainText("O grupo ou a conversa não existe mais. Este turno não foi executado.")
  await expect(notice.getByRole("button", { name: "Tentar de novo" })).toHaveCount(0)
  if (process.env.TOURI_SCREENSHOT_DIR)
    await page.screenshot({
      path: `${process.env.TOURI_SCREENSHOT_DIR}/failed-group-turn.png`,
      animations: "disabled",
    })
})
