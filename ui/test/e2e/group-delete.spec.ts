import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import type { UiApi } from "../../src/api/client"

const evidence = resolve(process.env.TOURI_GROUP_DELETE_EVIDENCE_DIR ?? "test-results/group-delete")

test("deletes a group from its sidebar menu after explicit confirmation", async ({ page }) => {
  mkdirSync(evidence, { recursive: true })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.addInitScript(() => localStorage.setItem("touri.appearance.v1", "light"))
  await page.goto("/test/e2e/groups-harness.html")
  await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
  await page.evaluate(async () => {
    const qaWindow = window as Window & { groupsQa: { api: UiApi } }
    await qaWindow.groupsQa.api.request("POST /groups", {
      name: "Equipe QA",
      color: "#dc2626",
      avatarShape: "classic-none",
      memberIds: ["bot-mark", "bot-onb"],
      coordinatorBotId: "bot-mark",
    })
  })
  const groups = page.getByRole("region", { name: "Grupos" })

  await groups.getByRole("button", { name: "Equipe QA", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "Mensagem para Equipe QA" })).toBeVisible()
  await groups.getByRole("button", { name: "Ações do grupo Equipe QA" }).click()
  await page.getByRole("menuitem", { name: "Apagar grupo" }).click()

  const dialog = page.getByRole("dialog", { name: "Apagar grupo" })
  const confirm = dialog.getByRole("button", { name: "Apagar grupo" })
  await expect(confirm).toBeDisabled()
  await expect(dialog).toContainText("Os bots e suas conversas individuais são preservados.")
  await dialog.getByLabel("Digite o nome do grupo: Equipe QA").fill("Equipe QA")
  await expect(confirm).toBeEnabled()
  await page.screenshot({ path: `${evidence}/group-delete-confirm.png` })

  await confirm.click()

  await expect(dialog).toHaveCount(0)
  await expect(groups.getByRole("button", { name: "Equipe QA", exact: true })).toHaveCount(0)
  await expect(page.getByRole("textbox", { name: "Mensagem para mark", exact: true })).toBeVisible()
  await expect(page.locator('[data-bot-entry="bot-onb"]')).toBeVisible()
  await page.screenshot({ path: `${evidence}/group-delete-complete.png` })
})
