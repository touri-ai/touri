import AxeBuilder from "@axe-core/playwright"
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
  await page.locator(".message-scroll").evaluate((element) => {
    element.scrollTop = 0
  })
  await expect(page.locator(".chat-scroll-bottom")).toBeVisible()
  await page.locator(".composer textarea").fill("Continuar depois do resultado removido")
  await page.getByRole("button", { name: "Enviar", exact: true }).click()
  await expect(
    page.getByTestId("virtual-message-list").getByText("Continuar depois do resultado removido", { exact: true }),
  ).toBeInViewport()
})

for (const width of [1440, 390]) {
  for (const scenario of ["recovered", "browser", "browser-final", "long"]) {
    test(`search reveals the selected text inside a projected response: ${scenario} at ${width}px`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ reducedMotion: "reduce" })
      await page.goto(`/test/e2e/message-search-harness.html?scenario=${scenario}`)
      await expect(page.locator(".composer textarea")).toBeVisible()
      await openSearch(page)
      const targetId =
        scenario === "recovered" || scenario === "browser-final" ? "search-history-10" : "search-history-8"

      await page.locator(`[data-palette-item="message:${targetId}"]`).click()

      const path = `${process.env.TOURI_SCREENSHOT_DIR ?? info.outputDir}/projected-${scenario}-${width}.png`
      await page.screenshot({
        path,
        animations: "disabled",
        mask: [page.locator(".composer-model")],
        maskColor: "#222222",
      })
      await info.attach(`projected search ${scenario} ${width}`, { path, contentType: "image/png" })
      const target = page.locator(`[data-message-row="${targetId}"]`)
      await expect(target).toBeInViewport()
      await expect(target.locator(".markdown-content").filter({ hasText: "nota-qa.txt" })).toBeVisible()
      await expect(target.locator(".markdown-content").filter({ hasText: "nota-qa.txt" })).toContainText(
        "Fim da resposta.",
      )
      expect(await page.locator("[data-message-row]").count()).toBeLessThanOrEqual(34)
      if (scenario !== "long") {
        const otherId = targetId === "search-history-8" ? "search-history-10" : "search-history-8"
        await expect(page.locator(`[data-message-row="${otherId}"]`)).toHaveCount(0)
      }
      const accessibility = await new AxeBuilder({ page }).include(".message-scroll").analyze()
      expect(
        accessibility.violations.filter(
          (issue) => issue.impact === "serious" || issue.impact === "critical" || issue.id === "color-contrast",
        ),
      ).toEqual([])
      if (scenario === "recovered" || scenario === "browser-final") {
        await expect(target.getByRole("group", { name: "Ramificações da mensagem" })).toContainText("1/2")
        await target.getByRole("button", { name: "Próxima ramificação" }).click()
        const leaf = await page.evaluate(
          () =>
            (Reflect.get(window, "messageSearchFixture") as Fixture).api
              .getState()
              .threads.find((thread) => thread.id === "thread-mark")?.activeLeafId,
        )
        expect(leaf).toBe("search-other-branch")
      }
    })
  }
}
