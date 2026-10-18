import { expect, test } from "@playwright/test"

for (const size of [
  { width: 800, height: 600 },
  { width: 962, height: 642 },
]) {
  test(`separate computer deletion fits ${size.width}x${size.height}`, async ({ page }, info) => {
    await page.setViewportSize(size)
    await page.goto("/test/e2e/native-qa-r7-harness.html")
    const dialog = page.getByRole("dialog", { name: "Excluir bot", exact: true })
    const checkbox = dialog.getByRole("checkbox", { name: "apagar também os arquivos do computador" })
    await expect(checkbox).not.toBeChecked()
    await checkbox.scrollIntoViewIfNeeded()
    const geometry = await dialog.evaluate((node) => {
      const label = node.querySelector(".delete-bot-files")
      const input = label?.querySelector("input")
      if (!label || !input) throw new Error("Missing files option")
      const range = document.createRange()
      range.selectNodeContents(label)
      const text = [...range.getClientRects()].filter((rect) => rect.width > 25)
      return {
        overflow: node.scrollWidth - node.clientWidth,
        width: input.getBoundingClientRect().width,
        text: text.map((rect) => ({ left: rect.left, right: rect.right })),
        left: node.getBoundingClientRect().left,
        right: node.getBoundingClientRect().right,
      }
    })
    expect(geometry.overflow).toBeLessThanOrEqual(1)
    expect(geometry.width).toBeLessThan(30)
    expect(geometry.text.length).toBeGreaterThan(0)
    for (const rect of geometry.text) {
      expect(rect.left).toBeGreaterThanOrEqual(geometry.left)
      expect(rect.right).toBeLessThanOrEqual(geometry.right)
    }
    await expect(checkbox).toBeInViewport({ ratio: 1 })
    await dialog.getByLabel("Digite o nome do bot: Caderno").fill("Caderno")
    await expect(dialog.getByRole("button", { name: "Excluir bot", exact: true })).toBeEnabled()
    await expect(dialog.getByRole("button", { name: "Cancelar", exact: true })).toBeInViewport({ ratio: 1 })
    await page.screenshot({ path: info.outputPath("delete-computer.png") })
    const bounds = await dialog.boundingBox()
    const option = await dialog.locator(".delete-bot-files").boundingBox()
    if (!bounds || !option) throw new Error("Missing deletion geometry")
    await page.screenshot({
      path: info.outputPath("delete-option-and-actions.png"),
      clip: {
        x: bounds.x,
        y: option.y - 8,
        width: bounds.width,
        height: bounds.y + bounds.height - option.y + 8,
      },
    })
  })
}

test("computer startup keeps its explanation after 45 seconds", async ({ page }, info) => {
  await page.goto("/test/e2e/native-qa-r7-harness.html?waiting")
  await expect(page.getByRole("status")).toHaveText("Ligando o computador do bot…")
  await expect(page.getByText(/A resposta está demorando/)).toHaveCount(0)
  await page.locator(".activity-mark").screenshot({ path: info.outputPath("computer-startup.png") })
})

test("account discovery shows loading until the selected check settles", async ({ page }, info) => {
  await page.goto("/test/e2e/native-qa-r7-harness.html?account")
  const dialog = page.getByRole("dialog")
  const checking = dialog.getByText(/Verificando/)
  await checking.scrollIntoViewIfNeeded()
  await expect(checking).toBeInViewport({ ratio: 1 })
  await expect(dialog.getByRole("alert")).toHaveCount(0)
  await page.screenshot({ path: info.outputPath("account-loading.png") })
  await page.evaluate(() => (window as unknown as { settleAccount: () => void }).settleAccount())
  await expect(dialog.getByText(/^Usa .*, conectado neste/)).toBeVisible()
  await expect(dialog.getByText(/Verificando/)).toHaveCount(0)
  await expect(dialog.getByRole("alert")).toHaveCount(0)
  await page.screenshot({ path: info.outputPath("account-ready.png") })
})
