import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test as base, expect } from "@playwright/test"
import seed from "../../../sidecar/test/fixtures/ui-seed.json" with { type: "json" }
import { createPeopleInviteServer } from "./people-invite-server"

type WorkServer = Awaited<ReturnType<typeof createPeopleInviteServer>>
const test = base.extend<{ workServer: WorkServer }>({
  workServer: [
    async ({ page }, use) => {
      const server = await createPeopleInviteServer(Number(process.env.TOURI_WORK_NAV_PORT ?? 18846))
      await server.install(page)
      await use(server)
      await server.dispose()
    },
    { timeout: 90_000 },
  ],
})

for (const width of [1440, 390]) {
  for (const theme of ["light", "dark"]) {
    test(`Work opens directly and contains People at ${width}px in ${theme}`, async ({
      page,
      workServer: current,
    }, info) => {
      test.setTimeout(90_000)
      const bot = seed.bots[0]
      if (!bot) throw new Error("Missing bot fixture")
      await current.api("/bots", "POST", { name: "Planejamento", provider: bot.provider })
      await page.addInitScript((appearance) => localStorage.setItem("touri.appearance.v1", appearance), theme)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ reducedMotion: "reduce" })
      await page.goto(current.serverUrl)
      await expect(page.getByRole("textbox", { name: "Mensagem para Planejamento" })).toBeVisible()
      if (width === 390) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
      await page.locator("button[aria-controls='sidebar-advanced-pages']").click()
      const menu = page.getByRole("navigation", { name: "Opções avançadas" })
      const directory = process.env.TOURI_E2E_EVIDENCE_DIR ?? info.outputDir
      await mkdir(directory, { recursive: true })
      const capture = async (name: string) => {
        const path = join(directory, `${name}-${width}-${theme}.png`)
        await page.screenshot({ path, animations: "disabled" })
        await info.attach(name, { path, contentType: "image/png" })
      }
      await capture("navigation")

      await menu.getByRole("button", { name: "Trabalho", exact: true }).click()
      await capture("work-first-click")

      await expect(page.getByRole("heading", { name: "Trabalho", exact: true })).toBeVisible()
      await expect(menu).toBeHidden()
      const padding = await page
        .locator(".work-screen p.screen-card")
        .evaluate((card) => Number.parseFloat(getComputedStyle(card).paddingLeft))
      expect(padding).toBeGreaterThanOrEqual(12)
      await capture("work-tasks")
      const sections = page.getByRole("navigation", { name: "Seções de Trabalho" })
      await sections.getByRole("button", { name: "Pessoas", exact: true }).click()
      await expect(page.getByRole("button", { name: "Convidar pessoa", exact: true })).toBeVisible()
      await expect(page.getByRole("dialog")).toHaveCount(0)
      await expect(page.getByRole("heading", { name: "Pessoas e dispositivos", exact: true })).toBeVisible()
      await expect(page.getByRole("textbox", { name: "Endereço público", exact: true })).toBeHidden()
      if (width === 390) {
        for (const button of await page.locator(".work-access-settings").getByRole("button").all()) {
          const target = await button.boundingBox()
          expect(target?.height).toBeGreaterThanOrEqual(44)
        }
      }
      await capture("work-people")
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.getByRole("button", { name: "Configurações de conexão", exact: true }).click()
      const address = page.getByRole("textbox", { name: "Endereço público", exact: true })
      await address.fill("https://team.example.test/draft")
      await sections.getByRole("button", { name: "Tarefas", exact: true }).click()
      await expect(page.getByRole("region", { name: "Trabalhando", exact: true })).toBeVisible()
      await sections.getByRole("button", { name: "Pessoas", exact: true }).click()
      await expect(address).toHaveValue("https://team.example.test/draft")
      await sections.getByRole("button", { name: "Tarefas", exact: true }).click()

      const measurements = await sections.evaluate(async (navigation) => {
        const samples: number[] = []
        const longTasks: number[] = []
        const shifts: number[] = []
        // Performance observers append only to these bounded, test-local samples.
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.entryType === "longtask") longTasks.push(entry.duration)
            if (entry.entryType === "layout-shift" && "value" in entry) shifts.push(Number(entry.value))
          }
        })
        observer.observe({ entryTypes: ["longtask", "layout-shift"] })
        const buttons = Array.from(navigation.querySelectorAll("button"))
        for (const index of Array.from({ length: 20 }, (_, index) => index)) {
          const started = performance.now()
          buttons[index % 2 === 0 ? 1 : 0]?.click()
          await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))
          samples.push(performance.now() - started)
        }
        observer.disconnect()
        const ordered = samples.toSorted((first, second) => first - second)

        return {
          samples,
          p95: ordered[Math.ceil(ordered.length * 0.95) - 1],
          longTasks,
          cls: shifts.reduce((sum, value) => sum + value, 0),
        }
      })
      await writeFile(
        join(directory, `work-interactions-${width}-${theme}.json`),
        JSON.stringify(measurements, null, 2),
      )
      await info.attach("work-interactions", { body: JSON.stringify(measurements), contentType: "application/json" })
      expect(measurements.p95).toBeLessThan(100)
      expect(measurements.longTasks).toHaveLength(0)
      expect(measurements.cls).toBeLessThan(0.01)
    })
  }
}
