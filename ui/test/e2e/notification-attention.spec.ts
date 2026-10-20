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

      if (viewport.name === "phone") await page.getByRole("button", { name: "Abrir menu" }).click()
      const bar = page.getByRole("button", { name: "Abrir pendência de onb" }).first()
      await expect(bar).toBeVisible()
      await expect(bar).toContainText("Precisa de você")
      await expect(bar).toContainText("onb precisa da sua resposta")

      const output = process.env.NOTIFICATION_ATTENTION_CAPTURE ?? testInfo.outputDir
      mkdirSync(output, { recursive: true })
      const screenshot = join(output, `${viewport.name}-${theme}.png`)
      await page.screenshot({ path: screenshot, animations: "disabled" })
      await testInfo.attach(`needs-you ${viewport.name} ${theme}`, { path: screenshot, contentType: "image/png" })

      await bar.click()
      const row = page.getByTestId("notification-row").filter({ hasText: "Qual canal deve receber a campanha?" })
      await expect(row).toBeFocused()
    })
  }
}
