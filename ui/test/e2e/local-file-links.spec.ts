import { readFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"

test.use({ channel: "chromium" })

test("chat files open in touri, download checked bytes and show inline errors", async ({ page }, testInfo) => {
  await page.route("**/api/v1/bots/*/files/content?*", async (route) => {
    const path = new URL(route.request().url()).searchParams.get("path")
    await route.fulfill({
      status: path === "/workspace/notas.md" ? 200 : path?.startsWith("/outside/") ? 403 : 422,
      json:
        path === "/workspace/notas.md"
          ? { name: "notas.md", mime: "text/markdown", base64: btoa("# Notas salvas\n\nArquivo aberto no touri.") }
          : { error: "NOT_FOUND" },
    })
  })
  await page.goto("/test/e2e/markdown-harness.html?view=files&theme=light")
  const location = page.url()
  await page.getByRole("button", { name: "notas.md", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Notas salvas" })).toBeVisible()
  expect(page.url()).toBe(location)
  expect(page.context().pages()).toHaveLength(1)
  await page.screenshot({ path: testInfo.outputPath("local-file-preview.png") })
  const download = page.waitForEvent("download")
  await page.getByRole("button", { name: "Baixar arquivo" }).click()
  const saved = await download
  expect(saved.suggestedFilename()).toBe("notas.md")
  const path = await saved.path()
  if (!path) throw new Error("Missing download")
  expect(await readFile(path, "utf8")).toBe("# Notas salvas\n\nArquivo aberto no touri.")
  await page.getByRole("button", { name: "Fechar arquivo" }).click()
  await page.getByRole("button", { name: "Arquivo removido" }).click()
  await expect(page.getByRole("alert")).toContainText("removido")
  await expect(page.getByRole("alert")).not.toContainText("NOT_FOUND")
  await page.getByRole("button", { name: "Sem acesso" }).click()
  await expect(page.getByRole("alert").last()).toContainText("pastas permitidas")
  expect(page.url()).toBe(location)
})
