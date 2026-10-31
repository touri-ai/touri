import { execFile } from "node:child_process"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { test as base, expect } from "@playwright/test"
import { createGuideBuild } from "./onboarding-guide-build"
import { installGuideMocks } from "./onboarding-guide-mocks"

const test = base.extend<{ legacyUrl: string }>({
  legacyUrl: async ({ browserName }, use) => {
    const fixture = await createGuideBuild("legacy", await getLegacySources(), browserName)
    await use(fixture.url)
    await fixture.stop()
  },
})
test.setTimeout(180_000)
test("onboarding guide before: unchanged main welcome with synthetic data", async ({ page, legacyUrl }, info) => {
  await installGuideMocks(page)
  await page.route("**/api/v1/onboarding", (route) =>
    route.fulfill({
      json:
        route.request().method() === "POST"
          ? { completed: true, url: "https://local.example.ts.net:8445/" }
          : { completed: false, hasData: false, tailscale: "ready", remoteUrl: null },
    }),
  )
  await page.route("**/api/v1/onboarding/servers", (route) =>
    route.fulfill({ json: { servers: [], tailscale: "ready" } }),
  )
  await page.route("**/api/v1/onboarding/pair-code", (route) => route.fulfill({ json: { code: "TEST-CODE" } }))
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 })
    await page.goto(legacyUrl)
    await expect(page.getByRole("heading", { name: "Seus bots, perto de você" })).toBeVisible()
    await page.screenshot({
      path: join(process.env.TOURI_ONBOARDING_EVIDENCE_DIR ?? info.outputDir, `before-welcome-${width}.png`),
    })
    await page.getByRole("button", { name: /Usar meu servidor/ }).click()
    await page.screenshot({
      path: join(process.env.TOURI_ONBOARDING_EVIDENCE_DIR ?? info.outputDir, `before-location-${width}.png`),
    })
    await page.getByRole("button", { name: /Conectar ao meu servidor/ }).click()
    await page.screenshot({
      path: join(process.env.TOURI_ONBOARDING_EVIDENCE_DIR ?? info.outputDir, `before-connect-${width}.png`),
    })
    await page.getByRole("textbox", { name: "Endereço do servidor" }).fill("https://server.example.com")
    await page.getByRole("button", { name: "Conectar ao servidor", exact: true }).click()
    await page.screenshot({
      path: join(process.env.TOURI_ONBOARDING_EVIDENCE_DIR ?? info.outputDir, `before-pair-${width}.png`),
    })
    await page.getByRole("button", { name: "← Voltar", exact: true }).click()
    await page.getByRole("button", { name: "← Voltar", exact: true }).click()
    await page.getByRole("button", { name: /Rodar neste/ }).click()
    await page.getByRole("textbox", { name: "Seu nome", exact: true }).fill("Pessoa Exemplo")
    await page.getByRole("textbox", { name: "Seu email", exact: true }).fill("person@example.com")
    await page.getByRole("switch").check()
    await page.screenshot({
      path: join(process.env.TOURI_ONBOARDING_EVIDENCE_DIR ?? info.outputDir, `before-run-here-${width}.png`),
    })
    await page.getByRole("button", { name: "Começar", exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({
      path: join(process.env.TOURI_ONBOARDING_EVIDENCE_DIR ?? info.outputDir, `before-run-here-end-${width}.png`),
    })
    await page.getByRole("button", { name: "Começar", exact: true }).click()
    await expect(page.getByRole("heading", { name: "Pronto para acessar de outro aparelho" })).toBeVisible()
    await page.screenshot({
      path: join(process.env.TOURI_ONBOARDING_EVIDENCE_DIR ?? info.outputDir, `before-access-${width}.png`),
    })
  }
})

const getLegacySources = async () => {
  const root = resolve(import.meta.dirname, "../../..")
  const paths = ["ui/src/features/onboarding/Onboarding.tsx", "ui/src/features/onboarding/onboarding.css"]
  return Promise.all(
    paths.map(async (path) => ({
      path: join(root, path),
      source: (await promisify(execFile)("git", ["show", `origin/main:${path}`], { cwd: root })).stdout,
    })),
  )
}
