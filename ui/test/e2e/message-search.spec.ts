import { expect, type Page, test } from "@playwright/test"
import type { createMockApi } from "../../src/api/mock"

type Fixture = { api: ReturnType<typeof createMockApi>; text: string }
const openSearch = async (page: Page) => {
  await page.keyboard.press("Control+k")
  const input = page.getByRole("combobox", { name: "Buscar bots, conversas e configurações" })
  await input.fill("nota-qa.txt")

  return input
}

for (const width of [1440, 390]) {
  for (const scenario of ["same", "other", "archived", "branch"]) {
    test(`message result click reveals the exact historical row: ${scenario} at ${width}px`, async ({ page }, info) => {
      test.setTimeout(60_000)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ reducedMotion: "reduce" })
      await page.goto(`/test/e2e/message-search-harness.html?scenario=${scenario}`)
      const composer = page.locator(".composer textarea")
      await expect(composer).toBeVisible()
      await composer.fill("Rascunho fictício: continuar a revisão.")
      const target = page.locator('[data-message-row="search-history-8"]')
      await expect(target).toHaveCount(0)
      await openSearch(page)
      const option = page.locator('[data-palette-item="message:search-history-8"]')
      await expect(option).toBeVisible()

      await option.click()

      await expect(page.getByRole("dialog", { name: "Paleta de comandos" })).toHaveCount(0)
      await expect(page.getByRole("textbox", { name: "Mensagem para Brisa" })).toBeVisible()
      await expect(target).toBeInViewport()
      await expect(target).toContainText("Fim da resposta.")
      const fullText = await page.evaluate(() => (Reflect.get(window, "messageSearchFixture") as Fixture).text)
      await expect(target.locator(".markdown-content")).toHaveText(fullText)
      expect(await page.locator("[data-message-row]").count()).toBeLessThanOrEqual(34)
      const leafWrites = await page.evaluate(() => {
        const fixture = Reflect.get(window, "messageSearchFixture") as Fixture
        return fixture.api.calls.filter(
          (call) =>
            call.route === "PATCH /threads/:id" &&
            typeof call.input === "object" &&
            call.input !== null &&
            "activeLeafId" in call.input,
        )
      })
      expect(leafWrites).toHaveLength(scenario === "branch" ? 1 : 0)
      if (scenario === "same" || scenario === "branch")
        await expect(composer).toHaveValue("Rascunho fictício: continuar a revisão.")
      const image = process.env.TOURI_SCREENSHOT_DIR
        ? `${process.env.TOURI_SCREENSHOT_DIR}/message-search-${scenario}-${width}.png`
        : info.outputPath(`message-search-${scenario}-${width}.png`)
      await page.screenshot({
        path: image,
        animations: "disabled",
        mask: [page.locator(".composer-model")],
        maskColor: "#222222",
      })
      await info.attach(`message search ${scenario} ${width}`, { path: image, contentType: "image/png" })
      await page.keyboard.press("Control+k")
      const input = page.getByRole("combobox", { name: "Buscar bots, conversas e configurações" })
      await input.fill(scenario === "same" || scenario === "branch" ? "Oceano" : "Welcome")
      const destination =
        scenario === "same" || scenario === "branch"
          ? '[data-palette-item="bot:bot-onb"]'
          : '[data-palette-item="thread:thread-onb"]'
      await page.locator(destination).click()
      if (scenario === "other" || scenario === "archived")
        await expect(composer).toHaveValue("Rascunho fictício: continuar a revisão.")
    })
  }
}

test("Enter selects the historical message and a repeated selection reveals it again", async ({ page }) => {
  await page.goto("/test/e2e/message-search-harness.html?scenario=same")
  await expect(page.locator(".composer textarea")).toBeVisible()
  const input = await openSearch(page)
  await expect(page.locator('[data-palette-item="message:search-history-8"]')).toBeVisible()

  await input.press("Enter")

  const target = page.locator('[data-message-row="search-history-8"]')
  await expect(target).toBeInViewport()
  await page.locator(".chat-scroll-bottom").click()
  await expect(target).toHaveCount(0)
  await (await openSearch(page)).press("Enter")
  await expect(target).toBeInViewport()
})

test("a result removed before authorized history loads reports the missing message", async ({ page }) => {
  await page.goto("/test/e2e/message-search-harness.html?scenario=other")
  await expect(page.locator(".composer textarea")).toBeVisible()
  await openSearch(page)
  const option = page.locator('[data-palette-item="message:search-history-8"]')
  await expect(option).toBeVisible()
  await page.evaluate(() => {
    const fixture = Reflect.get(window, "messageSearchFixture") as Fixture
    const messages = fixture.api.getState().messages
    // The mock owns the fixture array; simulate deletion after the result arrives.
    messages.splice(
      messages.findIndex((message) => message.id === "search-history-8"),
      1,
    )
  })

  await option.click()

  await expect(page.getByText("Esta mensagem não está mais disponível.")).toBeVisible()
  await expect(page.locator('[data-message-row="search-history-8"]')).toHaveCount(0)
})
