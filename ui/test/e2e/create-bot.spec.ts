import AxeBuilder from "@axe-core/playwright"
import { expect, type Locator, test } from "@playwright/test"

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" })

test("only a name takes two clicks from the landing to chat", async ({ page }) => {
  await page.goto("/test/e2e/create-bot-harness.html")
  let clicks = 0
  await page.getByRole("button", { name: "Criar meu primeiro bot" }).click()
  clicks++
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByLabel("Nome", { exact: true })).toBeFocused()
  await expect(dialog).not.toContainText(/SOUL\.md|provider|provedor|model|MCP|sandbox|\bVM\b/i)
  await expect(dialog.getByRole("button", { name: "Continuar" })).toHaveCount(0)
  await page.keyboard.type("Clara")
  await expect(dialog.getByText(/Usa o Codex/)).toBeVisible()
  await dialog.getByRole("button", { name: "Criar bot", exact: true }).click()
  clicks++
  await expect(page.getByRole("textbox", { name: "Mensagem para Clara" })).toBeVisible()
  await expect(dialog).toHaveCount(0)
  expect(clicks).toBe(2)
})

for (const first of [true, false]) {
  test(`project and folder controls stay in Advanced with a visible footer (first=${first})`, async ({ page }) => {
    await page.goto("/test/e2e/create-bot-harness.html")
    await page.getByRole("button", { name: "Criar meu primeiro bot" }).click()
    if (!first) {
      await page.getByLabel("Nome", { exact: true }).fill("Colega")
      await expect(page.getByText(/Usa o Codex/)).toBeVisible()
      await page.getByRole("dialog").getByRole("button", { name: "Criar bot", exact: true }).click()
      await expect(page.getByRole("textbox", { name: "Mensagem para Colega" })).toBeVisible()
      await expect(page.getByRole("dialog")).toHaveCount(0)
      await page.getByRole("button", { name: "Criar bot", exact: true }).click()
    }
    const dialog = page.getByRole("dialog", { name: "Criar um bot" })
    const advanced = dialog.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ })
    const primary = dialog.getByRole("button", { name: "Criar bot", exact: true })

    await dialog.getByLabel("Nome", { exact: true }).fill("Clara")
    await expect(dialog.getByText(/Usa o Codex/)).toBeVisible()

    await expect(advanced).toHaveAttribute("aria-expanded", "false")
    await expect(dialog.locator("#create-project, .bot-folder-settings")).toHaveCount(0)
    await expect(dialog.getByRole("button", { name: /Usar uma pasta|Adicionar pasta/ })).toHaveCount(0)
    await expect(primary).toBeInViewport({ ratio: 1 })
    const initial = await getCreationLayout(dialog)
    expect(initial.nestedScroll).toBe(false)
    expect(initial.contentBottom).toBeLessThanOrEqual(initial.footerTop + 1)
    expect(initial.footerBottom).toBeLessThanOrEqual(initial.dialogBottom)
    expect(initial.footerBottom).toBeLessThanOrEqual(initial.viewportHeight)

    await advanced.click()

    await expect(advanced).toHaveAttribute("aria-expanded", "true")
    const settings = dialog.locator("#bot-create-advanced")
    await expect(settings.getByLabel("Projeto", { exact: true })).toHaveValue("")
    await expect(settings.getByRole("button", { name: "Adicionar pasta…", exact: true })).toBeVisible()
    await expect(settings.getByRole("switch", { name: /Acesso a qualquer pasta/ })).not.toBeChecked()
    const lastNote = settings.locator(":scope > p").last()

    await lastNote.scrollIntoViewIfNeeded()

    await expect(lastNote).toBeInViewport({ ratio: 1 })
    await expect(primary).toBeInViewport({ ratio: 1 })
    const expanded = await getCreationLayout(dialog)
    const noteBox = await lastNote.boundingBox()
    if (!noteBox) throw new Error("Missing advanced note geometry")
    expect(expanded.nestedScroll).toBe(false)
    expect(expanded.contentBottom).toBeLessThanOrEqual(expanded.footerTop + 1)
    expect(expanded.footerTop).toBeCloseTo(initial.footerTop, 0)
    expect(noteBox.y + noteBox.height).toBeLessThanOrEqual(expanded.footerTop + 1)

    await advanced.click()

    await expect(dialog.locator("#create-project, .bot-folder-settings")).toHaveCount(0)
    await expect(dialog.getByLabel("Nome", { exact: true })).toHaveValue("Clara")

    await primary.click()

    await expect(page.getByRole("textbox", { name: "Mensagem para Clara" })).toBeVisible()
  })
}

test("a job can be searched and chosen by keyboard, with advanced edits preserved", async ({ page }) => {
  await page.goto("/test/e2e/create-bot-harness.html")
  await page.getByRole("button", { name: "Criar meu primeiro bot" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Nome", { exact: true }).fill("Clara")
  await dialog.getByRole("searchbox", { name: "Buscar trabalhos" }).fill("codigo")
  const jobs = dialog.getByRole("radiogroup", { name: "O que ele faz?" })
  await expect(jobs.getByRole("radio")).toHaveCount(6)
  await jobs.getByRole("radio", { name: "Ainda não sei" }).focus()
  await page.keyboard.press("ArrowDown")
  await expect(jobs.getByRole("radio", { name: "Mapa do repositório" })).toBeChecked()
  await expect(jobs.getByRole("radio", { name: "Mapa do repositório" })).toBeFocused()
  await dialog.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }).click()
  await expect(dialog.getByLabel("Função", { exact: true })).toHaveValue(/estrutura/)
  await expect(dialog.getByLabel("Instruções do bot", { exact: true })).toHaveValue(
    /Peça permissão antes de mudar arquivos/,
  )
  await dialog.getByLabel("Modelo", { exact: true }).fill("custom-model")
  await dialog.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }).click()
  await dialog.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }).click()
  await expect(dialog.getByLabel("Modelo", { exact: true })).toHaveValue("custom-model")
  await dialog.getByRole("button", { name: "Criar bot", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "Mensagem para Clara" })).toBeVisible()
  await expect(page.locator(".bot-entry").filter({ hasText: "Clara" }).locator(".bot-role")).toContainText("estrutura")
})

test("a missing account is explained inline and creating succeeds after sign-in", async ({ page }) => {
  let releaseWindowLoad: () => void = () => {}
  const windowLoadBlocked = new Promise<void>((resolve) => {
    releaseWindowLoad = resolve
  })
  await page.route("**/__test__/hold-window-load", async (route) => {
    await windowLoadBlocked
    await route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>',
    })
  })
  await page.addInitScript(() => {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        const image = document.createElement("img")
        image.src = "/__test__/hold-window-load"
        image.width = 1
        image.height = 1
        image.style.position = "fixed"
        image.style.opacity = "0"
        document.body.append(image)
      },
      { once: true },
    )
  })
  await page.goto("/test/e2e/create-bot-harness.html?signed-out", { waitUntil: "commit" })
  const openCreate = page.getByRole("button", { name: "Criar meu primeiro bot" })

  await expect(openCreate).toBeVisible()
  expect(await page.evaluate(() => document.readyState)).toBe("interactive")
  await openCreate.click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByRole("region", { name: "Escolha uma conta" })).toBeVisible()
  releaseWindowLoad()
  await page.waitForLoadState("load")
  await dialog.getByLabel("Nome", { exact: true }).fill("Clara")
  await dialog.getByRole("button", { name: "Criar bot", exact: true }).click()
  await expect(dialog.getByRole("alert")).toContainText("Entre em uma conta acima")
  await expect(dialog.getByRole("alert")).toBeInViewport()
  await expect(dialog.getByRole("region", { name: "Escolha uma conta" })).toBeFocused()
  await expect(dialog.getByLabel("Nome", { exact: true })).toHaveValue("Clara")
  await dialog.getByRole("button", { name: "Claude Code", exact: true }).click()
  await dialog.getByRole("button", { name: "Tentar de novo", exact: true }).click()
  await expect(dialog.getByText(/Usa o Claude Code/)).toBeVisible()
  await expect(dialog.getByRole("alert")).toHaveCount(0)
  await dialog.getByRole("button", { name: "Criar bot", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "Mensagem para Clara" })).toBeVisible()
})

test("create and advanced have no serious accessibility violations and restore focus", async ({ page }) => {
  await page.goto("/test/e2e/create-bot-harness.html")
  const trigger = page.getByRole("button", { name: "Criar meu primeiro bot" })
  await trigger.click()
  for (const advanced of [false, true]) {
    if (advanced) await page.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }).click()
    const result = await new AxeBuilder({ page }).include('[role="dialog"]').analyze()
    expect(result.violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))).toEqual(
      [],
    )
  }
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`create-bot headings follow a contiguous outline on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.goto("/test/e2e/create-bot-harness.html")
    await page.getByRole("button", { name: "Criar meu primeiro bot" }).click()
    const dialog = page.getByRole("dialog", { name: "Criar um bot" })

    await expect(dialog.getByRole("heading", { name: "Criar um bot", level: 2 })).toBeVisible()
    await expect(dialog.locator(".job-group h3")).toHaveCount(6)
    await expect(dialog.locator(".job-group h4")).toHaveCount(0)
    const result = await new AxeBuilder({ page }).analyze()

    expect(result.violations.filter((violation) => violation.id === "heading-order")).toEqual([])
  })
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`folder access action reads like a button at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.goto("/test/e2e/create-bot-harness.html")
    await page.getByRole("button", { name: "Criar meu primeiro bot" }).click()
    const dialog = page.getByRole("dialog", { name: "Criar um bot" })

    await dialog.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }).click()
    const action = dialog.getByRole("button", { name: "Adicionar pasta…", exact: true })

    await expect(action).toBeVisible()
    await action.scrollIntoViewIfNeeded()
    const geometry = await action.evaluate((button) => {
      const rect = button.getBoundingClientRect()
      const dialogWidth = button.closest('[role="dialog"]')?.getBoundingClientRect().width ?? 0
      return {
        width: rect.width,
        height: rect.height,
        dialogWidth,
        radius: Number.parseFloat(getComputedStyle(button).borderRadius),
      }
    })

    expect(geometry.height).toBeGreaterThanOrEqual(32)
    expect(geometry.radius).toBeGreaterThan(0)
    expect(geometry.width).toBeLessThan(geometry.dialogWidth / 2)

    await action.click()
    await expect(page.getByRole("dialog", { name: "Pastas no servidor" })).toBeVisible()
  })
}

const getCreationLayout = (dialog: Locator) =>
  dialog.evaluate((element) => {
    const form = element.querySelector(".bot-create-form")
    const content = element.querySelector(".bot-create-content")
    const jobs = element.querySelector(".job-options")
    const footer = element.querySelector(".bot-create-form > .modal-actions")
    if (!form || !content || !jobs || !footer) throw new Error("Missing creation layout")
    const getIsScrollable = (target: Element) =>
      ["auto", "scroll"].includes(getComputedStyle(target).overflowY) && target.scrollHeight > target.clientHeight + 1

    return {
      nestedScroll: [element, form, jobs].some(getIsScrollable),
      contentBottom: content.getBoundingClientRect().bottom,
      footerTop: footer.getBoundingClientRect().top,
      footerBottom: footer.getBoundingClientRect().bottom,
      dialogBottom: element.getBoundingClientRect().bottom,
      viewportHeight: innerHeight,
    }
  })
