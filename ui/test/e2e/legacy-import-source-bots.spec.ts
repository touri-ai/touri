import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import AxeBuilder from "@axe-core/playwright"
import { test as base, expect } from "@playwright/test"
import { openGlobalPage } from "./home-navigation"
import { createServerModeFixture } from "./server-mode-fixture"

type ImportServer = Awaited<ReturnType<typeof createServerModeFixture>>
const test = base.extend<{ server: ImportServer; source: string }>({
  // biome-ignore lint/correctness/noEmptyPattern: The isolated server fixture has no dependencies.
  server: async ({}, use) => use(await createServerModeFixture()),
  // biome-ignore lint/correctness/noEmptyPattern: The archive fixture has no dependencies.
  source: async ({}, use) => {
    const source = await mkdtemp(join(tmpdir(), "touri-legacy-source-"))
    await cp(resolve(import.meta.dirname, "../../../sidecar/test/fixtures/legacy"), source, { recursive: true })
    // Keep screenshots independent of the host workspace path.
    const botsPath = join(source, "bots.json")
    const bots: Array<Record<string, unknown>> = JSON.parse(await readFile(botsPath, "utf8"))
    await writeFile(botsPath, JSON.stringify(bots.map((bot) => ({ ...bot, cwd: null }))))
    await use(source)
  },
})

test.setTimeout(180_000)
test.afterEach(async ({ server, source }) => {
  await server.dispose()
  await rm(source, { recursive: true, force: true })
})

for (const width of [1440, 390]) {
  for (const theme of ["dark", "light"] as const) {
    test(`legacy source bots import ${width} ${theme}`, async ({ page, server, source }, info) => {
      await server.api("/bots", "POST", { name: "mark", provider: "codex" })
      await server.install(page)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await page.goto(server.relayUrl)
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value
      }, theme)
      if (width === 390) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
      await openGlobalPage(page, "Importar")
      await page.locator("#legacy-root").fill(source)
      await page.getByRole("button", { name: "Continuar", exact: true }).click()
      await page.screenshot({ path: info.outputPath(`${width}-${theme}-source-bots.png`), animations: "disabled" })
      await page.getByRole("button", { name: "Revisar importação", exact: true }).click()
      const request = page.waitForRequest(
        (request) => request.url().endsWith("/imports/legacy") && request.method() === "POST",
      )
      await page.getByRole("button", { name: "Importar agora", exact: true }).click()
      expect((await request).postDataJSON().botIds).toEqual([])
      await expect(page.locator(".success-card")).toContainText("11 mensagens", { timeout: 30_000 })
      await expect(page.locator(".success-card")).toContainText("5 conversas")
      await page.screenshot({ path: info.outputPath(`${width}-${theme}-imported.png`), animations: "disabled" })
      const audit = await new AxeBuilder({ page })
        .include(".modal-card")
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
      expect(audit.violations).toEqual([])
      expect(await page.locator(".modal-card").evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
        false,
      )
    })
  }
}
