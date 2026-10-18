import { expect, type Page, test } from "@playwright/test"

test("dictation is opt-in, inserts plain draft text and requires an explicit send", async ({ page }) => {
  await page.addInitScript(() => {
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
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/test/e2e/home-harness.html")
  const draft = page.getByRole("textbox", { name: "Mensagem para mark" })
  const send = page.getByRole("button", { name: "Enviar", exact: true })
  await draft.fill("Primeiro:")
  const before = await getSentMessages(page)

  await page.getByRole("button", { name: "Ditar mensagem", exact: true }).click()
  await expect(page.getByRole("dialog")).toContainText("pode enviar áudio ao serviço de reconhecimento")
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

const getSentMessages = (page: Page) =>
  page.evaluate(() => {
    const fixture: { api: { calls: { route: string; input: unknown }[] } } = Reflect.get(window, "workspaceQa")
    return fixture.api.calls.filter((call) => call.route === "POST /threads/:id/messages").map((call) => call.input)
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
