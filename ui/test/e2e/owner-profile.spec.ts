import { expect, type Page, test } from "@playwright/test"

test.setTimeout(60_000)

const before = process.env.OWNER_PROFILE_PHASE === "before"
const evidence = process.env.OWNER_PROFILE_EVIDENCE
const photo = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
  "base64",
)

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`owner profile Work and direct chat ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.goto("/test/e2e/owner-profile-harness.html")
      await expect(page.getByText("Vamos revisar a entrega de hoje.", { exact: true })).toBeVisible()
      await navigation(page, width)
      await page.getByRole("tab", { name: /^Work,/ }).click()
      await page.getByRole("button", { name: /^Engenharia/ }).click()
      const own = page.locator('[data-message-author="own"]').first()
      await expect(own).toBeVisible()
      if (!before) {
        await expect(own).toHaveAttribute("data-work-message", "true")
        const botRow = page.locator('[data-message-author="bot"]').first()
        const ownerBounds = await own.locator(".message-body").boundingBox()
        const botBounds = await botRow.locator(".message-body").boundingBox()
        expect(ownerBounds?.x).toBe(botBounds?.x)
        await expect(botRow.locator(".message-meta time")).toHaveCSS("opacity", "1")
        expect(
          await own.locator(".message-body").evaluate((element) => getComputedStyle(element).backgroundColor),
        ).toBe("rgba(0, 0, 0, 0)")
        await expect(own.locator(".message-meta")).toContainText("Você")
      }
      if (evidence)
        await page.screenshot({ path: `${evidence}/${before ? "before" : "after"}-work-${width}-${theme}.png` })
      if (!before) {
        await openProfile(page, width)
        await page.getByLabel("Nome do perfil", { exact: true }).fill("Pessoa Teste")
        await page
          .getByLabel("Enviar foto do perfil")
          .setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: photo })
        await expect(page.getByLabel("Prévia do recorte da foto")).toBeVisible()
        await page.getByLabel("Zoom", { exact: true }).fill("1.5")
        if (evidence) await page.screenshot({ path: `${evidence}/after-profile-${width}-${theme}.png` })
        await page.getByRole("button", { name: "Usar foto recortada" }).click()
        await saveProfile(page)
        await expect(own.locator(".message-meta")).toContainText("Pessoa Teste")
        await expect(own.locator(".message-avatar img")).toBeVisible()
        if (evidence) await page.screenshot({ path: `${evidence}/after-photo-work-${width}-${theme}.png` })
        await openProfile(page, width)
        await page.getByRole("button", { name: "Remover avatar do perfil" }).click()
        await saveProfile(page)
        await expect(own.locator(".message-avatar")).toHaveText("PT")
        await expect(own.locator(".message-avatar img")).toHaveCount(0)
        await openProfile(page, width)
        await page.getByRole("button", { name: "Sortear", exact: true }).click()
        await saveProfile(page)
        await expect(own.locator(".message-avatar .tb-avatar")).toBeVisible()
      }
      await navigation(page, width)
      await page.getByRole("tab", { name: /^Bots,/ }).click()
      if (width === 390) await page.getByRole("button", { name: "Fechar menu", exact: true }).click()
      await expect(page.getByText("Vamos revisar a entrega de hoje.", { exact: true })).toBeVisible()
      if (!before) {
        await expect(page.locator("[data-work-message]")).toHaveCount(0)
        await expect(page.locator('[data-message-author="own"] .message-meta')).toHaveCount(0)
      }
      if (evidence)
        await page.screenshot({ path: `${evidence}/${before ? "before" : "after"}-direct-${width}-${theme}.png` })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    })
  }

async function navigation(page: Page, width: number) {
  if (width === 390 && !(await page.getByRole("tab", { name: /^Work,/ }).isVisible()))
    await page.getByRole("button", { name: "Abrir menu" }).click()
}
async function openProfile(page: Page, width: number) {
  await navigation(page, width)
  await page.getByRole("button", { name: "Você", exact: true }).click()
  await page.getByRole("tab", { name: "Perfil", exact: true }).click()
}
async function saveProfile(page: Page) {
  await page.getByRole("button", { name: "Salvar preferências", exact: true }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
}
