import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { chooseChannelAction } from "./home-navigation"

const evidence =
  process.env.TOURI_GROUP_EVIDENCE_DIR ?? resolve(import.meta.dirname, "../../test-results/group-member-count")

test("group header updates its visible and accessible member count", async ({ page }) => {
  test.setTimeout(60_000)
  mkdirSync(evidence, { recursive: true })
  await page.setViewportSize({ width: 1100, height: 800 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.addInitScript(() => localStorage.setItem("touri.appearance.v1", "light"))
  await page.goto("/test/e2e/groups-harness.html")
  await page.getByRole("textbox", { name: "Mensagem para mark", exact: true }).waitFor()
  await page.evaluate(async () => {
    const api = (
      window as unknown as {
        groupsQa: { api: ReturnType<typeof import("../../src/api/mock").createMockApi> }
      }
    ).groupsQa.api
    const [first, second] = api.getState().bots
    if (!first || !second) throw new Error("Missing members")
    first.name = "Bia"
    second.name = "Lia"
    await api.request("POST /groups", {
      name: "Equipe",
      color: "#dc2626",
      avatarShape: "classic-none",
      memberIds: [first.id, second.id],
      coordinatorBotId: null,
    })
  })
  await page.getByRole("tab", { name: /^Work,/ }).click()
  await page
    .getByRole("region", { name: "Canais", exact: true })
    .getByRole("button", { name: /^Equipe/ })
    .click()
  const header = page.locator(".group-header")
  await expect(header.getByRole("button", { name: "Membros do canal: 2 bots", exact: true })).toBeVisible()
  await expect(header.locator(".group-header-members")).toHaveCount(0)
  await expect(header.getByRole("button")).toHaveCount(2)
  await header.getByRole("button", { name: "Ações do canal Equipe", exact: true }).click()
  await expect(page.getByRole("menuitem", { name: "Convidar pessoa", exact: true })).toBeVisible()
  await page.keyboard.press("Escape")
  await page.evaluate(() => document.fonts.ready)
  await header.screenshot({ path: `${evidence}/after-two.png`, animations: "disabled" })
  await chooseChannelAction(page, "Equipe", "Editar canal")
  const dialog = page.getByRole("dialog", { name: "Editar canal" })
  await dialog.getByRole("checkbox", { name: "Lia", exact: true }).uncheck()
  await dialog.getByRole("button", { name: "Salvar canal", exact: true }).click()
  await expect(header.getByRole("button", { name: "Membros do canal: 1 bot", exact: true })).toBeVisible()
  await expect(header.locator(".group-header-members")).toHaveCount(0)
  await expect(header.getByRole("button")).toHaveCount(2)
  await header.screenshot({ path: `${evidence}/after-one.png`, animations: "disabled" })

  await chooseChannelAction(page, "Equipe", "Editar canal")
  await dialog.getByLabel("Nome do canal").fill("Equipe de planejamento e atendimento para novos projetos")
  await dialog.getByRole("button", { name: "Salvar canal", exact: true }).click()
  await page.setViewportSize({ width: 375, height: 800 })
  await expect(header.getByRole("button", { name: "Membros do canal: 1 bot", exact: true })).toBeVisible()
  expect(await header.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0)
})
