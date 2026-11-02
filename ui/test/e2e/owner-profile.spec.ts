import AxeBuilder from "@axe-core/playwright"
import { expect, type Page, test } from "@playwright/test"

test.setTimeout(60_000)
test.use({ reducedMotion: "reduce" })

const before = process.env.OWNER_PROFILE_PHASE === "before"
const evidence = process.env.OWNER_PROFILE_EVIDENCE
const photoEvidence = process.env.OWNER_PHOTO_EVIDENCE
const photoPhase = process.env.OWNER_PHOTO_PHASE ?? "after"

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`owner profile Work and direct chat ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.goto("/test/e2e/owner-profile-harness.html")
      await expect(page.getByText(/@.+ vamos revisar a entrega de hoje\./)).toBeVisible()
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
        await page.screenshot({
          animations: "disabled",
          path: `${evidence}/${before ? "before" : "after"}-work-${width}-${theme}.png`,
        })
      if (evidence) {
        await navigation(page, width)
        await page.locator(".user-chip").click()
        await page.getByRole("tab", { name: "Aparência", exact: true }).click()
        await page.screenshot({
          animations: "disabled",
          path: `${evidence}/${before ? "before" : "after"}-preferences-${width}-${theme}.png`,
        })
        await page.getByRole("button", { name: "Fechar diálogo", exact: true }).click()
        await expect(page.getByRole("dialog")).toHaveCount(0)
      }
      if (!before) {
        const conversation = await new AxeBuilder({ page }).include(".chat-message-list").analyze()
        expect(conversation.violations).toEqual([])
        await openProfile(page, width)
        await page.getByLabel("Nome do perfil", { exact: true }).fill("Pessoa Teste")
        const photo = await getPhoto(page)
        await page
          .getByLabel("Enviar foto do perfil")
          .setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: photo })
        await expect(page.getByLabel("Prévia do recorte da foto")).toBeVisible()
        await page.getByLabel("Zoom", { exact: true }).fill("2")
        await page.getByLabel("Posição horizontal", { exact: true }).fill("100")
        const profile = await new AxeBuilder({ page }).include(".owner-profile-settings").analyze()
        expect(profile.violations).toEqual([])
        if (evidence)
          await page.screenshot({ animations: "disabled", path: `${evidence}/after-profile-${width}-${theme}.png` })
        if (photoEvidence)
          await page.screenshot({
            animations: "disabled",
            path: `${photoEvidence}/${photoPhase}-crop-${width}-${theme}.png`,
          })
        const encodingMs = await page.getByLabel("Prévia do recorte da foto").evaluate((canvas: HTMLCanvasElement) =>
          Array.from({ length: 10 }, () => {
            const started = performance.now()
            canvas.toDataURL("image/webp", 0.85)

            return performance.now() - started
          }),
        )
        console.log(`Profile crop encoding ${width} ${theme}: max ${Math.max(...encodingMs).toFixed(2)} ms, 10 samples`)
        // Saving straight from the crop keeps the photo; no separate confirm click.
        await saveProfile(page)
        if (photoEvidence)
          await page.screenshot({
            animations: "disabled",
            path: `${photoEvidence}/${photoPhase}-saved-${width}-${theme}.png`,
          })
        await expect(own.locator(".message-meta")).toContainText("Pessoa Teste")
        await expect(own.locator(".message-avatar img")).toBeVisible()
        const croppedColor = await own.locator(".message-avatar img").evaluate(async (image: HTMLImageElement) => {
          await image.decode()
          const canvas = document.createElement("canvas")
          canvas.width = 1
          canvas.height = 1
          const context = canvas.getContext("2d")
          if (!context) throw new Error("Missing image context")
          context.drawImage(image, 0, 0, 1, 1)

          return Array.from(context.getImageData(0, 0, 1, 1).data)
        })
        expect(croppedColor[0]).toBeLessThan(15)
        expect(croppedColor[1]).toBeLessThan(15)
        expect(croppedColor[2]).toBeGreaterThan(240)
        if (evidence)
          await page.screenshot({ animations: "disabled", path: `${evidence}/after-photo-work-${width}-${theme}.png` })
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
      if (width === 390) {
        await page.getByRole("button", { name: "Fechar menu", exact: true }).click()
        await expect(page.locator(".sidebar-drawer")).not.toBeVisible()
        await page.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
        )
      }
      await expect(page.getByText(/@.+ vamos revisar a entrega de hoje\./)).toBeVisible()
      if (!before) {
        await expect(page.locator("[data-work-message]")).toHaveCount(0)
        await expect(page.locator('[data-message-author="own"] .message-meta')).toHaveCount(0)
      }
      if (evidence)
        await page.screenshot({
          animations: "disabled",
          path: `${evidence}/${before ? "before" : "after"}-direct-${width}-${theme}.png`,
        })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    })
  }

async function navigation(page: Page, width: number) {
  if (width === 390 && !(await page.getByRole("tab", { name: /^Work,/ }).isVisible()))
    await page.getByRole("button", { name: "Abrir menu" }).click()
}
async function openProfile(page: Page, width: number) {
  await navigation(page, width)
  await page.locator(".user-chip").click()
  await page.getByRole("tab", { name: "Aparência", exact: true }).click()
  await expect(page.getByRole("dialog").getByRole("tab")).toHaveCount(5)
  await expect(page.getByRole("button", { name: /^Perfil/ })).toHaveAttribute("aria-expanded", "true")
}
async function saveProfile(page: Page) {
  await page.getByRole("button", { name: "Salvar preferências", exact: true }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
}

const getPhoto = async (page: Page): Promise<Buffer> => {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas")
    canvas.width = 256
    canvas.height = 128
    const context = canvas.getContext("2d")
    if (!context) throw new Error("Missing photo context")
    context.fillStyle = "#ff0000"
    context.fillRect(0, 0, 128, 128)
    context.fillStyle = "#0000ff"
    context.fillRect(128, 0, 128, 128)

    return canvas.toDataURL("image/png").split(",")[1] ?? ""
  })

  return Buffer.from(base64, "base64")
}
