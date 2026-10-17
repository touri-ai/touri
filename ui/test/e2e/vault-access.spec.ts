import { expect, test } from "@playwright/test"

test.use({ viewport: { width: 1200, height: 900 }, reducedMotion: "reduce" })
test("chat and Doctor offer explicit vault authorization, then send the preserved draft once", async ({ page }) => {
  await page.goto("/test/e2e/vault-harness.html")
  const buttons = page.getByRole("button", { name: "Permitir acesso ao cofre" })
  await expect(buttons).toHaveCount(2)
  await expect(page.getByText("claude setup-token")).not.toBeVisible()
  await page.getByRole("textbox").press("Enter")
  await expect(page.getByText("Mensagens enviadas: 0")).toBeVisible()
  await page.screenshot({ path: "../docs/qa/vault/recovery.png" })
  await page.evaluate(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {
        invoke: async (command: string) => {
          if (command !== "vault_authorize") throw new Error("unexpected native command")
          window.dispatchEvent(new Event("vault-probe-allowed"))
        },
      },
    })
  })
  await buttons.first().click()
  await expect(page.getByText("Mensagens enviadas: 1")).toBeVisible()
  await expect(page.getByRole("textbox")).toHaveValue("")
  await page.screenshot({ path: "../docs/qa/vault/resumed.png" })
})
