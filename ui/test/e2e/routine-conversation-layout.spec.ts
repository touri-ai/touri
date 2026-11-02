import AxeBuilder from "@axe-core/playwright"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { chooseRoutineAction, showBotRoutines } from "./home-navigation"

test.use({ browserName: "chromium", headless: true, locale: "pt-BR", reducedMotion: "reduce", timezoneId: "UTC" })
test.setTimeout(60_000)

const cases = [390, 768, 1024, 1440].flatMap((width) => (["light", "dark"] as const).map((theme) => ({ width, theme })))

cases.forEach(({ width, theme }) => {
  test.describe(`routine conversation layout at ${width}px in ${theme}`, () => {
    test.use({ viewport: { width, height: 900 }, colorScheme: theme, hasTouch: width === 390 })

    test("keeps the header clear of editing with long titles and instruction disclosure", async ({
      page,
    }, testInfo) => {
      await page.addInitScript((appearance) => localStorage.setItem("touri.appearance.v1", appearance), theme)
      await page.goto("/?mockScenario=routine-conversation")
      const prompt = page.locator(".message-routine-prompt")
      const header = prompt.locator(".routine-run-header")
      const instructions = prompt.getByRole("button", { name: "Instruções da rotina", exact: true })
      const edit = prompt.getByRole("button", { name: "Editar", exact: true })
      await expect(header).toHaveText("Resumo da caixa de entrada · Programada · 16:04")
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
      await page.evaluate(() => document.fonts.ready)
      if (process.env.TOURI_E2E_EVIDENCE_DIR && (width === 390 || width === 1440))
        await page.screenshot({ path: testInfo.outputPath(`routine-${width}-${theme}.png`) })

      await assertRoutineLayout(prompt)
      await expect(instructions).toHaveAttribute("aria-expanded", "false")

      await instructions.focus()
      await instructions.press("Enter")

      await expect(instructions).toHaveAttribute("aria-expanded", "true")
      await expect(prompt.locator(".disclosure-reveal")).toHaveAttribute("aria-hidden", "false")
      const originalInstructions = await prompt.locator(".markdown-content").innerText()
      expect(originalInstructions).toContain(
        "Confira as mensagens recebidas desde a última execução e procure apenas assuntos que precisam de atenção hoje.",
      )
      await assertRoutineLayout(prompt)
      const accessibility = await new AxeBuilder({ page })
        .include(".message-routine-prompt")
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
      expect(accessibility.violations).toEqual([])

      await instructions.click()

      await expect(prompt.locator(".disclosure-reveal")).toHaveAttribute("aria-hidden", "true")

      const longTitle = `Resumo ${"planejamento".repeat(6)}`
      await renameRoutine(page, longTitle)

      await expect(header).toHaveText(`${longTitle} · Programada · 16:04`)
      await expect(instructions).toHaveAttribute("aria-expanded", "false")
      await assertRoutineLayout(prompt)

      await edit.click()
      const editor = prompt.getByRole("textbox", { name: "Editar mensagem", exact: true })

      await expect(editor).toBeFocused()
      await expect(editor).toHaveValue(originalInstructions)
      await expect(edit).toHaveAttribute("aria-expanded", "true")
      await assertRoutineLayout(prompt)

      await editor.fill("Instruções de exemplo revisadas.")
      await prompt.getByRole("button", { name: "Cancelar", exact: true }).click()

      await expect(editor).toHaveCount(0)
      await expect(edit).toBeFocused()
      await expect(edit).toHaveAttribute("aria-expanded", "false")

      await edit.press("Enter")

      await expect(editor).toHaveValue(originalInstructions)

      const revisedInstructions = "Confira apenas as tarefas de exemplo pendentes."
      await editor.fill(revisedInstructions)
      await prompt.getByRole("button", { name: "Salvar e enviar", exact: true }).click()

      await expect(
        page.getByTestId("virtual-message-list").getByText(revisedInstructions, { exact: true }),
      ).toBeVisible()
    })
  })
})

const renameRoutine = async (page: Page, name: string): Promise<void> => {
  const menu = page.getByRole("button", { name: "Abrir menu", exact: true })
  if (await menu.isVisible()) await menu.click()
  await showBotRoutines(page)
  await chooseRoutineAction(page, "Resumo da caixa de entrada", "Editar")
  const editor = page.getByRole("dialog", { name: "Quando?", exact: true })
  await editor.getByRole("textbox", { name: "Nome", exact: true }).fill(name)
  await editor.getByRole("button", { name: "Revisar rotina", exact: true }).click()
  const review = page.getByRole("dialog", { name: "Revisar rotina", exact: true })
  await review.getByRole("button", { name: "Ativar rotina", exact: true }).click()
  await expect(review).toHaveCount(0)

  await page.keyboard.press("Control+k")
  await page.getByRole("combobox", { name: "Buscar bots, conversas e configurações" }).fill("Resumo")
  await page.locator('[data-palette-item="thread:thread-mark"]').click()
}

const assertRoutineLayout = async (prompt: Locator): Promise<void> => {
  const header = prompt.locator(".routine-run-header")
  const edit = prompt.getByRole("button", { name: "Editar", exact: true })
  const [promptBounds, headerBounds, editBounds, labelBounds] = await Promise.all([
    getBounds(prompt),
    getBounds(header),
    getBounds(edit),
    getTextBounds(edit),
  ])
  const hasIntersection =
    headerBounds.x < editBounds.x + editBounds.width &&
    headerBounds.x + headerBounds.width > editBounds.x &&
    headerBounds.y < editBounds.y + editBounds.height &&
    headerBounds.y + headerBounds.height > editBounds.y
  const contentBounds = [headerBounds, editBounds].concat(labelBounds)
  const overflows = await Promise.all(
    [prompt, header].map((element) => element.evaluate((node) => node.scrollWidth - node.clientWidth)),
  )

  expect(hasIntersection, "routine header and Editar bounds must not intersect").toBe(false)
  expect(editBounds.width).toBeGreaterThanOrEqual(44)
  expect(editBounds.height).toBeGreaterThanOrEqual(44)
  expect(labelBounds, "Editar must remain on one line").toHaveLength(1)
  contentBounds.forEach((bounds) => {
    expect(bounds.x).toBeGreaterThanOrEqual(promptBounds.x - 1)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(promptBounds.x + promptBounds.width + 1)
    expect(bounds.y).toBeGreaterThanOrEqual(promptBounds.y - 1)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(promptBounds.y + promptBounds.height + 1)
  })
  overflows.forEach((overflow) => {
    expect(overflow).toBeLessThanOrEqual(1)
  })
}

const getBounds = async (element: Locator) => {
  const bounds = await element.boundingBox()
  if (!bounds) throw new Error("Routine layout bounds are missing")

  return bounds
}

const getTextBounds = (element: Locator) =>
  element.evaluate((node) => {
    const range = document.createRange()
    range.selectNodeContents(node)

    return Array.from(range.getClientRects(), (bounds) => ({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    }))
  })
