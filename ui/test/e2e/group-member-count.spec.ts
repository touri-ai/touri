import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"

const evidence =
  process.env.TOURI_GROUP_EVIDENCE_DIR ?? resolve(import.meta.dirname, "../../test-results/group-member-count")

test("group header updates its visible and accessible member count", async ({ page }) => {
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
  await expect(header.getByText("2 bots", { exact: true })).toBeVisible()
  await expect(header.locator(".group-header-members")).toHaveCount(0)
  await expect(header.getByRole("button")).toHaveCount(3)
  await expect(header.getByRole("button", { name: "Convidar pessoa", exact: true })).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  await header.screenshot({ path: `${evidence}/after-two.png`, animations: "disabled" })
  await header.getByRole("button", { name: "Editar canal", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Editar canal" })
  await dialog.getByRole("checkbox", { name: "Lia", exact: true }).uncheck()
  await dialog.getByRole("button", { name: "Salvar canal", exact: true }).click()
  await expect(header.getByText("1 bot", { exact: true })).toBeVisible()
  await expect(header.locator(".group-header-members")).toHaveCount(0)
  await expect(header.getByRole("button")).toHaveCount(3)
  await header.screenshot({ path: `${evidence}/after-one.png`, animations: "disabled" })

  await header.getByRole("button", { name: "Editar canal", exact: true }).click()
  await dialog.getByLabel("Nome do canal").fill("Equipe de planejamento e atendimento para novos projetos")
  await dialog.getByRole("button", { name: "Salvar canal", exact: true }).click()
  await page.setViewportSize({ width: 375, height: 800 })
  await expect(header.getByText("1 bot", { exact: true })).toBeVisible()
  expect(await header.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0)
})
