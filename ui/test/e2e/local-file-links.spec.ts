import { readFile } from "node:fs/promises"
import AxeBuilder from "@axe-core/playwright"
import { expect, type Page, test } from "@playwright/test"

test.use({ channel: "chromium" })

test("chat files open in touri, download checked bytes and show inline errors", async ({ page }, testInfo) => {
  // The first navigation initializes lazy Markdown before exercising file and download I/O.
  test.slow()

  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
    "base64",
  )
  await page.route("**/api/v1/bots/*/images?*", async (route) => {
    const path = new URL(route.request().url()).searchParams.get("path")
    await route.fulfill(
      path === "/output/post.png"
        ? { status: 200, contentType: "image/png", body: png }
        : { status: 404, json: { error: "Arquivo não encontrado" } },
    )
  })
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
  await expect(page.getByRole("img", { name: "Baixar PNG" })).toBeVisible()
  await expect(page.getByRole("img", { name: "planned.png" })).toHaveCount(0)
  await expect(page.getByText(/Prévia indisponível|Tentar novamente/)).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath("generated-image-and-file-links.png") })
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
  const imageDownload = page.waitForEvent("download")
  await page.getByRole("button", { name: "Baixar PNG", exact: true }).click()
  const image = await imageDownload
  expect(image.suggestedFilename()).toBe("post.png")
  const imagePath = await image.path()
  if (!imagePath) throw new Error("Missing image download")
  expect(await readFile(imagePath)).toEqual(png)
  expect(page.url()).toBe(location)
})

const useFileResponses = async (page: Page) => {
  const reads: string[] = []
  await page.route(/\/api\/v1\/bots\/[^/]+\/(?:files\/content|images)\?/, async (route) => {
    const path = new URL(route.request().url()).searchParams.get("path") ?? ""
    reads.push(path)
    const markdown = path === "/workspace/report.md"
    const text = path === "/workspace/report.txt"
    await route.fulfill({
      status: markdown || text ? 200 : 404,
      json:
        markdown || text
          ? {
              name: markdown ? "report.md" : "report.txt",
              mime: markdown ? "text/markdown" : "text/plain",
              base64: btoa(markdown ? "# Saved report" : "Saved plain text"),
            }
          : { error: path === "/workspace/removed-bot.txt" ? "Bot não encontrado" : "Arquivo ou pasta não encontrado" },
    })
  })
  return reads
}

test("server-mode text and Markdown preview guard", async ({ page }) => {
  await useFileResponses(page)
  await page.goto("/test/e2e/markdown-harness.html?view=brace-files&theme=light")
  const location = page.url()

  await page.getByRole("button", { name: "report.md", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Saved report" })).toBeVisible()
  await page.getByRole("button", { name: "Fechar arquivo" }).click()
  await page.getByRole("button", { name: "report.txt", exact: true }).click()
  await expect(page.getByRole("dialog").locator("pre")).toHaveText("Saved plain text")
  expect(page.url()).toBe(location)
  expect(page.context().pages()).toHaveLength(1)
  expect(await page.evaluate(() => "__TAURI_INTERNALS__" in window)).toBe(false)
})

for (const width of [1440, 390]) {
  for (const theme of ["light", "dark"]) {
    test(`brace citations and missing-file feedback ${width} ${theme}`, async ({ page }, testInfo) => {
      const reads = await useFileResponses(page)
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`/test/e2e/markdown-harness.html?view=brace-files&theme=${theme}`)
      const location = page.url()

      await expect(page.getByText("/workspace/report-{analysis,draft}.txt", { exact: true })).toBeVisible()
      await expect(page.getByRole("button", { name: /\{analysis,draft\}|\{1\.\.3\}/ })).toHaveCount(0)
      await expect(page.getByText("/workspace/report-{analysis,{draft}}.txt", { exact: true })).toBeVisible()
      await expect(page.getByRole("button", { name: /\{analysis,\{draft\}\}|Relatórios aninhados/ })).toHaveCount(0)
      await expect(page.getByRole("link", { name: "Relatórios aninhados", exact: true })).toHaveCount(0)
      await expect(page.getByText("Baixar relatórios")).toBeVisible()
      await expect(page.getByRole("button", { name: "Baixar relatórios", exact: true })).toHaveCount(0)
      await expect(page.getByRole("link", { name: "Referência", exact: true })).toHaveAttribute(
        "href",
        "https://example.test/report.md",
      )
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      expect(reads).toEqual([])
      await page.getByRole("button", { name: "Arquivo ausente", exact: true }).click()
      await expect(page.getByRole("alert")).toHaveText("Arquivo não encontrado.")
      expect(reads).toEqual(["/workspace/missing.txt"])
      expect(page.url()).toBe(location)
      await page.screenshot({ path: testInfo.outputPath(`brace-files-${width}-${theme}.png`), fullPage: true })
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
      await page.getByRole("button", { name: "Bot removido", exact: true }).click()
      await expect(page.getByRole("alert").last()).toContainText("removido")
      await expect(page.getByRole("alert").last()).not.toContainText("Arquivo não encontrado.")
    })
  }
}
