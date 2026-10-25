import { spawn } from "node:child_process"
import { expect, test } from "@playwright/test"
import type { Bot, Thread } from "@touri/contracts"
import { showWorkMode } from "./home-navigation"
import { createWorkGoldenServer } from "./work-golden-server"

let server: Awaited<ReturnType<typeof createWorkGoldenServer>> | null = null

test.afterEach(async () => {
  await server?.dispose()
  server = null
})

const seedHistory = (data: string, threadId: string, scenario: string) =>
  new Promise<void>((done, reject) => {
    const child = spawn("bun", ["ui/test/e2e/message-search-store-fixture.ts", data, threadId, scenario], {
      cwd: new URL("../../..", import.meta.url),
      stdio: "ignore",
      timeout: 30_000,
    })
    child.once("error", reject)
    child.once("exit", (code) => (code === 0 ? done() : reject(new Error("Synthetic history initialization failed"))))
  })

for (const width of [1440, 390]) {
  for (const scenario of ["active", "branch"]) {
    test(`authenticated message search reveals an unmounted historical message: ${scenario} at ${width}px`, async ({
      page,
    }, info) => {
      test.setTimeout(180_000)
      const current = await createWorkGoldenServer()
      server = current
      const { bot } = (await current.api("/bots", "POST", {
        name: "Brisa QA",
        provider: "codex",
        access: "read-only",
        approvals: "on-request",
      })) as { bot: Bot }
      const { threads } = (await current.api(`/bots/${bot.id}/threads`)) as { threads: Thread[] }
      const thread = threads[0]
      if (!thread) throw new Error("Missing synthetic conversation")
      await current.restart((data) => seedHistory(data, thread.id, scenario))
      const search = (await current.api("/search?q=nota-qa.txt")) as { hits: Array<{ messageId: string }> }
      expect(search.hits.some((hit) => hit.messageId === "real-search-8")).toBe(true)
      await current.install(page)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ reducedMotion: "reduce" })
      await page.goto(`${current.serverUrl}/?bot=${bot.id}&thread=${thread.id}`)
      const composer = page.getByRole("textbox", { name: "Mensagem para Brisa QA" })
      await expect(composer).toBeVisible({ timeout: 30_000 })
      await showWorkMode(page)
      const drawer = page.getByRole("dialog", { name: "Barra lateral", exact: true })
      if (await drawer.isVisible()) await page.keyboard.press("Escape")
      await composer.fill("Rascunho fictício preservado.")
      const target = page.locator('[data-message-row="real-search-8"]')
      await expect(target).toHaveCount(0)
      await page.keyboard.press("Control+k")
      await page.getByRole("combobox", { name: "Buscar bots, conversas e configurações" }).fill("nota-qa.txt")
      const result = page.locator('[data-palette-item="message:real-search-8"]')
      await expect(result).toBeVisible()

      await result.click()

      await expect(target).toBeInViewport()
      await expect(target).toContainText("Conteúdo fictício preservado até o fim da resposta.")
      await expect(composer).toHaveValue("Rascunho fictício preservado.")
      expect(await page.locator("[data-message-row]").count()).toBeLessThanOrEqual(34)
      const { threads: saved } = (await current.api(`/bots/${bot.id}/threads`)) as { threads: Thread[] }
      expect(saved.find((item) => item.id === thread.id)?.activeLeafId).toBe("real-search-239")
      const imageName =
        scenario === "active" ? `real-message-search-${width}.png` : `real-message-search-branch-${width}.png`
      const path = process.env.TOURI_SCREENSHOT_DIR
        ? `${process.env.TOURI_SCREENSHOT_DIR}/${imageName}`
        : info.outputPath(imageName)
      await page.screenshot({
        path,
        animations: "disabled",
        mask: [page.locator(".composer-model")],
        maskColor: "#222222",
      })
      await info.attach(`real message search ${width}`, { path, contentType: "image/png" })
    })
  }

  test(`paged branch controls keep chronological order at ${width}px`, async ({ page }, info) => {
    test.setTimeout(180_000)
    const current = await createWorkGoldenServer()
    server = current
    const { settings } = await current.api("/settings")
    const { bot } = (await current.api("/bots", "POST", {
      name: "Brisa QA",
      provider: settings.defaultProvider,
      access: "read-only",
      approvals: "on-request",
    })) as { bot: Bot }
    const threadId = bot.mainThreadId
    if (!threadId) throw new Error("Missing synthetic conversation")
    await current.restart((data) => seedHistory(data, threadId, "branch"))
    await current.install(page)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.emulateMedia({ reducedMotion: "reduce" })

    await page.goto(`${current.serverUrl}/?bot=${bot.id}&thread=${threadId}`)

    const target = page.locator('[data-message-row="real-search-other-branch"]')
    await expect(target).toBeVisible({ timeout: 30_000 })
    const previous = target.getByRole("button", { name: "Ramificação anterior" })
    await expect(previous).toBeEnabled()
    await expect(target.getByRole("button", { name: "Próxima ramificação" })).toBeDisabled()
    await expect(target.locator(".branch-switcher")).toContainText("2/2")
    const imageName = `history-branch-order-${width}.png`
    const path = process.env.TOURI_SCREENSHOT_DIR
      ? `${process.env.TOURI_SCREENSHOT_DIR}/${imageName}`
      : info.outputPath(imageName)
    await page.screenshot({ path, animations: "disabled", mask: [page.locator(".composer-model")] })
    await info.attach(imageName, { path, contentType: "image/png" })
    await previous.click()
    await expect(page.locator('[data-message-row="real-search-239"]')).toBeVisible()
    const { threads } = (await current.api(`/bots/${bot.id}/threads`)) as { threads: Thread[] }
    expect(threads.find((thread) => thread.id === threadId)?.activeLeafId).toBe("real-search-239")
  })
}
