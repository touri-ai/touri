import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { expect, test } from "@playwright/test"
import { build } from "vite"
import { createOnboardingFixture } from "./onboarding-fixture"

test.setTimeout(240_000)
test.skip(
  process.env.TOURI_ONBOARDING_CAPTURE_BEFORE !== "1",
  "Before screenshots require an explicit evidence run with main history",
)
const root = resolve(import.meta.dirname, "../../..")
const disposables = new Set<() => Promise<unknown>>()
test.afterEach(async () => {
  for (const dispose of disposables) await dispose()
  disposables.clear()
})

test("first-run before: main UI on desktop and phone with disposable local data", async ({ page }, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), "touri-onboarding-before-"))
  disposables.add(() => rm(directory, { recursive: true, force: true }))
  const sources = await Promise.all(
    ["App.tsx", "index.ts", "i18n.ts", "features/server/ServerModeSettings.tsx"].map(async (file) => {
      const { stdout } = await promisify(execFile)("git", ["show", `origin/main:ui/src/${file}`], {
        cwd: root,
        maxBuffer: 2_000_000,
      })
      return { path: join(root, "ui/src", file), source: stdout }
    }),
  )
  await build({
    root: join(root, "ui"),
    configFile: join(root, "ui/vite.config.ts"),
    logLevel: "error",
    build: { outDir: directory },
    plugins: [
      {
        name: "onboarding-before-main",
        enforce: "pre",
        transform: (_source, id) => sources.find((source) => source.path === id)?.source,
      },
    ],
  })
  const fixture = await createOnboardingFixture({ uiDirectory: directory })
  disposables.add(fixture.dispose)
  await fixture.install(page)
  const evidence = process.env.TOURI_E2E_EVIDENCE_DIR ?? join(root, "docs/qa/onboarding")
  await mkdir(evidence, { recursive: true })
  for (const [device, width, height, theme] of [
    ["desktop", 1440, 900, "light"],
    ["phone", 390, 844, "light"],
    ["desktop-dark", 1440, 900, "dark"],
    ["phone-dark", 390, 844, "dark"],
  ] as const) {
    await page.setViewportSize({ width, height })
    await page.goto(fixture.url)
    await page.evaluate((theme) => {
      localStorage.setItem("touri.appearance.v1", theme)
      window.dispatchEvent(new Event("storage"))
    }, theme)
    await expect(page.getByRole("button", { name: "Criar meu primeiro bot" })).toBeVisible()
    await expect(page.getByRole("button", { name: /Começar neste computador/ })).toHaveCount(0)
    const path = join(evidence, `${device}-before.png`)
    await testInfo.attach(`${device}-before`, { body: await page.screenshot({ path }), contentType: "image/png" })
    await page.getByRole("button", { name: "Usar um servidor touri", exact: true }).click()
    await expect(page.getByRole("region", { name: "Usar um servidor touri", exact: true })).toBeVisible()
    await testInfo.attach(`${device}-settings-before`, {
      body: await page.screenshot({ path: join(evidence, `${device}-settings-before.png`) }),
      contentType: "image/png",
    })
  }
})
