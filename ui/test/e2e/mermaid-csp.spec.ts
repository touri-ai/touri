import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { dirname, extname, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"
import { expect, test, webkit } from "@playwright/test"
import type { Manifest } from "vite"

test.use({ channel: "chromium" })
const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const output = resolve(uiRoot, "dist")
let server: Server | undefined
let endpoint = ""
let adapterFile = ""
let initialGzipBytes = 0
let csp = ""

test.describe("mermaid production and desktop CSP", () => {
  test.skip(process.env.CHAT_TRANSCRIPT_PHASE === "before", "Capture the existing renderer before integration")

  test.beforeAll(async () => {
    // All production fixtures share the build from global setup; payload and CSP checks stay independent.
    const manifest = JSON.parse(await readFile(resolve(output, ".vite/manifest.json"), "utf8")) as Manifest
    const initialFiles = new Set<string>()
    const visited = new Set<string>()
    const visit = (key: string) => {
      if (visited.has(key)) return
      visited.add(key)
      const chunk = manifest[key]
      if (!chunk) throw new Error(`Missing manifest entry ${key}`)
      initialFiles.add(chunk.file)
      for (const css of chunk.css ?? []) initialFiles.add(css)
      for (const imported of chunk.imports ?? []) visit(imported)
    }
    visit("index.html")
    const optionalModules = [
      "src/components/BrowserActivityCard.tsx",
      "src/components/ModelPicker.tsx",
      "src/components/BotComputer.tsx",
      "src/components/Modals.tsx",
      "src/components/InterruptedTasks.tsx",
      "src/components/ProviderLoginFlow.tsx",
      "src/components/GoalPanel.tsx",
      "src/components/ApiModelsSettings.tsx",
      "src/components/NotificationDeliverySettings.tsx",
      "src/features/cloud/CloudPreferences.tsx",
      "src/features/server/ServerModeSettings.tsx",
      "src/components/BotMcpSettings.tsx",
      "src/components/BotNetworkSettings.tsx",
      "src/components/BotStandingGrants.tsx",
      "src/components/NotificationPreferencesSettings.tsx",
      "src/features/commandPalette/CommandPalette.tsx",
      "src/components/CronScreen.tsx",
      "src/features/work/WorkScreen.tsx",
      "src/components/WorkspaceScreens.tsx",
      "src/components/GroupModal.tsx",
      "src/components/GroupPanel.tsx",
      "src/components/Groups.tsx",
      "src/components/DeleteGroupDialog.tsx",
      "src/components/RoutineEditor.tsx",
    ].map((key) => manifest[key])
    expect(optionalModules.every((chunk) => chunk?.isDynamicEntry && !initialFiles.has(chunk.file))).toBe(true)
    const settings = Object.values(manifest).find((chunk) => chunk.name === "SettingsModal")
    expect(settings && !initialFiles.has(settings.file)).toBe(true)
    // Rollup may merge the renderer and its vendor modules into a named shared chunk.
    const adapter = Object.values(manifest).find((chunk) => chunk.name === "mermaidRenderer")
    expect(adapter?.isDynamicEntry).toBe(true)
    adapterFile = adapter?.file ?? ""
    expect(initialFiles.has(adapterFile)).toBe(false)
    for (const file of initialFiles) initialGzipBytes += gzipSync(await readFile(resolve(output, file))).length
    const nativeConfig = JSON.parse(await readFile(resolve(uiRoot, "../src-tauri/tauri.conf.json"), "utf8"))
    csp = nativeConfig.app.security.csp as string
    expect(csp).not.toContain("unsafe-eval")
    await mkdir(resolve(uiRoot, "../docs/qa/chat-transcript"), { recursive: true })
    await writeFile(
      resolve(uiRoot, "../docs/qa/chat-transcript/mermaid-bundle.json"),
      `${JSON.stringify({ initialGzipBytes, limitBytes: 400_000, lazyMermaid: true, csp }, null, 2)}\n`,
    )

    const mime: Record<string, string> = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
    }
    server = createServer((request, response) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname
      const path = resolve(output, `.${decodeURIComponent(pathname === "/" ? "/index.html" : pathname)}`)
      if (!path.startsWith(`${output}${sep}`)) {
        response.writeHead(404).end()
        return
      }
      void readFile(path).then(
        (body) => {
          response.writeHead(200, {
            "content-type": mime[extname(path)] ?? "application/octet-stream",
            "content-security-policy": csp,
          })
          response.end(body)
        },
        () => response.writeHead(404).end(),
      )
    })
    await new Promise<void>((accept) => server?.listen(0, "127.0.0.1", accept))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing production fixture endpoint")
    endpoint = `http://127.0.0.1:${address.port}`
  })

  test.afterAll(async () => {
    await new Promise<void>((accept, reject) => {
      if (!server) return accept()
      server.close((error) => (error ? reject(error) : accept()))
    })
  })

  test("keeps initial JS and CSS below 400 KB gzip and loads Mermaid only for a fence", async ({ page }) => {
    expect(initialGzipBytes).toBeLessThanOrEqual(400_000)
    const requests: string[] = []
    page.on("request", (request) => requests.push(request.url()))
    await page.goto(`${endpoint}/test/e2e/mermaid-harness.html?view=plain`)
    await expect(page.getByText("Resposta pronta, sem diagramas.")).toBeVisible()
    expect(requests.some((url) => url.endsWith(adapterFile))).toBe(false)
    await page.goto(`${endpoint}/test/e2e/mermaid-harness.html?theme=light`)
    await expect(page.locator(".mermaid-diagram svg")).toHaveCount(2)
    expect(requests.some((url) => url.endsWith(adapterFile))).toBe(true)
  })

  test("renders under the actual desktop CSP, changes themes, copies and falls back", async ({ page }) => {
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.addInitScript(() => {
      const state = window as Window & { diagramCspViolations: string[] }
      state.diagramCspViolations = []
      document.addEventListener("securitypolicyviolation", (event) => {
        state.diagramCspViolations.push(`${event.violatedDirective}: ${event.blockedURI}`)
      })
    })
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
    await page.goto(`${endpoint}/test/e2e/mermaid-harness.html?theme=light`)
    await expect(page.locator(".mermaid-diagram svg")).toHaveCount(2)
    await expect(page.locator(".mermaid-diagram foreignObject")).toHaveCount(0)
    const node = page.locator(".mermaid-diagram svg .node rect").first()
    const lightFill = await node.evaluate((element) => getComputedStyle(element).fill)
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark"
    })
    await expect.poll(() => node.evaluate((element) => getComputedStyle(element).fill)).not.toBe(lightFill)
    await page.getByRole("button", { name: "Ver código", exact: true }).first().click()
    await expect(page.locator(".mermaid-block pre code").first()).toHaveText(/flowchart LR/)
    await page.getByRole("button", { name: "Copiar código", exact: true }).first().click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("flowchart LR")
    await page.getByRole("button", { name: "Ver diagrama", exact: true }).first().click()
    await expect(page.locator(".mermaid-diagram svg")).toHaveCount(2)
    await page.setViewportSize({ width: 390, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0)
    const diagram = page.getByRole("img", { name: "Diagrama Mermaid" }).first()
    expect(await diagram.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
    await diagram.focus()
    await page.keyboard.press("ArrowRight")
    await expect.poll(() => diagram.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
    expect(errors).toEqual([])
    expect(
      await page.evaluate(() => (window as Window & { diagramCspViolations: string[] }).diagramCspViolations),
    ).toEqual([])
    await page.goto(`${endpoint}/test/e2e/mermaid-harness.html?view=invalid`)
    await expect(page.getByText("Não foi possível renderizar o diagrama. O código está abaixo.")).toBeVisible()
    await expect(page.locator(".mermaid-block pre code")).toHaveText("isto não é um diagrama válido")
  })

  test("renders flowchart and sequence SVG in the desktop WebKit engine without eval", async () => {
    test.skip(!existsSync(webkit.executablePath()), "WebKit runtime is not installed on this test host")
    // Clear this file's inherited channel so the desktop engine uses its own executable.
    const browser = await webkit.launch({ channel: "", headless: true })
    try {
      const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } })
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      await page.goto(`${endpoint}/test/e2e/mermaid-harness.html?theme=dark`)
      await expect(page.locator(".mermaid-diagram svg")).toHaveCount(2)
      await expect(page.getByRole("img", { name: "Diagrama Mermaid" })).toHaveCount(2)
      expect(errors).toEqual([])
      await page.screenshot({
        path: resolve(uiRoot, "../docs/qa/chat-transcript/mermaid-after-webkit.png"),
        fullPage: true,
      })
    } finally {
      await browser.close()
    }
  })

  test("ignores diagram security overrides and rejects resource-bearing styles before layout", async ({ page }) => {
    const requests: string[] = []
    page.on("request", (request) => requests.push(request.url()))
    await page.goto(`${endpoint}/test/e2e/mermaid-harness.html?view=restricted`)
    await expect(page.locator(".mermaid-diagram svg")).toHaveCount(1)
    await expect(page.locator(".mermaid-diagram foreignObject, .mermaid-diagram a")).toHaveCount(0)
    await expect(page.getByText("Não foi possível renderizar o diagrama. O código está abaixo.")).toBeVisible()
    await expect(page.locator(".mermaid-block pre code")).toContainText("classDef external")
    expect(await page.locator("body").evaluate((element) => getComputedStyle(element).opacity)).toBe("1")
    expect(requests.every((url) => url.startsWith(endpoint))).toBe(true)
  })
})
