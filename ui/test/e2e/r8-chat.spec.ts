import { mkdir } from "node:fs/promises"
import { expect, test } from "@playwright/test"

test.use({ channel: "chromium" })
test.setTimeout(60_000)
const phase = process.env.R8_CHAT_PHASE ?? "after"
const directory = "../docs/qa/r8/chat"

for (const width of [1440, 1100]) {
  for (const theme of ["light", "dark"]) {
    for (const view of ["conversation", "markdown", "long", "history", "empty"]) {
      test(`captura ${view} ${theme} ${width}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 })
        await page.clock.setFixedTime(new Date("2026-10-13T14:30:00Z"))
        await page.emulateMedia({ reducedMotion: "reduce" })
        await page.goto(`/test/e2e/r8-chat-harness.html?view=${view}&theme=${theme}`)
        await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
        if (width === 1100)
          await page.getByRole("button", { name: "Painel do bot", exact: true }).evaluate((element) => {
            if (element.getAttribute("aria-expanded") === "true") (element as HTMLButtonElement).click()
          })
        if (view !== "empty")
          await expect(
            page.locator(".message-assistant > .markdown-content, .chat-message-preview > .markdown-content").first(),
          ).toBeVisible()
        if (view === "conversation")
          await expect(page.locator(".message-assistant").last().locator("strong")).toHaveCount(3)
        if (view === "long" || view === "history")
          await expect(page.getByRole("heading", { name: "Plano de revisão" })).toBeVisible()
        if (view === "markdown") {
          await expect(page.getByRole("table")).toBeVisible()
          await expect(page.locator(".markdown-highlight .shiki, .markdown-code .shiki")).toBeVisible({
            timeout: 20_000,
          })
        }
        if (view === "history" || view === "markdown") {
          await page.locator(".message-scroll").evaluate((element) => {
            element.scrollTop = 0
          })
        }
        if (view === "history") {
          if (phase === "after") await expect(page.getByRole("button", { name: "Voltar ao fim" })).toBeVisible()
          await page.evaluate(() => (window as unknown as { r8Chat: { append: () => void } }).r8Chat.append())
          await expect(page.locator(".message-assistant").last().locator("strong")).toHaveText("Resposta final:")
          if (phase === "after") await expect(page.getByRole("button", { name: "1 nova mensagem" })).toBeVisible()
        }
        await page.evaluate(() => document.fonts.ready)
        await mkdir(directory, { recursive: true })
        await page.screenshot({ path: `${directory}/${phase}-${view}${width === 1100 ? "-1100" : ""}-${theme}.png` })
      })
    }
  }
}

if (phase === "after") {
  test("Markdown, código e raciocínio funcionam por teclado nos dois temas", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 900 })
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
    for (const theme of ["light", "dark"]) {
      await page.goto(`/test/e2e/r8-chat-harness.html?view=markdown&theme=${theme}`)
      await page.getByRole("button", { name: "Painel do bot", exact: true }).evaluate((element) => {
        if (element.getAttribute("aria-expanded") === "true") (element as HTMLButtonElement).click()
      })
      const reasoning = page.locator(".turn-activity-toggle")
      await expect(page.getByRole("button", { name: "Raciocínio", exact: true })).toHaveCount(0)
      await expect(page.locator(".chat-reasoning")).toHaveCount(0)
      await reasoning.focus()
      await page.keyboard.press("Space")
      await expect(reasoning).toHaveAttribute("aria-expanded", "true")
      await expect(page.locator(".chat-reasoning strong")).toHaveText("Plano:")
      await expect(page.getByRole("table")).toBeVisible()
      await expect(page.getByRole("checkbox")).toHaveCount(2)
      const copy = page.getByRole("button", { name: "Copiar código" })
      await copy.click()
      await expect(copy).toHaveText("Copiado")
      expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('tema: "escuro"')
      expect(await page.locator("pre pre").count()).toBe(0)
      expect(
        await page.locator(".message-scroll").evaluate((element) => element.scrollWidth - element.clientWidth),
      ).toBe(0)
    }
  })

  test("resposta longa preserva a âncora, anuncia novas mensagens e permite voltar ao fim", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ reducedMotion: "no-preference" })
    await page.goto("/test/e2e/r8-chat-harness.html?view=long&theme=dark")
    const more = page.getByRole("button", { name: "Mostrar mais" })
    const before = (await more.boundingBox())?.y ?? 0
    await more.focus()
    await page.keyboard.press("Enter")
    const less = page.getByRole("button", { name: "Mostrar menos" })
    await expect(less).toHaveAttribute("aria-expanded", "true")
    await expect.poll(async () => Math.abs(((await less.boundingBox())?.y ?? 0) - before)).toBeLessThan(2)
    await expect(page.getByRole("button", { name: "Voltar ao fim" })).toBeVisible()
    await less.click()
    await expect(more).toHaveAttribute("aria-expanded", "false")
    await expect.poll(async () => Math.abs(((await more.boundingBox())?.y ?? 0) - before)).toBeLessThan(2)
    await more.click()
    await expect(page.getByRole("button", { name: "Voltar ao fim" })).toBeVisible()
    await page.evaluate(() => (window as unknown as { r8Chat: { append: () => void } }).r8Chat.append())
    await page.getByRole("button", { name: "1 nova mensagem" }).click()
    await expect(page.locator(".message-assistant").last()).toBeInViewport()
    await expect(page.locator(".message-assistant").last().locator("strong")).toHaveText("Resposta final:")
    await expect(page.getByRole("button", { name: "Voltar ao fim" })).toHaveCount(0)
  })

  test("expandir ferramentas mantém a leitura e uma nova resposta final continua alcançável (r7 91)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto("/test/e2e/r8-chat-harness.html?view=disclosures&theme=light")
    const tools = page.locator(".turn-activity-toggle")
    await expect(page.locator(".tool-call-card")).toHaveCount(0)
    await expect(tools).toBeVisible()
    const before = (await tools.boundingBox())?.y ?? 0
    await tools.click()
    await page.locator(".turn-activity").getByRole("button", { name: "Detalhes técnicos", exact: true }).click()
    const result = page.locator(".tool-output > .ds-disclosure-trigger").first()
    await result.click()
    await expect.poll(async () => Math.abs(((await tools.boundingBox())?.y ?? 0) - before)).toBeLessThan(2)
    await page.evaluate(() => (window as unknown as { r8Chat: { append: () => void } }).r8Chat.append())
    await page.getByRole("button", { name: "1 nova mensagem" }).click()
    await expect(page.locator(".message-assistant").last()).toBeInViewport()
  })

  test("segue uma resposta final quando já está no fim e sugestões apenas preenchem o rascunho", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto("/test/e2e/r8-chat-harness.html?view=conversation&theme=dark")
    await expect(page.locator(".message-assistant").last().locator("strong")).toHaveCount(3)
    await page.evaluate(() => (window as unknown as { r8Chat: { append: () => void } }).r8Chat.append())
    await expect(page.locator(".message-assistant").last()).toBeInViewport()
    await page.goto("/test/e2e/r8-chat-harness.html?view=empty&theme=light")
    const prompt = page.getByRole("button", { name: "Usar exemplo", exact: true })
    await prompt.click()
    const composer = page.getByRole("textbox", { name: "Mensagem para mark" })
    await expect(composer).toHaveValue(
      /lista em português do Brasil[\s\S]*Comprar café; revisar orçamento; marcar reunião\./,
    )
    await expect(composer).toBeFocused()
    await expect(page.locator(".message-bubble")).toHaveCount(0)
  })
}
