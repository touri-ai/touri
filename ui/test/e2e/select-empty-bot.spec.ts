import { expect, test } from "@playwright/test"

test.use({ channel: "chromium", reducedMotion: "reduce", viewport: { width: 1440, height: 900 } })

test("a paused empty bot resumes into one focused conversation", async ({ page }, info) => {
  await page.goto("/test/e2e/home-harness.html")
  await page.getByRole("button", { name: /^Panko / }).click()
  const composer = page.getByRole("textbox", { name: "Mensagem para Panko" })

  await expect(composer).toBeFocused()
  await expect(page.getByRole("complementary", { name: "Aviso de bot pausado" })).toBeVisible()
  await expect(page.getByText("Escolha uma conversa", { exact: true })).toHaveCount(0)
  await page.locator(".composer").screenshot({
    path: info.outputPath("paused-pt-BR.png"),
    mask: [page.locator(".composer-model")],
  })

  await page.getByRole("button", { name: "Retomar bot", exact: true }).click()

  await expect(page.getByRole("complementary", { name: "Aviso de bot pausado" })).toHaveCount(0)
  await expect(composer).toBeFocused()
  await page.locator(".composer").screenshot({
    path: info.outputPath("resumed-pt-BR.png"),
    mask: [page.locator(".composer-model")],
  })
  await page.getByRole("button", { name: /^mark / }).click()
  await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
  await page.getByRole("button", { name: /^Panko / }).click()
  await expect(composer).toBeVisible()

  const threads = page.locator('[data-bot-entry="bot-panko"] .thread-row')
  await expect(threads).toHaveCount(1)
})

const locales = ["pt-BR", "en"] as const

locales.forEach((locale) => {
  test(`paused composer notice is translated (${locale})`, async ({ page }, info) => {
    const title = locale === "en" ? "Touro de teste is paused" : "Touro de teste está pausado"
    const resume = locale === "en" ? "Resume bot" : "Retomar bot"
    await page.goto(`/test/e2e/empty-bot-composer-harness.html?lang=${locale}`)

    await expect(page.getByText(title, { exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: resume, exact: true })).toBeVisible()
    await page.locator(".composer-paused").screenshot({ path: info.outputPath(`notice-${locale}.png`) })
  })
})
