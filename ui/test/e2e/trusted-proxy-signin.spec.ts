import { join } from "node:path"
import AxeBuilder from "@axe-core/playwright"
import { test as base, expect, type Page, type TestInfo } from "@playwright/test"
import { createTrustedProxyServer, trustedProxyHeaders } from "./trusted-proxy-server"

type Server = Awaited<ReturnType<typeof createTrustedProxyServer>>
const test = base.extend<{ server: Server; baselineServer: Server }>({
  // biome-ignore lint/correctness/noEmptyPattern: The fixture runner discovers dependencies from this pattern.
  server: async ({}, use) => {
    const server = await createTrustedProxyServer()
    await use(server)
    await server.dispose()
  },
  // biome-ignore lint/correctness/noEmptyPattern: The fixture runner discovers dependencies from this pattern.
  baselineServer: async ({}, use) => {
    const server = await createTrustedProxyServer({ baselineRoot: process.env.TOURI_PROXY_BASELINE_ROOT })
    await use(server)
    await server.dispose()
  },
})
test.use({ locale: "pt-BR", extraHTTPHeaders: trustedProxyHeaders })

test("trusted identity opens the real app from every sign-in page on desktop and phone", async ({
  page,
  server,
}, testInfo) => {
  test.setTimeout(180_000)
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.addInitScript(() => {
    localStorage.setItem("touri.locale", "pt-BR")
  })

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    for (const path of ["/", "/login", "/join", "/pair"]) {
      await page.context().clearCookies()
      await page.goto(`${server.url}${path}`)

      await expect(page).toHaveURL(`${server.url}/`)
      await expect(page.getByRole("button", { name: "Criar meu primeiro bot", exact: true })).toBeVisible()
      const response = await page.request.get(`${server.url}/api/v1/session`)
      expect(await response.json()).toMatchObject({ person: { id: "owner", email: "owner@example.test" } })
      const cookies = await page.context().cookies()
      expect(cookies.find((cookie) => cookie.name === "touri_device")).toMatchObject({
        httpOnly: true,
        sameSite: "Strict",
      })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      if (path === "/") await saveEvidence(page, testInfo, `after-app-${width}`)
    }
    const audit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()
    expect(audit.violations.filter((issue) => issue.impact === "serious" || issue.impact === "critical")).toEqual([])
  }
})

const baselineRoot = process.env.TOURI_PROXY_BASELINE_ROOT
if (baselineRoot) {
  test("capture the main-branch sign-in screens before trusted sign-in", async ({
    page,
    baselineServer: server,
  }, testInfo) => {
    test.setTimeout(180_000)
    await page.emulateMedia({ reducedMotion: "reduce" })

    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      for (const path of ["/", "/login", "/join", "/pair"]) {
        await page.goto(`${server.url}${path}`)
        await expect(page).toHaveURL(`${server.url}${path}`)
        await expect(page.getByRole("button", { name: "Criar meu primeiro bot", exact: true })).toHaveCount(0)
        if (path === "/join") await expect(page.getByRole("heading", { name: "Entrar no touri" })).toBeVisible()
        await expect(page.getByRole("main")).toBeVisible()
        await saveEvidence(page, testInfo, `before-${path.slice(1) || "root"}-${width}`)
      }
    }
  })
}

const saveEvidence = async (page: Page, testInfo: TestInfo, name: string) => {
  await page.evaluate(() => document.fonts.ready)
  const directory = process.env.TOURI_PROXY_EVIDENCE_DIR
  const path = directory ? join(directory, `${name}.png`) : testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path, animations: "disabled" })
  await testInfo.attach(name, { path, contentType: "image/png" })
}
