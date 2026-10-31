import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { extname, join, resolve, sep } from "node:path"
import { promisify } from "node:util"
import { expect, test } from "@playwright/test"
import { build } from "vite"
import { installGuideMocks } from "./onboarding-guide-mocks"

const servers = new Set<ReturnType<typeof createServer>>()
test.afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  }
  servers.clear()
})
test.setTimeout(180_000)
test("onboarding guide before: unchanged main welcome with synthetic data", async ({ page }, info) => {
  const root = resolve(import.meta.dirname, "../../..")
  const paths = ["ui/src/features/onboarding/Onboarding.tsx", "ui/src/features/onboarding/onboarding.css"]
  const sources = await Promise.all(
    paths.map(async (path) => ({
      path: join(root, path),
      source: (await promisify(execFile)("git", ["show", `origin/main:${path}`], { cwd: root })).stdout,
    })),
  )
  const directory = info.outputPath("before-ui")
  await build({
    root: join(root, "ui"),
    configFile: join(root, "ui/vite.config.ts"),
    logLevel: "error",
    build: { outDir: directory, rollupOptions: { input: join(root, "ui/test/e2e/onboarding-legacy-harness.html") } },
    plugins: [
      {
        name: "main-onboarding-evidence",
        enforce: "pre",
        transform: (_source, id) => sources.find((source) => source.path === id)?.source,
      },
    ],
  })
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname
    const file = resolve(directory, `.${path}`)
    if (!file.startsWith(`${directory}${sep}`)) {
      response.writeHead(404).end()
      return
    }
    const types: Record<string, string> = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".woff2": "font/woff2",
      ".png": "image/png",
    }
    try {
      response.writeHead(200, { "Content-Type": types[extname(file)] ?? "text/plain" })
      response.end(await readFile(file))
    } catch {
      response.writeHead(404).end()
    }
  })
  servers.add(server)
  await listen(server)
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing local test address")
  await installGuideMocks(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`http://127.0.0.1:${address.port}/test/e2e/onboarding-legacy-harness.html`)
  await expect(page.getByRole("heading", { name: "Seus bots, perto de você" })).toBeVisible()
  await page.screenshot({
    path: join(process.env.TOURI_ONBOARDING_EVIDENCE_DIR ?? info.outputDir, "before-welcome.png"),
  })
  await page.getByRole("button", { name: /Usar meu servidor/ }).click()
  await page.screenshot({
    path: join(process.env.TOURI_ONBOARDING_EVIDENCE_DIR ?? info.outputDir, "before-location.png"),
  })
})
const listen = async (server: ReturnType<typeof createServer>): Promise<void> => {
  for (const port of Array.from({ length: 100 }, (_, index) => 18800 + index)) {
    const accepted = await new Promise<boolean>((done) => {
      server.once("error", () => done(false))
      server.listen(port, "127.0.0.1", () => done(true))
    })
    if (accepted) return
  }
  throw new Error("No available staging port")
}
