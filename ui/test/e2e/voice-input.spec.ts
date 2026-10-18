import { expect, type Page, test } from "@playwright/test"

test("dictation is opt-in, inserts plain draft text and requires an explicit send", async ({ page }) => {
  await installRecognition(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/test/e2e/home-harness.html")
  const draft = page.getByRole("textbox", { name: "Mensagem para mark" })
  const send = page.getByRole("button", { name: "Enviar", exact: true })
  await draft.fill("Primeiro:")
  const before = await getSentMessages(page)

  await page.getByRole("button", { name: "Ditar mensagem", exact: true }).click()
  await expect(page.getByRole("dialog")).toContainText("fornecedor do navegador (na nuvem)")
  await expect(page.getByRole("dialog")).toContainText("O touri não processa, grava nem armazena áudio.")
  await page.getByRole("button", { name: "Iniciar ditado", exact: true }).click()
  await expect(send).toBeDisabled()
  await page.getByRole("button", { name: "Gravando… Parar ditado", exact: true }).click()

  await expect(draft).toHaveValue("Primeiro: Revise o plano fictício.")
  await expect(send).toBeEnabled()
  expect(await getSentMessages(page)).toEqual(before)
  await send.click()
  await expect(draft).toHaveValue("")
  await expect.poll(async () => (await getSentMessages(page)).length).toBe(before.length + 1)
  expect((await getSentMessages(page)).at(-1)).toMatchObject({ text: "Primeiro: Revise o plano fictício." })
})

test("unsupported platforms do not offer voice input", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "SpeechRecognition", { value: undefined })
    Object.defineProperty(window, "webkitSpeechRecognition", { value: undefined })
  })
  await page.goto("/test/e2e/home-harness.html")

  await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Ditar mensagem" })).toHaveCount(0)
})

test("cloud disclosure stays readable on phones and desktop in both themes", async ({ page }, testInfo) => {
  await installRecognition(page)
  const views = [
    { width: 390, height: 844, theme: "light" },
    { width: 390, height: 844, theme: "dark" },
    { width: 1440, height: 900, theme: "light" },
    { width: 1440, height: 900, theme: "dark" },
  ]

  for (const view of views) {
    await page.setViewportSize({ width: view.width, height: view.height })
    await page.goto("/test/e2e/home-harness.html")
    await page.evaluate((theme) => {
      localStorage.setItem("touri.appearance.v1", theme)
      window.dispatchEvent(new Event("storage"))
    }, view.theme)
    await page.getByRole("textbox", { name: "Mensagem para mark" }).fill("Rascunho fictício para revisar.")
    await page.getByRole("button", { name: "Ditar mensagem", exact: true }).click()

    await expect(page.getByRole("dialog")).toContainText("fornecedor do navegador (na nuvem)")
    await expect(page.locator("html")).toHaveAttribute("data-theme", view.theme)
    await expect(page.getByRole("button", { name: "Iniciar ditado", exact: true })).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
    await page.screenshot({
      path: testInfo.outputPath(`consent-${view.width}-${view.theme}.png`),
      animations: "disabled",
    })
  }
})

const getSentMessages = (page: Page) =>
  page.evaluate(() => {
    const fixture: { api: { calls: { route: string; input: unknown }[] } } = Reflect.get(window, "workspaceQa")
    return fixture.api.calls.filter((call) => call.route === "POST /threads/:id/messages").map((call) => call.input)
  })

const installRecognition = (page: Page) =>
  page.addInitScript(() => {
    class Recognition {
      lang = ""
      onstart?: () => void
      onresult?: (event: { resultIndex: number; results: { isFinal: boolean; 0: { transcript: string } }[] }) => void
      onend?: () => void
      start() {
        this.onstart?.()
      }
      stop() {
        this.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "Revise o plano fictício." } }] })
        this.onend?.()
      }
      abort() {}
    }
    Object.defineProperty(window, "SpeechRecognition", { configurable: true, value: Recognition })
  })
