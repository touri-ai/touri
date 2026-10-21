import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"

test.use({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" })

test("history restoration keeps plumbing out of the resumed conversation", async ({ page }, info) => {
  await page.goto("/test/e2e/r8-chat-harness.html?view=recovery&theme=light")
  const transcript = page.getByTestId("virtual-message-list")
  await expect(transcript.getByText("O contexto da conversa foi recuperado do histórico salvo.")).toHaveCount(0)
  await expect(transcript.getByText("Prepare o relatório mensal e confira os totais.")).toBeVisible()
  await expect(transcript.getByText("Retomei a conferência.", { exact: false })).toBeVisible()
  await expect(transcript.getByRole("button", { name: "Detalhes técnicos" })).toHaveCount(0)
  await page.evaluate(() => document.fonts.ready)
  const directory = resolve(import.meta.dirname, "../../../docs/evidence/issue-249")
  mkdirSync(directory, { recursive: true })
  const path = `${directory}/context-restored.png`
  await transcript.screenshot({ path, animations: "disabled" })
  await info.attach("Restored conversation", { path, contentType: "image/png" })
})
