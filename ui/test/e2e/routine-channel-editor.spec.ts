import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { chooseRoutineAction, showBotRoutines } from "./home-navigation"

test.use({ channel: "chromium" })
test.setTimeout(60_000)

const viewports = [
  ["desktop", 1440, 900],
  ["phone", 390, 844],
] as const

viewports.forEach(([device, width, height]) => {
  test(`global channel routine preserves its destination after editing on ${device}`, async ({ page }, info) => {
    const evidence = process.env.TOURI_ROUTINE_EVIDENCE_DIR
    await page.setViewportSize({ width, height })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.addInitScript(() => localStorage.setItem("touri.appearance.v1", "light"))
    await page.goto("/test/e2e/routine-channel-harness.html")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    if (device === "phone") await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    await showBotRoutines(page)
    await page.getByRole("combobox", { name: "Bot", exact: true }).selectOption("all")
    await chooseRoutineAction(page, "Resumo do canal", "Editar")
    const editor = page.getByRole("dialog", { name: "Quando?" })
    const destination = editor.getByRole("combobox", { name: "Destino dos resultados" })
    await expect(destination.locator("option:checked")).toHaveText("Conversa do grupo Relatórios")
    await expect(destination.getByRole("option", { name: "Conversa do grupo Planejamento" })).toHaveCount(1)
    await expect(destination.getByRole("option", { name: "Conversa do grupo Pesquisa" })).toHaveCount(0)
    await expect(editor.getByRole("button", { name: "Revisar rotina", exact: true })).toBeEnabled()
    await editor
      .getByRole("textbox", { name: "Tarefa", exact: true })
      .fill("Resuma também as próximas tarefas fictícias.")
    await destination.scrollIntoViewIfNeeded()
    expect(await editor.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    const editImage = `after-edit-${device}.png`
    await page.screenshot({ path: evidence ? join(evidence, editImage) : info.outputPath(editImage) })

    await editor.getByRole("button", { name: "Revisar rotina", exact: true }).click()
    const review = page.getByRole("dialog", { name: "Revisar rotina" })
    await expect(review.getByText("Conversa do grupo Relatórios", { exact: true })).toBeVisible()
    await expect(review.getByRole("button", { name: "Ativar rotina", exact: true })).toBeEnabled()
    const reviewImage = `after-review-${device}.png`
    await page.screenshot({ path: evidence ? join(evidence, reviewImage) : info.outputPath(reviewImage) })
    await review.getByRole("button", { name: "Ativar rotina", exact: true }).click()
    await expect(review).toHaveCount(0)

    await chooseRoutineAction(page, "Resumo do canal", "Editar")
    await expect(destination.locator("option:checked")).toHaveText("Conversa do grupo Relatórios")
    await expect(editor.getByRole("textbox", { name: "Tarefa", exact: true })).toHaveValue(
      "Resuma também as próximas tarefas fictícias.",
    )
  })
})
