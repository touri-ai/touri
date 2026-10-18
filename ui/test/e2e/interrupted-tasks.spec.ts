import { expect, test } from "@playwright/test"

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`interrupted tasks require review and preserve history at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.goto("/?mockScenario=interrupted-tasks")
    if (viewport.width === 390) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    await page.getByRole("button", { name: /^Tarefas interrompidas/ }).click()
    const center = page.getByRole("dialog", { name: "Tarefas interrompidas", exact: true })
    await expect(center.getByTestId("interrupted-task")).toHaveCount(3)
    const journal = center.getByTestId("interrupted-task").filter({ has: page.getByRole("checkbox") })

    await journal.getByRole("button", { name: /Ver ações realizadas/ }).click()
    await expect(journal.getByText("Prévia do projeto")).toBeVisible()
    await expect(journal.getByRole("button", { name: "Descartar" })).toBeDisabled()
    await journal.getByRole("checkbox").check()
    await journal.getByRole("button", { name: "Descartar" }).click()
    await expect(center.getByText("Interrupções resolvidas", { exact: false })).toBeVisible()
    await expect(center.getByRole("checkbox")).toHaveCount(0)
    const bounds = await center.boundingBox()
    expect(bounds?.width).toBeLessThanOrEqual(viewport.width)
    await center.getByText("Interrupções resolvidas", { exact: false }).click()
    await expect(center.getByText("Interrupção anterior · resolvida")).toBeVisible()
    await center.getByRole("button", { name: "Retomar tarefa" }).first().click()
    await expect(center).toHaveCount(0)
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toHaveValue(
      "Conferi as ações registradas. Quero continuar a tarefa a partir do estado atual, sem repetir ações já concluídas.",
    )
  })
}
