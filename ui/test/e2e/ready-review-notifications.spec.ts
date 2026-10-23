import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

test.use({ locale: "pt-BR", reducedMotion: "reduce" })

const viewports = [
  { device: "desktop", width: 1440, height: 900, theme: "dark" },
  { device: "mobile", width: 390, height: 844, theme: "dark" },
  { device: "compact", width: 1024, height: 900, theme: "dark" },
  { device: "desktop", width: 1440, height: 900, theme: "light" },
  { device: "mobile", width: 390, height: 844, theme: "light" },
  { device: "compact", width: 1024, height: 900, theme: "light" },
]

viewports.forEach(({ device, width, height, theme }) => {
  test(`ready review opens its channel conversation and stays in history on ${device} in ${theme}`, async ({
    page,
  }) => {
    test.setTimeout(60_000)
    await page.addInitScript((theme) => localStorage.setItem("touri.appearance.v1", theme), theme)
    await page.setViewportSize({ width, height })
    await page.goto("/test/e2e/ready-review-notifications-harness.html")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    if (device === "mobile") await page.getByRole("button", { name: "Abrir menu", exact: true }).click()

    await page.getByRole("button", { name: /^Precisa de você.*Revisão pronta/, exact: true }).click()
    await expect(page.getByRole("textbox", { name: "Mensagem para avisos" })).toBeVisible()
    await expect(page.getByRole("region", { name: "Central de notificações" })).toHaveCount(0)
    if (device === "mobile") {
      await expect(page.getByRole("button", { name: "Fechar menu", exact: true })).toHaveCount(0)
      await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    }

    await page.getByRole("button", { name: "Notificações, 1 precisa de atenção", exact: true }).click()
    const center = page.getByRole("region", { name: "Central de notificações" })
    const pending = center.locator('[data-unread="true"]')
    await expect(pending.getByText("Revisão pronta", { exact: true })).toBeVisible()
    await expect(pending.getByText("Conversa de origem: #avisos · Revisão da alteração fictícia")).toBeVisible()
    await expect(center.locator(".notification-row.resolved")).toHaveCount(1)
    await expect(center.locator(".notification-row.resolved").getByText("Resolvido", { exact: true })).toBeVisible()
    expect(await center.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)

    const audit = await new AxeBuilder({ page })
      .include(".r8-notifications")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze()
    expect(audit.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) }))).toEqual([])

    const open = pending.getByRole("button", { name: "Abrir e revisar", exact: true })
    await open.focus()
    await page.keyboard.press("Enter")

    await expect(center).not.toBeVisible()
    await expect(page.getByRole("textbox", { name: "Mensagem para avisos" })).toBeVisible()
    await expect(
      page
        .getByTestId("virtual-message-list")
        .getByText("A alteração fictícia está pronta para conferir.", { exact: true }),
    ).toBeVisible()
    if (device === "mobile") await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    await page.getByRole("button", { name: "Notificações, 1 precisa de atenção", exact: true }).click()
    await pending.getByRole("button", { name: "Dispensar", exact: true }).click()

    await expect(center.locator('[data-unread="true"]')).toHaveCount(0)
    await expect(center.locator(".notification-row.resolved")).toHaveCount(2)
    await expect(center.getByRole("button", { name: "Abrir e revisar", exact: true })).toHaveCount(0)
    await expect(center.getByRole("button", { name: "Ver conversa", exact: true })).toHaveCount(2)
    await center.getByRole("button", { name: "Fechar notificações" }).click()
    await page.getByRole("button", { name: "Notificações", exact: true }).click()
    await expect(center.locator(".notification-row.resolved")).toHaveCount(2)
  })
})
