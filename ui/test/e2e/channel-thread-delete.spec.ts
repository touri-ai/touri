import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { expect, test } from "@playwright/test"

test.use({ channel: "chromium", locale: "pt-BR", reducedMotion: "reduce" })
for (const width of [1440, 390]) {
  test(`channel subthread deletion persists at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("/test/e2e/channel-thread-delete-harness.html")
    if (width === 390) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    const actions = page.getByRole("button", { name: "Ações da conversa Publicação diária" })
    await expect(actions).toBeVisible()
    await actions.click()
    await page.getByRole("menuitem", { name: "Apagar conversa…" }).click()
    const dialog = page.getByRole("alertdialog")
    await expect(dialog).toBeVisible()
    if (process.env.TOURI_E2E_EVIDENCE_DIR) {
      await mkdir(process.env.TOURI_E2E_EVIDENCE_DIR, { recursive: true })
      await writeFile(join(process.env.TOURI_E2E_EVIDENCE_DIR, `channel-delete-${width}.png`), await page.screenshot())
    }
    await dialog.getByRole("button", { name: "Apagar", exact: true }).click()
    await expect(actions).toHaveCount(0)
    await expect(dialog).toHaveCount(0)
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            JSON.parse(localStorage.getItem("touri.workspace.v1") ?? "{}").threadId ===
            document.getElementById("root")?.dataset.mainThreadId,
        ),
      )
      .toBe(true)
    await page.reload()
    if (width === 390) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    await expect(page.getByRole("button", { name: /^Publicações/ }).first()).toBeVisible()
    await expect(page.getByRole("button", { name: "Ações da conversa Publicação diária" })).toHaveCount(0)
  })
}
