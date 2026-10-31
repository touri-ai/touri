import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"

test.use({ channel: "chromium", locale: "pt-BR" })
test.setTimeout(60_000)

test("a conversation read refused during a restart explains it inside the conversation", async ({ browser }) => {
  const evidence = process.env.TOURI_E2E_EVIDENCE_DIR
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: "dark",
    ...(evidence ? { recordVideo: { dir: evidence, size: { width: 1280, height: 800 } } } : {}),
  })
  const page = await context.newPage()
  await page.addInitScript(observeFluidity)
  await page.goto("/test/e2e/history-notice-harness.html")
  await expect(page.getByRole("textbox", { name: "Mensagem para Publicações" })).toBeVisible()

  await page.getByRole("button", { name: "Perfil de demonstração", exact: true }).click()
  const notice = page.locator(".chat-panel .conversation-notice")
  await expect(notice).toContainText("Não conseguimos carregar as mensagens novas.")
  await expect(notice).toContainText("O touri está reiniciando. Mostrando o que já estava salvo.")
  await expect(notice.getByText("TOURI-E1009", { exact: true })).toBeVisible()
  await expect(page.locator(".notice-bar")).toHaveCount(0)
  await notice.getByRole("button", { name: "Detalhes", exact: true }).click()
  await expect(notice).toContainText("RUNTIME_DRAINING")
  if (evidence) await saveScreenshot(page, evidence, "history-notice-after.png")
  await page.evaluate(() => {
    window.historyFailing = false
  })
  await notice.getByRole("button", { name: "Tentar de novo", exact: true }).click()

  const history = page.getByRole("region", { name: "Histórico da conversa" })
  await expect(history.getByText("valide esse perfil e veja os posts")).toBeVisible()
  await expect(notice).toHaveCount(0)
  const fluidity = await page.evaluate(() => window.fluidity)
  if (evidence) await writeFile(join(evidence, "history-notice-fluidity.json"), JSON.stringify(fluidity, null, 2))
  console.log(`history-notice fluidity ${JSON.stringify(fluidity)}`)
  expect(fluidity.layoutShift).toBeLessThan(0.05)
  await context.close()
})

declare global {
  interface Window {
    historyFailing?: boolean
    fluidity: { longTasks: number[]; interactions: number[]; layoutShift: number }
  }
}

const observeFluidity = (): void => {
  window.fluidity = { longTasks: [], interactions: [], layoutShift: 0 }
  new PerformanceObserver((list) => {
    window.fluidity.longTasks.push(...list.getEntries().map((entry) => Math.round(entry.duration)))
  }).observe({ type: "longtask", buffered: true })
  new PerformanceObserver((list) => {
    const clicks = list.getEntries().filter((entry) => entry.name === "click" || entry.name === "pointerup")
    window.fluidity.interactions.push(...clicks.map((entry) => Math.round(entry.duration)))
  }).observe({ type: "event", durationThreshold: 16, buffered: true } as PerformanceObserverInit)
  new PerformanceObserver((list) => {
    const shifts = list.getEntries() as Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>
    window.fluidity.layoutShift += shifts.filter((entry) => !entry.hadRecentInput).reduce((sum, e) => sum + e.value, 0)
  }).observe({ type: "layout-shift", buffered: true })
}

const saveScreenshot = async (page: Page, dir: string, name: string): Promise<void> => {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, name), await page.screenshot())
}
