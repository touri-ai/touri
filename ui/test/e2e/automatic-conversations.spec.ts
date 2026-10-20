import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" })

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-20T12:00:00Z"))
})

const openConversations = async (page: Page) => {
  const menu = page.getByRole("button", { name: "Abrir menu", exact: true })
  if (await menu.isVisible()) await menu.click()
  const entry = page.locator('[data-bot-entry="bot-mark"]')
  const rows = entry.locator(".thread-row")
  if ((await rows.count()) === 0) await entry.locator(".bot-row-main").click()
  await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()

  return rows
}

const capture = async (page: Page, name: string) => {
  const directory = process.env.TOURI_SCREENSHOT_DIR
  if (!directory) return
  await mkdir(directory, { recursive: true })
  await page.screenshot({ path: join(directory, `${name}.png`) })
}

test("automatic task threads no longer flood the sidebar and task mode groups them", async ({ page }) => {
  test.setTimeout(30_000)
  await page.goto("/test/e2e/home-harness.html?scenario=thread-noise-before")
  const before = await openConversations(page)
  await expect(before.filter({ hasText: "lead.reply" })).toHaveCount(30)
  await capture(page, "automatic-conversations-before")

  await page.goto("/test/e2e/home-harness.html?scenario=thread-noise-main")
  const main = await openConversations(page)
  await expect(main).toHaveCount(1)
  await expect(main.filter({ hasText: "lead.reply" })).toHaveCount(0)
  await capture(page, "automatic-conversations-main")

  await page.goto("/test/e2e/home-harness.html?scenario=thread-noise-grouped")
  const grouped = await openConversations(page)
  await expect(grouped.filter({ hasText: "Tarefas lead.reply · 30 hoje" })).toHaveCount(1)
  await expect(grouped.filter({ hasText: "lead.reply" })).toHaveCount(1)
  await capture(page, "automatic-conversations-task-mode")

  await page.getByRole("button", { name: "Histórico de tarefas de lead.reply" }).click()
  const history = page.getByRole("region", { name: "Histórico de tarefas de lead.reply" })
  await expect(history.locator(".thread-row")).toHaveCount(30)
  await history.getByRole("button").last().click()
  await expect(page.locator(".thread-row.selected").first()).toContainText("Tarefas lead.reply")
})

for (const view of [
  { name: "desktop-light", width: 1440, height: 900, theme: "light" },
  { name: "desktop-dark", width: 1440, height: 900, theme: "dark" },
  { name: "phone-light", width: 390, height: 844, theme: "light" },
  { name: "phone-dark", width: 390, height: 844, theme: "dark" },
] as const) {
  test(`automatic conversations and settings are clear on ${view.name}`, async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: view.width, height: view.height })
    await page.emulateMedia({ colorScheme: view.theme, reducedMotion: "reduce" })
    await page.addInitScript((theme) => localStorage.setItem("touri.appearance.v1", theme), view.theme)

    await page.goto("/test/e2e/home-harness.html?scenario=thread-noise-main")
    const main = await openConversations(page)
    await expect(main).toHaveCount(1)
    await capture(page, `automatic-conversations-main-${view.name}`)

    await page.goto("/test/e2e/home-harness.html?scenario=thread-noise-grouped")
    const grouped = await openConversations(page)
    await expect(grouped.filter({ hasText: "Tarefas lead.reply · 30 hoje" })).toHaveCount(1)
    await capture(page, `automatic-conversations-task-${view.name}`)
    await page.getByRole("button", { name: "Histórico de tarefas de lead.reply" }).click()
    const history = page.getByRole("region", { name: "Histórico de tarefas de lead.reply" })
    await expect(history.locator(".thread-row")).toHaveCount(30)
    await capture(page, `automatic-conversations-task-history-${view.name}`)

    await page.goto("/test/e2e/create-bot-harness.html")
    await page.getByRole("button", { name: "Criar meu primeiro bot", exact: true }).click()
    const creation = page.getByRole("dialog", { name: "Criar um bot" })
    await creation.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }).click()
    const mode = creation.getByLabel("Onde o bot responde", { exact: true })
    await expect(mode).toHaveValue("main")
    await mode.scrollIntoViewIfNeeded()
    await capture(page, `automatic-conversations-create-${view.name}`)

    await page.goto("/test/e2e/home-harness.html")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    const menu = page.getByRole("button", { name: "Abrir menu", exact: true })
    const sidebar =
      view.width === 390
        ? page.getByRole("dialog", { name: "Barra lateral" })
        : page.getByRole("navigation", { name: "Barra lateral" })
    if (view.width === 390) await menu.click()
    const actions = sidebar.getByRole("button", { name: "Ações de mark", exact: true })
    await expect(actions).toBeVisible()
    await actions.click()
    const advanced = page.getByRole("menuitem", { name: "Avançado", exact: true })
    await expect(advanced).toBeVisible()
    await advanced.click()
    const settings = page.getByRole("dialog", { name: "Configurações de mark" })
    const setting = settings.getByRole("radiogroup", { name: "Onde o bot responde" })
    await expect(setting.getByRole("radio")).toHaveCount(2)
    await expect(setting.getByRole("radio", { name: "Uma conversa nova por tarefa" })).toBeVisible()
    expect(await setting.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    await capture(page, `automatic-conversations-settings-${view.name}`)
  })
}
