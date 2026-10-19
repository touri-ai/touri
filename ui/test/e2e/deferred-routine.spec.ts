import { expect, test } from "@playwright/test"

const viewports = [
  { name: "desktop", width: 1100, height: 800 },
  { name: "phone", width: 390, height: 800 },
]

for (const colorScheme of ["light", "dark"] as const) {
  for (const viewport of viewports) {
    test(`a postponed routine does not ask for the person (${viewport.name}, ${colorScheme})`, async ({
      page,
    }, info) => {
      await page.addInitScript((theme) => localStorage.setItem("touri.appearance.v1", theme), colorScheme)
      await page.emulateMedia({ reducedMotion: "reduce" })
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await page.goto("/test/e2e/deferred-routine-harness.html")
      const screenshot = info.outputPath(`deferred-routine-${viewport.name}-${colorScheme}.png`)
      await page.waitForTimeout(800)
      await page.screenshot({ path: screenshot, animations: "disabled" })
      await info.attach(`deferred routine ${viewport.name} ${colorScheme}`, {
        path: screenshot,
        contentType: "image/png",
      })
      await expect(page.getByText(/revise a tarefa interrompida/)).toHaveCount(0)
    })
  }
}
