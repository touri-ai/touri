import { readFileSync } from "node:fs"
import { expect, test } from "@playwright/test"
import { showBotAdvanced, showBotPanel } from "./home-navigation"

const framebuffer = readFileSync(new URL("./fixtures/r8-desktop.js", import.meta.url), "utf8")

for (const width of [960, 1280, 1440]) {
  test(`expanded computer header remains readable during work at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page
      .context()
      .route("**/@novnc_novnc.js*", (route) => route.fulfill({ contentType: "text/javascript", body: framebuffer }))
    await page.addInitScript(() => {
      window.WebSocket = class extends EventTarget {
        close() {}
      } as unknown as typeof WebSocket
    })
    await page.goto("/test/e2e/fixtures/r8-panel.html")
    await showBotPanel(page)
    await page.getByRole("tab", { name: "Computador", exact: true }).click()
    await page.getByRole("button", { name: "Ligar computador" }).click()
    await page.getByRole("button", { name: "Expandir", exact: true }).click()
    await page.evaluate(async () => {
      const { api } = (
        window as unknown as { botPanelQa: { api: ReturnType<typeof import("../../src/api/mock").createMockApi> } }
      ).botPanelQa
      const state = api.getState()
      const bot = state.bots[0]
      const thread = state.threads.find((entry) => entry.botId === bot?.id)
      if (!bot || !thread) throw new Error("Missing fixture")
      api.emit({
        type: "run.updated",
        run: {
          id: "active-header-run",
          botId: bot.id,
          threadId: thread.id,
          provider: bot.provider,
          trigger: "user",
          status: "running",
          queuedAt: 1,
          startedAt: 1,
          finishedAt: null,
          requestMessageId: null,
          replyMessageId: null,
          externalTurnId: null,
          errorClass: null,
          errorMessage: null,
          usage: null,
          routineRunId: null,
        },
      })
    })
    const summary = page.locator(".computer-summary")
    const stop = summary.getByRole("button", { name: "Parar máquina" })
    await expect(stop).toBeDisabled()
    const reason = summary.getByText("Aguarde o turno terminar ou pare o turno para parar a máquina.")
    await expect(reason).toBeVisible()
    const elements = [
      summary.locator("strong").first(),
      summary.getByRole("status"),
      stop,
      reason,
      summary.getByRole("button", { name: "Recolher" }),
      summary.getByRole("button", { name: "Abrir em janela" }),
    ]
    const boxes = await Promise.all(elements.map((element) => element.boundingBox()))
    for (const [index, box] of boxes.entries()) {
      expect(box).not.toBeNull()
      if (!box) continue
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(width)
      for (const other of boxes.slice(index + 1)) {
        if (!other) continue
        const intersects =
          box.x < other.x + other.width &&
          box.x + box.width > other.x &&
          box.y < other.y + other.height &&
          box.y + box.height > other.y
        expect(intersects, `header items ${index} overlap`).toBe(false)
      }
    }
    await summary.screenshot({ path: testInfo.outputPath(`computer-working-${width}.png`) })
  })
}

test("computer settings explain the choice before showing implementation details", async ({ page }, testInfo) => {
  await page.goto("/test/e2e/fixtures/bot-panel.html")
  await showBotAdvanced(page)
  const dialog = page.getByRole("dialog")
  await dialog.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }).click()
  await dialog.getByRole("tab", { name: "Computador", exact: true }).click()
  await expect(dialog.getByRole("option", { name: /Separado só para o bot/ })).toBeAttached()
  const memory = dialog.getByLabel("Memória por computador do bot (MiB)")
  await expect(memory).toBeHidden()
  await dialog.locator(".machine-environment-row").screenshot({ path: testInfo.outputPath("computer-settings.png") })
  await dialog.locator(".machine-settings > details > summary").click()
  await expect(memory).toBeVisible()
  await dialog
    .locator(".settings-row:has(#bot-vm-memory)")
    .screenshot({ path: testInfo.outputPath("computer-technical-details.png") })
  await memory.fill("256")
  await dialog.locator(".machine-settings > details > summary").click()
  await dialog.getByRole("button", { name: "Salvar configurações" }).click()
  await expect(memory).toBeVisible()
  await memory.press("ControlOrMeta+A")
  await memory.pressSequentially("5120")
  await expect(memory).toHaveValue("5120")
  await expect(memory).toBeVisible()
  await expect(memory).toBeFocused()
  await dialog
    .locator(".settings-row:has(#bot-vm-memory)")
    .screenshot({ path: testInfo.outputPath("computer-memory-correction.png") })
})

test("failed task offers scheduling and retry as distinct actions", async ({ page }, testInfo) => {
  await page.goto("/test/e2e/home-harness.html?scenario=failed")
  await expect(page.getByRole("button", { name: "Tentar de novo", exact: true })).toBeVisible()
  await page
    .getByRole("button", { name: "Agendar esta tarefa", exact: true })
    .screenshot({ path: testInfo.outputPath("schedule-action.png") })
  await page.getByRole("button", { name: "Agendar esta tarefa", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Quando?" })
  await expect(dialog.getByRole("textbox", { name: "Tarefa", exact: true })).toHaveValue("Review the campaign")
  await dialog.screenshot({ path: testInfo.outputPath("schedule-task.png") })
  await dialog.getByRole("button", { name: "Cancelar" }).click()
  await page
    .getByRole("button", { name: "Tentar de novo", exact: true })
    .screenshot({ path: testInfo.outputPath("retry-task.png") })
})
