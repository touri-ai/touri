import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

const capture = process.env.APPROVAL_CAPTURE ?? "after"
test.use({ viewport: { width: 1000, height: 900 }, reducedMotion: "reduce", timezoneId: "America/Sao_Paulo" })

for (const theme of ["light", "dark"]) {
  for (const scene of ["thinking", "read", "bash"]) {
    test(`activity and approval: ${scene}, ${theme}`, async ({ page }) => {
      await page.clock.install({ time: new Date("2026-10-13T20:21:00Z") })
      await page.goto(`/test/e2e/approval-harness.html?scene=${scene}`)
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value
      }, theme)
      await page.evaluate(() => document.fonts.ready)
      if (scene === "thinking") await expect(page.locator(".activity-mark")).toBeVisible()
      else await expect(page.getByRole("button", { name: "Negar", exact: true })).toBeVisible()
      await page.screenshot({ path: `../docs/qa/approval-card/${capture}-${scene}-${theme}.png` })
      if (capture === "before") return
      const activity = page.locator(".activity-mark")
      await expect(activity.locator(".activity-mascot .tb-avatar")).toBeVisible()
      await expect(activity.locator("linearGradient")).toHaveCount(0)
      await expect(page.getByRole("progressbar")).toHaveCount(0)
      if (scene === "thinking") {
        await expect(activity.getByRole("status")).toHaveText("Preparando a resposta…")
        await expect(activity.locator(".activity-dots i")).toHaveCount(3)
      } else {
        const pending = page.locator('[data-approval-id="pending"]')
        if (scene === "read") {
          await expect(pending.getByText("Ler arquivo", { exact: true })).toBeVisible()
          await expect(pending.locator(".tool-file-chip")).toHaveText("/workspace/demo/README.md")
          await expect(pending.locator(".tool-input")).toHaveCount(0)
        } else await expect(pending.locator(".tool-input")).toHaveText("printf QA_R7_NEGADO")
        await expect(pending.getByRole("button", { name: "Aprovar", exact: true })).toHaveCSS("appearance", "none")
        await expect(pending).toHaveCSS("border-radius", "14px")
        await expect(activity.locator(".activity-dots")).toHaveCount(0)
        await activity.getByRole("link", { name: "Preciso da sua autorização." }).press("Enter")
        await expect(pending).toBeFocused()
        await expect(pending.locator(".tool-status-chip")).toContainText("Aguardando aprovação")
        await pending.press("Enter")
        await expect(pending.getByRole("button", { name: "Aprovar", exact: true })).toBeVisible()
        await expect(pending.locator(".tool-decision-chip")).toHaveCount(0)
        const cardBeforeDecision = await pending.elementHandle()
        await pending.getByRole("button", { name: "Aprovar", exact: true }).click()
        await expect(activity.getByRole("status")).toHaveText(scene === "read" ? "Lendo README.md…" : "Trabalhando…")
        await expect(activity.getByRole("link")).toHaveCount(0)
        await expect(pending.locator(".tool-decision-chip")).toContainText("Aprovado por você")
        expect(await pending.evaluate((node) => node.closest(".turn-activity"))).toBeNull()
        expect(await pending.evaluate((node, original) => node === original, cardBeforeDecision)).toBe(true)
        await page.screenshot({ path: `../docs/qa/approval-card/after-${scene}-running-${theme}.png` })
      }
      const results = await new AxeBuilder({ page }).analyze()
      expect(results.violations).toEqual([])
      expect(await page.evaluate(() => document.getAnimations().length)).toBe(0)
    })
  }
  test(`approval cards: ${theme} visual evidence`, async ({ page }) => {
    await page.clock.install({ time: new Date("2026-10-13T20:21:00Z") })
    await page.goto("/test/e2e/approval-harness.html")
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value
    }, theme)
    await page.evaluate(() => document.fonts.ready)
    await expect(page.getByRole("button", { name: "Negar", exact: true })).toBeVisible()
    await page.screenshot({ path: `../docs/qa/approval-card/${capture}-${theme}.png` })
    if (capture === "before") return
    const pending = page.locator('[data-approval-id="pending"]')
    await expect(pending.locator(".tool-input")).toHaveText("printf QA_R7_NEGADO")
    await expect(pending.locator(".tool-summary")).toHaveText("Imprimir marcador de teste pendente")
    expect(await pending.evaluate((node) => node.closest(".tool-group"))).toBeNull()
    expect(await pending.evaluate((node) => node.closest(".turn-activity"))).toBeNull()
    const buttons = pending.locator(".tool-action")
    const heights = await buttons.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height))
    expect(new Set(heights).size).toBe(1)
    await expect(pending.getByRole("button", { name: "Aprovar", exact: true })).toHaveCSS(
      "background-color",
      "rgb(220, 38, 38)",
    )
    const approved = page.locator('[data-approval-id="approved"]')
    await expect(approved.locator(".tool-decision-chip")).toContainText("Aprovado por você")
    expect(await approved.evaluate((node) => node.closest(".turn-activity"))).toBeNull()
    await expect(page.locator(".turn-activity .tool-call-card")).toHaveCount(0)
    await page.screenshot({ path: `../docs/qa/approval-card/after-expanded-${theme}.png` })
    await pending.getByRole("button", { name: "Permitir sempre nesta ferramenta" }).click()
    await expect(pending.getByRole("group", { name: /Permissão permanente para/ })).toContainText(
      /sem pedir aprovação novamente/,
    )
    await expect(
      pending.getByRole("button", { name: /Sim, permitir .* neste bot sem perguntar de novo/ }),
    ).toBeVisible()
    await pending.getByRole("button", { name: "Voltar" }).click()
    await pending.focus()
    const results = await new AxeBuilder({ page }).analyze()
    expect(results.violations).toEqual([])
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0)
    await pending.press("Enter")
    await expect(pending.locator(".tool-decision-chip")).toHaveCount(0)
    await pending.getByRole("button", { name: "Aprovar", exact: true }).click()
    await expect(pending.locator(".tool-decision-chip")).toHaveText("Aprovado por você · 17:21")
    await expect(pending).toBeFocused()
    await expect(pending.getByRole("button", { name: "Aprovar", exact: true })).toHaveCount(0)
    await page.screenshot({ path: `../docs/qa/approval-card/after-resolved-${theme}.png` })
  })

  test(`approval cards: ${theme} state gallery and screenshot thumbnail`, async ({ page }) => {
    test.skip(capture === "before")
    await page.setViewportSize({ width: 1000, height: 2000 })
    await page.goto("/test/e2e/approval-harness.html?states")
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value
    }, theme)
    for (const status of ["Executando", "Negado", "Erro", "Encerrado", "Concluído"])
      await expect(page.locator(".tool-status-chip").filter({ hasText: status })).toBeVisible()
    await page.getByRole("button", { name: "Carregar captura de teste" }).click()
    const thumbnail = page.getByRole("img", { name: "Captura de tela da ferramenta", exact: true })
    await expect(thumbnail).toBeVisible({ timeout: 15_000 })
    await expect.poll(() => thumbnail.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await page.locator(".tool-output > summary").first().click()
    await page.locator(".tool-output > summary").last().click()
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: `../docs/qa/approval-card/after-states-${theme}.png`, fullPage: true })
    const screenshotCard = page.getByRole("article", { name: "Ferramenta · Computador" })
    await screenshotCard.screenshot({ path: `../docs/qa/approval-card/after-screenshot-${theme}.png` })
    const download = page.waitForEvent("download")
    await screenshotCard.getByRole("button", { name: "Baixar imagem" }).click()
    expect((await download).suggestedFilename()).toBe("approved-1.png")
    await screenshotCard.getByRole("button", { name: "Abrir captura 1 em tamanho original" }).click()
    const dialog = page.getByRole("dialog", { name: "Captura de tela da ferramenta" })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole("img", { name: "Captura de tela da ferramenta" })).toBeVisible()
    await dialog.getByRole("button", { name: "Fechar imagem" }).click()
    await expect(dialog).not.toBeVisible()
    const results = await new AxeBuilder({ page }).analyze()
    expect(results.violations).toEqual([])
  })
}

test("approval cards: narrow viewport, keyboard handling and motion preference", async ({ page }) => {
  test.skip(capture === "before")
  await page.clock.install({ time: new Date("2026-10-13T20:21:00Z") })
  await page.setViewportSize({ width: 390, height: 800 })
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.goto("/test/e2e/approval-harness.html?scene=thinking")
  await expect(page.locator(".activity-dots i").first()).toHaveCSS("animation-name", "activity-dot")
  await page.emulateMedia({ reducedMotion: "reduce" })
  await expect(page.locator(".activity-dots i").first()).toHaveCSS("animation-name", "none")
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0)
  await page.screenshot({ path: "../docs/qa/approval-card/after-mobile-thinking.png" })
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.goto("/test/e2e/approval-harness.html")
  const pending = page.locator('[data-approval-id="pending"]')
  await expect(pending.getByRole("button", { name: "Negar", exact: true })).toBeVisible()
  expect(await pending.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
  await pending.getByRole("button", { name: "Aprovar", exact: true }).focus()
  await expect(pending.getByRole("button", { name: "Aprovar", exact: true })).toHaveCSS("outline-style", "solid")
  await page.emulateMedia({ reducedMotion: "reduce" })
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0)
  await pending.press("Escape")
  await expect(pending.locator(".tool-decision-chip")).toHaveCount(0)
  await pending.getByRole("button", { name: "Negar", exact: true }).click()
  await expect(pending.locator(".tool-decision-chip")).toContainText("Negado por você")
  await page.screenshot({ path: "../docs/qa/approval-card/after-mobile-denied.png" })
})
