import { expect, test } from "@playwright/test"
import { showBotDetails } from "./home-navigation"

const evidence = "../docs/qa/r4-shots"
test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/test/e2e/r4-harness.html")
  await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
})

test("r4 approval center is above the chat and opens the full card", async ({ page }, info) => {
  await page.goto("/test/e2e/approval-notice-harness.html")
  await page.getByRole("button", { name: "Notificações, 1 precisa de atenção" }).click()
  const center = page.getByRole("region", { name: "Central de notificações" })
  await expect(center).toBeVisible()
  await expect(center.getByRole("button", { name: "Abrir e revisar" })).toBeVisible()
  await expect(center.getByRole("button", { name: "Aprovar" })).toHaveCount(0)
  expect(
    await center.evaluate((element) => {
      const box = element.getBoundingClientRect()
      return element.contains(document.elementFromPoint(box.right - 10, box.top + 50))
    }),
  ).toBe(true)
  const beforeReview = info.outputPath("approval-center-before-review.png")
  await page.screenshot({ path: beforeReview, animations: "disabled" })
  await info.attach("approval center before review", { path: beforeReview, contentType: "image/png" })
  await center.getByRole("button", { name: "Abrir e revisar" }).click()
  await expect(page.locator('[data-approval-id="folder-review"]')).toBeFocused()
  await expect(center).not.toBeVisible()
  await expect(page.getByRole("button", { name: /^Notificações/ })).toBeVisible()
  const afterReview = info.outputPath("approval-center-after-review.png")
  await page.screenshot({ path: afterReview, animations: "disabled" })
  await info.attach("approval center after review", { path: afterReview, contentType: "image/png" })
})

test("r4 search backdrop fills the viewport without a native dialog strip", async ({ page }) => {
  await page.keyboard.press("Meta+k")
  await expect(page.getByRole("combobox", { name: "Buscar bots, conversas e configurações" })).toBeFocused()
  await page.getByRole("combobox", { name: "Buscar bots, conversas e configurações" }).fill("mark")
  const geometry = await page.locator(".command-palette-backdrop").evaluate((element) => {
    const box = element.getBoundingClientRect()
    return {
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      viewport: [innerWidth, innerHeight],
      tag: element.tagName,
    }
  })
  expect(geometry).toMatchObject({ x: 0, y: 0, width: geometry.viewport[0], height: geometry.viewport[1], tag: "DIV" })
  await page.screenshot({ path: `${evidence}/search.png` })
})

test("r4 short numbers stay on one line and multiline composer grows", async ({ page }) => {
  await expect(page.getByRole("cell", { name: "113", exact: true })).toBeVisible()
  for (const number of ["113", "112", "111"]) {
    expect(
      await page.getByRole("cell", { name: number, exact: true }).evaluate((cell) => {
        const range = document.createRange()
        range.selectNodeContents(cell)
        return range.getClientRects().length
      }),
    ).toBe(1)
  }
  const composer = page.getByRole("textbox", { name: "Mensagem para mark" })
  const initial = await composer.evaluate((element) => element.getBoundingClientRect().height)
  await composer.fill("Primeira linha\nSegunda linha\nTerceira linha")
  expect(await composer.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(initial)
  await page.screenshot({ path: `${evidence}/table-composer.png` })
})

test("r4 permissions focus, integration guidance and preset setup are available", async ({ page }) => {
  await showBotDetails(page)
  await page.getByRole("button", { name: "Ajustar permissões" }).click()
  const dialog = page.getByRole("dialog", { name: "Permissões do bot" })
  await expect(dialog.getByRole("combobox", { name: "Acesso", exact: true })).toBeFocused()
  await expect(dialog.getByRole("combobox", { name: "Acesso", exact: true })).toBeInViewport()
  await dialog.getByRole("tab", { name: "Ferramentas", exact: true }).click()
  await dialog.getByRole("button", { name: "Abrir Integrações" }).click()
  await expect(page.getByRole("heading", { name: "Integrações", exact: true })).toBeVisible()
  const gmail = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Gmail", exact: true }) })

  await gmail.getByText("Como conectar", { exact: true }).click()

  await expect(gmail).toContainText("Uma conta Google e uma preparação no Google Cloud. Vamos orientar cada etapa.")
  await expect(gmail.getByRole("link", { name: "Instruções do servidor Gmail" })).toHaveAttribute(
    "href",
    "https://github.com/shinzo-labs/gmail-mcp#prerequisites",
  )

  await page.getByRole("button", { name: "Configurar MCP de mark" }).click()
  const settings = page.getByRole("dialog")
  await settings.getByRole("button", { name: "Configuração técnica (MCP)", exact: true }).click()
  await settings
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Gmail", exact: true }) })
    .getByRole("button", { name: "Conectar", exact: true })
    .click()

  await expect(settings.getByRole("region", { name: "Preparar Gmail", exact: true })).toContainText(
    "Preparação concluída. Teste a conexão para continuar.",
  )
  await expect(page.getByLabel("Nome do servidor MCP")).toHaveValue("gmail")
  await expect(page.getByLabel("Comando MCP")).toHaveValue("npx")
  await page.screenshot({ path: `${evidence}/gmail.png` })
})

test("r4 Preview empty state has readable contrast and restores on reload", async ({ page }) => {
  await showBotDetails(page)
  await page.getByRole("button", { name: "Preview do projeto" }).click()
  const heading = page.locator(".screen-empty strong").first()
  await expect(heading).toBeVisible()
  expect(await heading.evaluate((element) => getComputedStyle(element).color)).toBe("rgb(242, 242, 243)")
  await page.screenshot({ path: `${evidence}/preview-empty.png` })
  await page.reload()
  await expect(page.getByRole("tab", { name: "Logs", exact: true })).toBeVisible()
})
