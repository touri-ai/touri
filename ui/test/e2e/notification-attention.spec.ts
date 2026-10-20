import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@playwright/test"

test.use({ channel: "chromium", reducedMotion: "reduce" })

for (const theme of ["dark", "light"] as const) {
  for (const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "phone", width: 390, height: 844 },
  ]) {
    test(`shows the needs-you bar on ${viewport.name} in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await page.emulateMedia({ reducedMotion: "reduce" })
      await page.addInitScript((appearance) => localStorage.setItem("touri.appearance.v1", appearance), theme)
      await page.goto("/test/e2e/notification-attention-harness.html")
      await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme)

      if (viewport.name === "phone") await page.getByRole("button", { name: "Abrir menu" }).click()
      const bar = page.getByRole("button", { name: "Abrir pendência de onb" }).first()
      await expect(bar).toBeVisible()
      await expect(bar).toContainText("Precisa de você")
      await expect(bar).toContainText("onb precisa da sua resposta")

      const output = process.env.NOTIFICATION_ATTENTION_CAPTURE ?? testInfo.outputDir
      mkdirSync(output, { recursive: true })
      const screenshot = join(output, `${viewport.name}-${theme}.png`)
      await page.locator(".bot-sidebar").screenshot({ path: screenshot, animations: "disabled" })
      await testInfo.attach(`needs-you ${viewport.name} ${theme}`, { path: screenshot, contentType: "image/png" })

      await bar.click()
      const row = page.getByTestId("notification-row").filter({ hasText: "Qual canal deve receber a campanha?" })
      await expect(row).toBeFocused()
      const focusedCard = join(output, `card-${viewport.name}-${theme}.png`)
      await page.getByRole("region", { name: "Central de notificações" }).screenshot({ path: focusedCard })
      await testInfo.attach(`focused card ${viewport.name} ${theme}`, { path: focusedCard, contentType: "image/png" })
    })
  }
}

test("closes phone navigation and focuses the pending approval", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/test/e2e/notification-attention-harness.html?pending=approval")
  await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
  await page.getByRole("button", { name: "Abrir menu" }).click()

  await page.getByRole("button", { name: /^Abrir pendência de / }).click()

  await expect(page.getByRole("dialog", { name: "Barra lateral", exact: true })).not.toBeVisible()
  await expect(page.locator('[data-approval-id="preview-approval"]')).toBeFocused()
  const output = process.env.NOTIFICATION_ATTENTION_CAPTURE ?? testInfo.outputDir
  mkdirSync(output, { recursive: true })
  const screenshot = join(output, "approval-phone.png")
  await page.locator('[data-approval-id="preview-approval"]').screenshot({ path: screenshot })
  await testInfo.attach("focused phone approval", { path: screenshot, contentType: "image/png" })
})
