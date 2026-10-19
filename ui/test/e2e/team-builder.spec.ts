import { mkdir } from "node:fs/promises"
import AxeBuilder from "@axe-core/playwright"
import { expect, type Page, test } from "@playwright/test"

test.use({ channel: "chromium", reducedMotion: "reduce" })
test.setTimeout(90_000)
const getState = (page: Page) =>
  page.evaluate(() => {
    const qa = (
      window as Window & {
        teamQa: {
          state: () => {
            bots: Array<{ name: string; access: string; approvals: string; computerUse: boolean; machine: string }>
            groups: Array<{ name: string }>
          }
        }
      }
    ).teamQa
    return qa.state()
  })
for (const theme of ["light", "dark"] as const) {
  test(`team builder: explicit approval creates the team and links its conversation in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1200 })
    await page.addInitScript((theme) => {
      localStorage.setItem("touri.appearance.v1", theme)
      localStorage.removeItem("touri.workspace.v1")
    }, theme)
    await page.goto("/test/e2e/team-builder-harness.html")
    const card = page.locator('[data-approval-id="team"]')
    await expect(card.getByRole("button", { name: "Criar time" })).toBeVisible()
    await expect(card).toContainText("Navegador e controle do computador desativados")
    await expect(card).toContainText("Instalação ou login pendente")
    await expect(card.locator("details")).toHaveCount(3)
    for (const instructions of await card.locator("details").all()) {
      await expect(instructions).toHaveAttribute("open", "")
      await expect(instructions.locator("pre")).toBeVisible()
    }
    expect((await getState(page)).bots).toHaveLength(1)
    await page.emulateMedia({ colorScheme: theme })
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme
    }, theme)
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
    await card.focus()
    await page.keyboard.press("Enter")
    expect((await getState(page)).bots).toHaveLength(1)
    expect((await new AxeBuilder({ page }).include('[data-approval-id="team"]').analyze()).violations).toEqual([])
    const capture = process.env.TEAM_CAPTURE
    if (capture) {
      await mkdir(capture, { recursive: true })
      await card.screenshot({ path: `${capture}/proposal-${theme}.png`, animations: "disabled" })
    }

    await card.getByRole("button", { name: "Criar time" }).click()

    await expect(card.getByText("Time criado", { exact: true })).toBeVisible()
    await expect(card.getByRole("link")).toHaveCount(4)
    const state = await getState(page)
    expect(state.bots).toHaveLength(4)
    expect(state.groups).toEqual([expect.objectContaining({ name: "Conteúdo semanal" })])
    expect(state.bots.slice(1)).toEqual(
      Array.from({ length: 3 }, () =>
        expect.objectContaining({
          access: "workspace-write",
          approvals: "on-request",
          machine: "local",
          computerUse: false,
        }),
      ),
    )
    if (capture) await page.screenshot({ path: `${capture}/created-${theme}.png`, animations: "disabled" })
    await card.getByRole("link", { name: /Abrir conversa do grupo/ }).click()
    await expect(page.getByRole("textbox", { name: "Mensagem para Conteúdo semanal" })).toBeVisible()
  })
}

test("team builder: cancel creates nothing at a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto("/test/e2e/team-builder-harness.html")
  const card = page.locator('[data-approval-id="team"]')
  await card.getByRole("button", { name: "Cancelar" }).click()

  await expect(card).toContainText("Nenhum bot ou grupo foi criado.")
  expect((await getState(page)).bots).toHaveLength(1)
  expect((await getState(page)).groups).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
})

test("team builder: partial failure offers one-click cleanup", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1200 })
  await page.goto("/test/e2e/team-builder-harness.html?scenario=partial")
  const card = page.locator('[data-approval-id="team"]')

  await card.getByRole("button", { name: "Criar time" }).click()

  await expect(card.getByRole("alert")).toContainText("o grupo não foi criado")
  expect((await getState(page)).bots).toHaveLength(2)
  expect((await getState(page)).groups).toEqual([])
  const capture = process.env.TEAM_CAPTURE
  if (capture) await card.screenshot({ path: `${capture}/partial-failure.png`, animations: "disabled" })

  await card.getByRole("button", { name: "Apagar bots criados" }).click()

  await expect(card.getByRole("status")).toHaveText("Bots criados apagados.")
  expect((await getState(page)).bots).toHaveLength(1)
  await expect(card.getByRole("link")).toHaveCount(0)
})
