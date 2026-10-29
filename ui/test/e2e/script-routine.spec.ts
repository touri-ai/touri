import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { chooseRoutineAction, showBotRoutines } from "./home-navigation"

test.use({ channel: "chromium" })
test.setTimeout(60_000)

for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 390]) {
    test(`script routine review and persistence at ${width} in ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 1000 })
      await page.addInitScript((appearance) => localStorage.setItem("touri.appearance.v1", appearance), theme)
      await page.goto("/test/e2e/routine-channel-harness.html")
      await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
      if (width === 390) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
      await showBotRoutines(page)
      await chooseRoutineAction(page, "Resumo do canal", "Editar")
      const editor = page.getByRole("dialog", { name: "Quando?" })
      await editor.getByRole("combobox", { name: "Tipo de rotina" }).selectOption("script")
      await editor
        .getByRole("textbox", { name: "Comando", exact: true })
        .fill("printf 'Relatório de exemplo concluído'")
      await editor.getByRole("textbox", { name: "Pasta de execução (cwd)" }).fill("/tmp/example")
      await editor.getByRole("textbox", { name: "Arquivo de ambiente (opcional)" }).fill("/tmp/example.env")
      await expect(editor.getByRole("textbox", { name: "Tarefa", exact: true })).toHaveCount(0)
      await expect(editor.getByRole("combobox", { name: "Destino dos resultados" })).toHaveValue(/group:/)
      expect(await editor.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      await editor.getByRole("combobox", { name: "Tipo de rotina" }).scrollIntoViewIfNeeded()
      const evidence = process.env.TOURI_ROUTINE_EVIDENCE_DIR
      const editImage = `script-edit-${width}-${theme}.png`
      await page.screenshot({ path: evidence ? join(evidence, editImage) : info.outputPath(editImage) })

      await editor.getByRole("button", { name: "Revisar rotina", exact: true }).click()
      const review = page.getByRole("dialog", { name: "Revisar rotina" })
      await expect(review.getByText("printf 'Relatório de exemplo concluído'", { exact: true })).toBeVisible()
      await expect(review.getByText(/sem agente/)).toBeVisible()
      const reviewImage = `script-review-${width}-${theme}.png`
      await page.screenshot({ path: evidence ? join(evidence, reviewImage) : info.outputPath(reviewImage) })
      await review.getByRole("button", { name: "Ativar rotina", exact: true }).click()
      await expect(review).toHaveCount(0)

      await chooseRoutineAction(page, "Resumo do canal", "Editar")
      await expect(editor.getByRole("combobox", { name: "Tipo de rotina" })).toHaveValue("script")
      await expect(editor.getByRole("textbox", { name: "Comando", exact: true })).toHaveValue(
        "printf 'Relatório de exemplo concluído'",
      )
    })
  }
}
