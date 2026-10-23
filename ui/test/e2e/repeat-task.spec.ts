import { expect, test } from "@playwright/test"
import { openMessageActions } from "./home-navigation"
import { prepareChannelResult } from "./repeat-task-fixture"

test.setTimeout(90_000)
test.use({ actionTimeout: 30_000, hasTouch: true })

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`repeat a useful result with explicit review at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport)
    await page.goto("/test/e2e/home-harness.html", { waitUntil: "domcontentloaded" })
    const messageActions = page.getByRole("button", { name: "Ações da mensagem", exact: true }).last()
    await expect(messageActions).toHaveCSS("opacity", "1")
    await openMessageActions(page)
    await page.getByRole("menuitem", { name: "Agendar esta tarefa", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Quando?" })
    await expect(dialog.getByRole("textbox", { name: "Tarefa", exact: true })).toHaveValue("Review the campaign")
    await dialog.getByLabel("Nome", { exact: true }).fill("Organizar notas")
    await dialog
      .getByRole("textbox", { name: "Tarefa", exact: true })
      .fill("Organize as notas desta conversa em uma lista.")
    await expect(dialog.getByLabel("Expressão cron")).not.toBeVisible()
    await expect(dialog.getByLabel("Às", { exact: true })).toHaveValue("09:00")
    await expect(dialog.getByRole("region", { name: "Próximas três execuções" }).locator("time")).toHaveCount(3)
    await dialog.getByLabel("Nome", { exact: true }).press("Enter")
    await expect(dialog).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath("simple-editor.png") })
    await dialog.getByRole("button", { name: "Revisar rotina" }).click()
    const review = page.getByRole("dialog", { name: "Revisar rotina" })
    await expect(review.getByText("Nesta conversa", { exact: true })).toBeVisible()
    await expect(review.getByText(/Funciona enquanto o touri/)).toBeVisible()
    const geometry = await review.boundingBox()
    expect(geometry?.width).toBeLessThanOrEqual(viewport.width)
    await expect(review.getByRole("region", { name: "Revisar rotina" })).toBeFocused()
    await review.getByRole("button", { name: "Ativar rotina" }).press("Enter")
    await review.getByRole("button", { name: "Ativar rotina" }).press("Space")
    await expect(review).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath("final-review.png") })
    await review.getByRole("button", { name: "Ativar rotina" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    const routines = await page.evaluate(async () => {
      const api = (
        window as unknown as {
          workspaceQa: {
            api: {
              request: (route: string, input: object) => Promise<{ routines: { enabled: boolean; prompt: string }[] }>
            }
          }
        }
      ).workspaceQa.api
      return (await api.request("GET /routines", {})).routines
    })
    expect(
      routines.find((routine) => routine.prompt === "Organize as notas desta conversa em uma lista.")?.enabled,
    ).toBe(true)
  })
}

for (const width of [1440, 1024, 390]) {
  for (const theme of ["light", "dark"]) {
    test(`schedule a completed channel result at ${width}px in ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ reducedMotion: "reduce" })
      await page.addInitScript((appearance) => localStorage.setItem("touri.appearance.v1", appearance), theme)
      await prepareChannelResult(page)

      const actions = page.getByRole("button", { name: "Ações da mensagem", exact: true }).last()
      await expect(actions).toHaveCSS("opacity", "1")
      await openMessageActions(page)
      const menu = info.outputPath(`channel-actions-${width}-${theme}.png`)
      await page.screenshot({ path: menu, animations: "disabled" })
      await info.attach("channel message actions", { path: menu, contentType: "image/png" })
      await page.getByRole("menuitem", { name: "Agendar esta tarefa", exact: true }).click()

      const editor = page.getByRole("dialog", { name: "Quando?", exact: true })
      await expect(editor.getByRole("textbox", { name: "Tarefa", exact: true })).toHaveValue(
        "@mark Organize minhas notas",
      )
      await expect(
        editor.getByRole("combobox", { name: "Destino dos resultados" }).locator("option:checked"),
      ).toHaveText("Conversa do grupo Notas fictícias")
      const image = info.outputPath(`channel-routine-${width}-${theme}.png`)
      await page.screenshot({ path: image, animations: "disabled" })
      await info.attach("channel routine draft", { path: image, contentType: "image/png" })
      await editor.getByRole("button", { name: "Cancelar", exact: true }).click()
    })
  }
}
