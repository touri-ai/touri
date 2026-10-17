import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"

test.use({ channel: "chromium", viewport: { width: 1100, height: 840 }, reducedMotion: "reduce" })
const phase = process.env.SAVED_OUTPUT_PHASE === "before" ? "before" : "after"
const evidence = resolve(import.meta.dirname, "../../../docs/qa/write-path")
const output = `Resumo: 300 etapas concluídas.\n${"Etapa finalizada com sucesso.\n".repeat(3000)}Última linha preservada.`
const bytes = Buffer.from(output)

for (const theme of ["light", "dark"]) {
  test(`saved output preview and explicit bounded pages · ${theme}`, async ({ page }, info) => {
    const requests: Array<{ offset: number; limit: number }> = []
    let fullReads = 0
    await page.route("**/api/v1/attachments/saved-output**", async (route) => {
      const url = new URL(route.request().url())
      if (!url.pathname.endsWith("/content")) {
        fullReads += 1
        await route.fulfill({ contentType: "text/plain", body: output })
        return
      }
      const offset = Number(url.searchParams.get("offset") ?? 0)
      const limit = Number(url.searchParams.get("limit") ?? 65536)
      requests.push({ offset, limit })
      const end = Math.min(offset + limit, bytes.length)
      // The first page ends on ASCII, matching a valid durable-output cursor.
      await route.fulfill({
        json: {
          text: bytes.subarray(offset, end).toString("utf8"),
          offset,
          nextOffset: end < bytes.length ? end : null,
          bytes: bytes.length,
        },
      })
    })
    await page.goto(`/test/e2e/saved-output-harness.html?theme=${theme}`)
    const card = page.locator('[data-call-id="saved-output"]')
    await expect(card.getByRole("button", { name: "Abrir resultado completo" })).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    mkdirSync(evidence, { recursive: true })
    if (phase === "after") await expect(card).toContainText("Todos os resultados foram preservados.")
    expect(requests).toEqual([])
    expect(fullReads).toBe(0)
    const preview = `${evidence}/${phase}-saved-output-preview-${theme}.png`
    await card.screenshot({ path: preview, animations: "disabled" })
    await info.attach(`${phase}-preview-${theme}`, { path: preview, contentType: "image/png" })
    await card.getByRole("button", { name: "Abrir resultado completo" }).click()
    await card.locator(".tool-output > summary").click()
    await expect(card.locator(".tool-output code")).toContainText("Resumo: 300 etapas concluídas.")
    if (phase === "after") {
      expect(fullReads).toBe(0)
      expect(requests).toEqual([{ offset: 0, limit: 65536 }])
      await expect(card.getByRole("button", { name: "Carregar mais saída" })).toBeVisible()
      const pageEvidence = `${evidence}/after-saved-output-page-${theme}.png`
      await card.screenshot({ path: pageEvidence, animations: "disabled" })
      await info.attach(`after-page-${theme}`, { path: pageEvidence, contentType: "image/png" })
      await card.getByRole("button", { name: "Carregar mais saída" }).click()
      await expect(card.getByRole("button", { name: "Carregar mais saída" })).toHaveCount(0)
      expect(requests).toEqual([
        { offset: 0, limit: 65536 },
        { offset: 65536, limit: 65536 },
      ])
    } else {
      expect(fullReads).toBe(1)
      expect(requests).toEqual([])
    }
    await card.getByRole("button", { name: "Mostrar saída completa" }).click()
    await expect(card.locator(".tool-output code")).toContainText("Última linha preservada.")
    await card.locator(".tool-output .tool-code-region").evaluate((node) => {
      node.scrollTop = node.scrollHeight
    })
    const complete = `${evidence}/${phase}-saved-output-full-${theme}.png`
    await card.screenshot({ path: complete, animations: "disabled" })
    await info.attach(`${phase}-full-${theme}`, { path: complete, contentType: "image/png" })
  })
}
