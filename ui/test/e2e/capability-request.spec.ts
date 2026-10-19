import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

test.use({ channel: "chromium", reducedMotion: "reduce" })
const state = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const qa = (
      window as unknown as {
        capabilityQa: {
          calls: Array<{ route: string; input: unknown }>
          state: () => { bots: Array<{ browserEnabled: boolean; computerUse: boolean }> }
          opened: string[]
        }
      }
    ).capabilityQa
    return { calls: qa.calls, bot: qa.state().bots[0], opened: qa.opened }
  })

for (const width of [390, 1440]) {
  test(`browser access waits for a click and resumes the original task at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("/test/e2e/capability-harness.html")
    const card = page.locator('[data-approval-id="capability"]')
    await expect(card.getByText("Ativar navegador", { exact: true })).toBeVisible()
    await expect(card).toContainText("Lia quer ativar o navegador dele para abrir a página solicitada.")
    await expect(card).toContainText("navegador isolado")
    await expect(card.getByRole("button", { name: "Permitir sempre nesta ferramenta" })).toHaveCount(0)
    await card.focus()
    await page.keyboard.press("Enter")
    expect((await state(page)).bot?.browserEnabled).toBe(false)
    expect((await state(page)).opened).toEqual([])
    await expect(card.getByRole("button", { name: "Ativar", exact: true })).toBeVisible()
    if (process.env.CAPABILITY_CAPTURE)
      await card.screenshot({ path: `${process.env.CAPABILITY_CAPTURE}/browser-${width}.png` })
    await card.getByRole("button", { name: "Ativar", exact: true }).click()
    await expect(page.getByText("Acesso ativado. Continuei a tarefa solicitada.")).toBeVisible()
    const after = await state(page)
    expect(after.bot?.browserEnabled).toBe(true)
    expect(after.opened).toEqual(["https://example.test/reference"])
    expect(after.calls.filter((call) => call.route === "POST /approvals/:id")).toEqual([
      expect.objectContaining({ input: { decision: "approved", standing: false } }),
    ])
    expect(after.calls.filter((call) => call.route === "POST /threads/:id/messages")).toHaveLength(0)
  })
}

test("not now keeps the browser off and explains how to enable it later", async ({ page }) => {
  await page.goto("/test/e2e/capability-harness.html")
  await page.getByRole("button", { name: "Agora não" }).click()
  await expect(page.getByText("Tudo bem. Você pode ativar depois nas configurações deste bot.")).toBeVisible()
  expect((await state(page)).bot?.browserEnabled).toBe(false)
  expect((await state(page)).opened).toEqual([])
})

test("computer approval describes screen access without a standing option", async ({ page }) => {
  await page.goto("/test/e2e/capability-harness.html?computer")
  const card = page.locator('[data-approval-id="capability"]')
  await expect(card).toContainText("Pode ver a tela e clicar ou digitar, somente onde o touri permite.")
  await expect(card.getByRole("button", { name: "Permitir sempre nesta ferramenta" })).toHaveCount(0)
  expect((await new AxeBuilder({ page }).include('[data-approval-id="capability"]').analyze()).violations).toEqual([])
  if (process.env.CAPABILITY_CAPTURE) await card.screenshot({ path: `${process.env.CAPABILITY_CAPTURE}/computer.png` })
  await card.getByRole("button", { name: "Ativar", exact: true }).click()
  await expect(page.getByText("Acesso ativado. Continuei a tarefa solicitada.")).toBeVisible()
  expect((await state(page)).bot?.computerUse).toBe(true)
  expect((await state(page)).bot?.browserEnabled).toBe(false)
})
