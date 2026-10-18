import { expect, type Locator, type Page, test } from "@playwright/test"

const sizes = [
  { width: 800, height: 600 },
  { width: 1024, height: 700 },
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
  { width: 900, height: 560 },
]

const openWorkspace = async (page: Page, harness = "motion-app.html") => {
  await page.goto(`/test/e2e/${harness}`)
  await expect(page.getByRole("textbox", { name: /^Mensagem para / })).toBeVisible()
}

const botMenu = async (page: Page, action: string) => {
  if ((page.viewportSize()?.width ?? 0) < 620) await page.getByRole("button", { name: "Abrir menu" }).click()
  await page.getByRole("button", { name: "Ações de mark", exact: true }).click()
  // Keyboard activation also works with WebKit's native mouse-focus behavior.
  await page.getByRole("menuitem", { name: action, exact: true }).press("Enter")
}

const checkLayer = async (page: Page, dialog: Locator) => {
  const viewport = page.viewportSize()
  if (!viewport) throw new Error("Missing viewport")
  await expect(dialog).toHaveAttribute("aria-modal", "true")
  const layout = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const backdrop = element.closest<HTMLElement>(".modal-backdrop")
    if (!backdrop) throw new Error("Missing modal backdrop")
    const canvas = document.createElement("canvas")
    const context = canvas.getContext("2d")
    if (!context) throw new Error("Missing canvas context")
    context.fillStyle = getComputedStyle(element).backgroundColor
    context.fillRect(0, 0, 1, 1)
    return {
      alpha: context.getImageData(0, 0, 1, 1).data[3],
      rect: rect.toJSON(),
      backdrop: backdrop.getBoundingClientRect().toJSON(),
      backdropAlpha: getComputedStyle(backdrop).backgroundColor,
      overflow: element.scrollWidth - element.clientWidth,
      // A high z-index alone cannot escape a page's stacking context.
      coversSidebar: [
        [12, 100],
        [230, 130],
        [30, innerHeight - 35],
      ].every(([x, y]) => backdrop.contains(document.elementFromPoint(x ?? 0, y ?? 0))),
    }
  })
  expect(layout.alpha).toBe(255)
  expect(layout.backdropAlpha).toMatch(/^rgba\(.+, 0\.[1-9]\d*\)$/)
  expect(layout.backdrop).toMatchObject({ x: 0, y: 0, width: viewport.width, height: viewport.height })
  expect(layout.coversSidebar).toBe(true)
  expect(layout.rect.top).toBeGreaterThanOrEqual(19)
  expect(layout.rect.left).toBeGreaterThanOrEqual(19)
  expect(layout.rect.bottom).toBeLessThanOrEqual(viewport.height - 19)
  expect(layout.rect.right).toBeLessThanOrEqual(viewport.width - 19)
  expect(layout.overflow).toBeLessThanOrEqual(1)
}

const checkReachable = async (dialog: Locator, last: Locator, actions = ".modal-actions") => {
  await last.evaluate((element) => element.scrollIntoView({ block: "center" }))
  await expect(last).toBeInViewport({ ratio: 1 })
  await expect(dialog.locator(".modal-header")).toBeInViewport({ ratio: 0.99 })
  const header = await dialog.locator(".modal-header").boundingBox()
  const field = await last.boundingBox()
  const footer = dialog.locator(actions)
  // WebKit can clip a sticky border by one pixel; every button must be fully exposed below.
  await expect(footer).toBeInViewport({ ratio: 0.98 })
  const footerBox = await footer.boundingBox()
  if (!header || !field || !footerBox) throw new Error("Missing modal geometry")
  expect(field.y).toBeGreaterThanOrEqual(header.y + header.height - 1)
  expect(field.y + field.height).toBeLessThanOrEqual(footerBox.y + 1)
  for (const button of await footer.getByRole("button").all()) {
    await expect(button).toBeInViewport({ ratio: 1 })
    await expect(button).toBeVisible()
    // Trial clicks verify that neither the sidebar nor another surface intercepts actions.
    if (await button.isEnabled()) await button.click({ trial: true })
  }
}

for (const size of sizes) {
  test.describe(`${size.width}x${size.height}`, () => {
    test.use({ viewport: size, reducedMotion: "reduce" })

    test("routine fields, native selects, review and nested confirmation", async ({ page }, info) => {
      await openWorkspace(page)
      await botMenu(page, "Rotinas")
      await page.getByRole("button", { name: "Editar Resumo do dia", exact: true }).click()
      const dialog = page.getByRole("dialog", { name: "Quando?", exact: true })
      await page.screenshot({ path: info.outputPath("routine-open.png") })
      await checkLayer(page, dialog)
      await expect(dialog.getByLabel("Nome", { exact: true })).toBeFocused()
      const frequency = dialog.getByRole("combobox", { name: "Frequência", exact: true })
      await frequency.selectOption("daily")
      await frequency.click()
      await frequency.press("Enter")
      await frequency.selectOption("weekdays")
      await expect(frequency).toHaveValue("weekdays")
      await dialog.getByText("Avançado", { exact: true }).click()
      await checkReachable(
        dialog,
        dialog.getByLabel("Recuperar disparos atrasados por (minutos)"),
        ".routine-modal-actions",
      )
      await checkReachable(
        dialog,
        dialog.getByRole("combobox", { name: "Fuso horário", exact: true }),
        ".routine-modal-actions",
      )
      await dialog.getByRole("button", { name: "Revisar rotina", exact: true }).click()
      const review = page.getByRole("dialog", { name: "Revisar rotina", exact: true })
      await checkReachable(review, review.locator(".routine-form-note"), ".routine-modal-actions")
      await page.screenshot({ path: info.outputPath("routine-review.png") })
      await review.getByRole("button", { name: "Excluir rotina", exact: true }).press("Enter")
      const confirmation = page.getByRole("alertdialog")
      await checkLayer(page, confirmation)
      await expect(confirmation.getByRole("button", { name: "Cancelar", exact: true })).toBeFocused()
      await checkReachable(confirmation, confirmation.locator("p").last())
      await page.keyboard.press("Escape")
      await expect(confirmation).toHaveCount(0)
      await expect(review.getByRole("button", { name: "Excluir rotina", exact: true })).toBeFocused()
    })

    test("bot creation and advanced settings keep their header and actions", async ({ page }, info) => {
      await openWorkspace(page)
      await botMenu(page, "Avançado")
      const settings = page.getByRole("dialog")
      await checkLayer(page, settings)
      await settings.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }).click()
      // The last navigation item must remain clickable above the footer, even when it opens another page.
      await settings.getByRole("tab", { name: "Rotinas", exact: true }).click({ trial: true })
      await settings.getByRole("tab", { name: "Computador", exact: true }).click()
      const pane = settings.locator(".settings-pane:not([hidden])")
      await checkReachable(
        settings,
        pane.locator("input:visible, select:visible, textarea:visible, button:visible").last(),
      )
      await page.screenshot({ path: info.outputPath("settings-advanced.png") })
      await expect(settings.getByRole("button", { name: "Salvar configurações" })).toHaveAccessibleName(
        "Salvar configurações",
      )
      await settings.getByRole("button", { name: "Fechar diálogo" }).click()
      if (size.width < 620) await page.getByRole("button", { name: "Abrir menu" }).click()
      await page.getByRole("button", { name: "Criar bot", exact: true }).first().click()
      const create = page.getByRole("dialog")
      await checkLayer(page, create)
      await create.getByLabel("Nome", { exact: true }).fill("Clara")
      await create.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }).click()
      await checkReachable(
        create,
        create
          .locator(".bot-create-content")
          .locator("input:visible, select:visible, textarea:visible, button:visible")
          .last(),
      )
      await page.screenshot({ path: info.outputPath("create-advanced.png") })
    })

    test("folder selection and permission approval remain above settings", async ({ page }, info) => {
      await openWorkspace(page, "data-access-harness.html")
      await page.getByRole("button", { name: "Escolher pasta do servidor" }).click()
      const settings = page.getByRole("dialog", { name: "Permissões do bot" })
      await settings.getByRole("button", { name: "Adicionar pasta…" }).press("Enter")
      const picker = page.getByRole("dialog", { name: "Pastas no servidor" })
      await checkLayer(page, picker)
      await picker.getByText("Digitar caminho", { exact: true }).click()
      await checkReachable(
        picker,
        picker.getByRole("radio", { name: "O bot pode ler e salvar arquivos aqui", exact: true }),
      )
      await page.screenshot({ path: info.outputPath("folder-picker.png") })
      await picker.getByRole("button", { name: "Cancelar", exact: true }).click()
      await expect(settings.getByRole("button", { name: "Adicionar pasta…" })).toBeFocused()
      await settings.getByRole("switch", { name: /Acesso a qualquer pasta deste servidor/ }).click()
      const approval = page.getByRole("dialog", { name: "Permitir acesso a qualquer pasta?" })
      await checkLayer(page, approval)
      await checkReachable(approval, approval.locator("p").last())
    })

    test("bot deletion confirmation stays above the native mobile sidebar", async ({ page }) => {
      await openWorkspace(page)
      await botMenu(page, "Excluir bot")
      const confirmation = page.getByRole("dialog", { name: "Excluir bot", exact: true })
      await checkLayer(page, confirmation)
      await checkReachable(confirmation, confirmation.getByLabel("Digite o nome do bot: mark"))
      await confirmation.getByRole("button", { name: "Cancelar", exact: true }).click()
      await expect(confirmation).toHaveCount(0)
    })
  })
}

test("animated modal layer covers the viewport midway and after opening", async ({ page }, info) => {
  await page.setViewportSize({ width: 900, height: 560 })
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await openWorkspace(page)
  await botMenu(page, "Avançado")
  const layer = page.locator('.motion-modal[data-motion-state="open"]')
  const dialog = page.getByRole("dialog")
  await layer.evaluate((node) => {
    for (const animation of node.getAnimations()) animation.finish()
    ;(node as HTMLElement).style.setProperty("--reveal", "0")
    getComputedStyle(node).getPropertyValue("--reveal")
    for (const animation of node.getAnimations()) animation.finish()
    ;(node as HTMLElement).style.setProperty("--reveal", "1")
    getComputedStyle(node).getPropertyValue("--reveal")
    const animation = node.getAnimations()[0]
    if (!animation) throw new Error("Modal reveal did not animate")
    animation.pause()
    animation.currentTime = 120
  })
  await page.screenshot({ path: info.outputPath("modal-mid-animation.png") })
  await checkLayer(page, dialog)
  await expect(layer).toHaveCSS("position", "fixed")
  expect(await layer.evaluate((node) => node.getBoundingClientRect().height)).toBe(560)
  await layer.evaluate((node) => {
    for (const animation of node.getAnimations()) animation.finish()
  })
  await checkLayer(page, dialog)
  await page.screenshot({ path: info.outputPath("modal-settled.png") })
})
