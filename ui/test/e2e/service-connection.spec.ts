import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { test as base, expect, type Response } from "@playwright/test"
import { createServerModeFixture } from "./server-mode-fixture"

type Server = Awaited<ReturnType<typeof createServerModeFixture>>
const test = base.extend<{ server: Server }>({
  // biome-ignore lint/correctness/noEmptyPattern: The fixture runner discovers dependencies from this pattern.
  server: async ({}, use) => use(await createServerModeFixture({ initialMode: "server" })),
})

test.afterEach(async ({ server }) => server.dispose())
test.setTimeout(180_000)

test("server mode recovers a failed history read without another server event", async ({ page, server }, info) => {
  const settings = (await server.api("/settings")) as { settings: { defaultProvider: string } }
  await server.api("/bots", "POST", { name: "Assistente de teste", provider: settings.settings.defaultProvider })
  await server.install(page)
  await page.setViewportSize({ width: 1100, height: 800 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  const initialHistory = page.waitForResponse(isHistoryLoaded)
  await page.goto(server.relayUrl)
  await initialHistory
  await expect(page.getByRole("textbox", { name: "Mensagem para Assistente de teste" })).toBeVisible()
  await server.api("/bots", "POST", { name: "Outro assistente", provider: settings.settings.defaultProvider })
  await page
    .getByRole("tabpanel", { name: /^Bots/ })
    .getByRole("button", { name: /^Outro assistente/ })
    .click()
  await expect(page.getByRole("textbox", { name: "Mensagem para Outro assistente" })).toBeVisible()
  const historyRoute = "**/api/v1/threads/*/messages**"
  await page.route(historyRoute, (route) =>
    route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ code: "TOURI-E1009" }) }),
  )

  await page.reload()
  await page
    .getByRole("tabpanel", { name: /^Bots/ })
    .getByRole("button", { name: /^Assistente de teste/ })
    .click()

  const notice = page
    .locator(".notice-bar")
    .filter({ hasText: "Não foi possível carregar a conversa. Tente novamente." })
  await expect(notice).toBeVisible()
  await expect(notice.getByRole("button", { name: "Tentar novamente", exact: true })).toBeVisible()
  await expect(notice).not.toContainText("serviço local")
  const evidence = resolve(import.meta.dirname, "../../../docs/qa/server-restart")
  await mkdir(evidence, { recursive: true })
  await info.attach("server-unavailable", {
    body: await notice.screenshot({ path: resolve(evidence, "server-unavailable.png") }),
    contentType: "image/png",
  })

  const recoveredHistory = page.waitForResponse(isHistoryLoaded)
  await page.unroute(historyRoute)
  await recoveredHistory

  await expect(page.getByRole("textbox", { name: "Mensagem para Assistente de teste" })).toBeVisible({
    timeout: 15_000,
  })
  await expect(notice).toBeHidden()
})

const isHistoryLoaded = (response: Response): boolean =>
  new URL(response.url()).pathname.endsWith("/messages") && response.status() === 200
