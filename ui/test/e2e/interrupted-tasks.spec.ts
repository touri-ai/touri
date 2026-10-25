import { expect, test } from "@playwright/test"

test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus)
    await page.screenshot({ path: info.outputPath(`interrupted-tasks-${page.viewportSize()?.width}.png`) })
})

test("the first interrupted-task dialog returns focus after its details load", async ({ page }) => {
  const release = Promise.withResolvers<void>()
  await page.route("**/src/components/InterruptedTasks.tsx", async (route) => {
    await release.promise
    await route.continue()
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto("/?mockScenario=interrupted-tasks")
  const opener = page.getByRole("button", { name: /^Tarefas interrompidas/ })

  await opener.click()
  await expect(page.getByRole("dialog").getByRole("status")).toBeVisible()
  release.resolve()
  const center = page.getByRole("dialog", { name: "Tarefas interrompidas", exact: true })
  await expect(center.getByTestId("interrupted-task")).toHaveCount(3)
  await page.keyboard.press("Escape")

  await expect(center).toHaveCount(0)
  await expect(opener).toBeFocused()
})

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
    const unkeyed = center.getByRole("region", { name: "mark" }).getByTestId("interrupted-task")
    await unkeyed.getByRole("button", { name: /Ver ações realizadas/ }).click()
    await expect(unkeyed.getByRole("checkbox")).toBeVisible()
    await expect(unkeyed.getByRole("button", { name: "Descartar" })).toBeDisabled()
    await unkeyed.getByRole("checkbox").check()
    await expect(unkeyed.getByRole("button", { name: "Descartar" })).toBeEnabled()
    await unkeyed.getByRole("checkbox").uncheck()
    await expect(unkeyed.getByRole("button", { name: "Descartar" })).toBeDisabled()

    const journal = center.getByRole("region", { name: "onb" }).getByTestId("interrupted-task")

    await journal.getByRole("button", { name: /Ver ações realizadas/ }).click()
    await expect(journal.getByText("Prévia do projeto")).toBeVisible()
    await expect(journal.getByRole("button", { name: "Descartar" })).toBeDisabled()
    await journal.getByRole("checkbox").check()
    await journal.getByRole("button", { name: "Descartar" }).click()
    await expect(center.getByText("Interrupções resolvidas", { exact: false })).toBeVisible()
    await expect(center.getByRole("checkbox")).toHaveCount(1)
    const bounds = await center.boundingBox()
    expect(bounds?.width).toBeLessThanOrEqual(viewport.width)
    await center.getByText("Interrupções resolvidas", { exact: false }).click()
    await expect(center.getByText("Interrupção anterior · resolvida")).toHaveCount(1)
    await expect(unkeyed.getByRole("checkbox")).not.toBeChecked()
    if (process.env.TOURI_SCREENSHOT_DIR)
      await page.screenshot({ path: `${process.env.TOURI_SCREENSHOT_DIR}/recovery-center-${viewport.width}.png` })
    await center.getByRole("button", { name: "Retomar tarefa" }).first().click()
    await expect(center).toHaveCount(0)
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toHaveValue(
      "Conferi as ações registradas. Quero continuar a tarefa a partir do estado atual, sem repetir ações já concluídas.",
    )
  })
}

for (const width of [1440, 390]) {
  test(`bell preserves uncertain work and chat keeps resolved errors at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.goto("/?mockScenario=interrupted-tasks")
    if (width === 390) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    await page.getByRole("button", { name: /Notificações,/ }).click()
    const bell = page.getByRole("region", { name: "Central de notificações" })

    await bell.getByRole("button", { name: "Limpar", exact: true }).click()
    await expect(bell.getByRole("button", { name: "Limpar", exact: true })).toBeEnabled()
    if (process.env.TOURI_SCREENSHOT_DIR)
      await page.screenshot({ path: `${process.env.TOURI_SCREENSHOT_DIR}/recovery-bell-${width}.png` })

    await expect(bell.getByRole("status")).toContainText(
      "Notificações que precisam de revisão em Tarefas interrompidas: 1.",
    )
    await expect(bell.getByTestId("notification-row")).toHaveCount(1)
    await bell.getByRole("button", { name: "Fechar notificações" }).click()
    if (width === 390) await page.getByRole("button", { name: "Fechar menu", exact: true }).click()
    const chat = page.getByTestId("virtual-message-list")
    await expect(chat.getByText("Interrupção anterior · resolvida", { exact: true })).toBeVisible()
    await chat.getByRole("button", { name: "Ver erro", exact: true }).click()
    await expect(chat.locator(".message-error-history [role=alert]")).toBeVisible()
    if (process.env.TOURI_SCREENSHOT_DIR)
      await page.screenshot({ path: `${process.env.TOURI_SCREENSHOT_DIR}/recovery-error-${width}.png` })
  })
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`recovered interruption details stay readable at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.goto("/?mockScenario=interrupted-tasks")
    const chat = page.getByTestId("virtual-message-list")
    const status = chat.locator(".message-error-history > button")

    await expect(status).toBeVisible()
    await expect(status).toContainText("Ver detalhes")
    const geometry = await status.evaluate((button) => {
      const range = document.createRange()
      range.selectNodeContents(button)
      const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)))
      return { clientWidth: button.clientWidth, scrollWidth: button.scrollWidth, lines: lines.size }
    })
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth)
    if (viewport.width === 390) expect(geometry.lines).toBeGreaterThan(1)
    else expect(geometry.lines).toBe(1)

    await status.click()
    await expect(chat.locator(".message-error-history [role=alert]")).toContainText(
      "A resposta foi interrompida. Algumas ações podem ter sido concluídas.",
    )
  })
}

for (const width of [1440, 390]) {
  test(`notification bell stays responsive at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.goto("/?mockScenario=interrupted-tasks")
    if (width === 390) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    const bell = page.getByRole("button", { name: /Notificações,/ })
    await bell.click()
    await page.getByRole("button", { name: "Fechar notificações" }).click()

    const timing = await page.evaluate(async () => {
      const button = document.querySelector(".notification-bell")
      if (!(button instanceof HTMLButtonElement)) throw new Error("Missing notification bell")
      // The measurement owns these fixed-size buffers; observers stop after twenty interactions.
      const samples: number[] = []
      const longTasks: number[] = []
      const shifts: number[] = []
      const tasks = new PerformanceObserver((list) => {
        list.getEntries().forEach((entry) => {
          longTasks.push(entry.duration)
        })
      })
      const layout = new PerformanceObserver((list) => {
        list.getEntries().forEach((entry) => {
          const shift = entry as PerformanceEntry & { value: number }
          shifts.push(shift.value)
        })
      })
      tasks.observe({ type: "longtask" })
      layout.observe({ type: "layout-shift" })
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      for (let index = 0; index < 20; index += 1) {
        await frame()
        const start = performance.now()
        button.click()
        await frame()
        samples.push(performance.now() - start)
        if (button.getAttribute("aria-expanded") !== String(index % 2 === 0))
          throw new Error("Notification interaction did not complete in one frame")
      }
      await frame()
      tasks.disconnect()
      layout.disconnect()
      samples.sort((left, right) => left - right)

      return {
        p95Ms: samples[Math.ceil(samples.length * 0.95) - 1],
        maxMs: samples.reduce((maximum, sample) => Math.max(maximum, sample), 0),
        longTasks: longTasks.filter((duration) => duration > 50).length,
        cls: shifts.reduce((total, shift) => total + shift, 0),
      }
    })

    console.info(`Notification interaction ${width}px: ${JSON.stringify(timing)}`)
    expect(timing.p95Ms).toBeLessThan(100)
    expect(timing.longTasks).toBe(0)
    expect(timing.cls).toBeLessThan(0.01)
  })
}
