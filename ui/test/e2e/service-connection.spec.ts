import { test as base, expect } from "@playwright/test"
import { createServerModeFixture } from "./server-mode-fixture"

type Server = Awaited<ReturnType<typeof createServerModeFixture>>
const test = base.extend<{ server: Server }>({
  // biome-ignore lint/correctness/noEmptyPattern: The fixture runner discovers dependencies from this pattern.
  server: async ({}, use) => use(await createServerModeFixture({ initialMode: "server" })),
})

test.afterEach(async ({ server }) => server.dispose())
test.setTimeout(180_000)

test("server mode recovers a failed workspace read without another server event", async ({ page, server }, info) => {
  const settings = (await server.api("/settings")) as { settings: { defaultProvider: string } }
  await server.api("/bots", "POST", { name: "Assistente de teste", provider: settings.settings.defaultProvider })
  await server.install(page)
  await page.route("**/api/v1/bots", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "TOURI-E1009" }) }),
  )
  await page.setViewportSize({ width: 1100, height: 800 })
  await page.emulateMedia({ reducedMotion: "reduce" })

  await page.goto(server.relayUrl)

  const notice = page.locator(".notice-bar").filter({ hasText: "O serviço do touri está indisponível" })
  await expect(notice).toBeVisible()
  await expect(notice).not.toContainText("serviço local")
  await info.attach("server-unavailable", {
    body: await notice.screenshot({ path: info.outputPath("server-unavailable.png") }),
    contentType: "image/png",
  })

  await page.unroute("**/api/v1/bots")

  await expect(page.getByRole("textbox", { name: "Mensagem para Assistente de teste" })).toBeVisible({
    timeout: 15_000,
  })
  await expect(notice).toBeHidden()
  expect(server.snapshotReads).toBeGreaterThan(0)
})
