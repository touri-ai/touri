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

test("server recovery keeps the draft and gives server guidance without a macOS action", async ({ page }) => {
  await page.goto("/test/e2e/vault-harness.html?scenario=server")
  await expect(page.getByText(/O cofre local do servidor está indisponível/)).toHaveCount(2)
  await expect(page.getByRole("button", { name: "Permitir acesso ao cofre" })).toHaveCount(0)
  await page.getByRole("textbox").press("Enter")
  await page.getByRole("button", { name: "Verificar de novo" }).click()
  await expect(page.getByRole("textbox")).toHaveValue("Oi! Em uma linha, o que você faz?")
  await expect(page.getByText("Mensagens enviadas: 0")).toBeVisible()
  await page.screenshot({ path: "../docs/qa/vault/server-recovery.png" })
})

test("Doctor offers foreground recovery for the saved browser session key", async ({ page }) => {
  await page.goto("/test/e2e/vault-harness.html?scenario=browser")
  await expect(page.getByText("Navegador · Bot de teste · sessão salva")).toBeVisible()
  await expect(page.getByRole("button", { name: "Permitir acesso ao cofre" })).toHaveCount(1)
  await expect(page.getByText("Permita o acesso ao cofre para restaurar a sessão salva do navegador.")).toBeVisible()
  await page.screenshot({ path: "../docs/qa/vault/browser-recovery.png" })
})
