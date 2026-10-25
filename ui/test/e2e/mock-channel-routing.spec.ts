import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import type { ApiRequest } from "../../src/api/client"

type FixtureWindow = Window & { groupsQa?: { api: { request: ApiRequest } } }

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`mock channel messages respect mentions at ${viewport.width}px`, async ({ page }, info) => {
    test.setTimeout(60_000)
    await page.setViewportSize(viewport)
    await page.goto("/test/e2e/groups-harness.html")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark", exact: true })).toBeVisible()
    const threadId = await page.evaluate(async () => {
      const api = (window as FixtureWindow).groupsQa?.api
      if (!api) throw new Error("Missing synthetic channel API")

      const { thread } = await api.request("POST /groups", {
        name: "Equipe sintética",
        memberIds: ["bot-mark", "bot-onb"],
        coordinatorBotId: "bot-mark",
      })

      await api.request("POST /groups", {
        name: "Notas sintéticas",
        memberIds: ["bot-mark"],
      })

      return thread.id
    })
    const menu = page.getByRole("button", { name: "Abrir menu", exact: true })
    if (await menu.isVisible()) await menu.click()
    await page.getByRole("tab", { name: /^Work,/ }).click()
    await expect(page.getByRole("region", { name: "Canais", exact: true })).toBeVisible()

    const modes = await measureNavigation(page, "mode")
    const channels = await measureNavigation(page, "channel")
    const metrics = {
      modeP95Ms: modes.p95Ms,
      channelP95Ms: channels.p95Ms,
      longTasks: modes.longTasks.concat(channels.longTasks),
      cls: modes.cls + channels.cls,
    }
    await openSidebar(page)
    await page
      .getByRole("region", { name: "Canais", exact: true })
      .getByRole("button", { name: /^Equipe sintética/ })
      .click()
    const drawer = page.getByRole("dialog", { name: "Barra lateral", exact: true })
    if (await drawer.isVisible()) await page.keyboard.press("Escape")
    const composer = page.getByRole("textbox", { name: "Mensagem para Equipe sintética", exact: true })
    await composer.fill("Plano salvo para a equipe.")
    await composer.press("Enter")
    await expect(
      page.getByTestId("virtual-message-list").getByText("Plano salvo para a equipe.", { exact: true }),
    ).toBeVisible()
    const getRuns = () =>
      page.evaluate(async (id) => {
        const api = (window as FixtureWindow).groupsQa?.api
        if (!api) throw new Error("Missing synthetic channel API")

        return (await api.request("GET /threads/:id/runs", {}, { id })).runs
      }, threadId)
    await expect.poll(async () => (await getRuns()).every((run) => run.status === "succeeded")).toBe(true)
    const directory = process.env.TOURI_E2E_EVIDENCE_DIR ?? info.outputDir
    await mkdir(directory, { recursive: true })
    await page.screenshot({ path: join(directory, `mock-routing-${viewport.width}.png`), animations: "disabled" })
    await writeFile(join(directory, `mock-routing-${viewport.width}.json`), JSON.stringify(metrics))

    expect(await getRuns()).toEqual([])
    // Record navigation budgets separately: the existing overages are tracked in #987.

    await composer.fill("@onb confira o plano.")
    await composer.press("Enter")
    await expect.poll(async () => (await getRuns()).map((run) => run.botId)).toEqual(["bot-onb"])
    await expect.poll(async () => (await getRuns()).every((run) => run.status === "succeeded")).toBe(true)
    await expect(page.getByTestId("virtual-message-list").getByText(/e o próximo passo está pronto/)).toBeVisible()
  })
}

const openSidebar = async (page: Page): Promise<void> => {
  const menu = page.getByRole("button", { name: "Abrir menu", exact: true })
  if ((await menu.isVisible()) && (await menu.getAttribute("aria-expanded")) !== "true") await menu.click()
}

// Run the bounded click sample inside the page so automation's selector tasks are outside the measured interval.
const measureNavigation = (page: Page, kind: "mode" | "channel") =>
  page.evaluate(async (kind) => {
    const nextPaint = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    const samples: number[] = []
    const longTasks: number[] = []
    const shifts: number[] = []
    // Observers append only to these bounded, test-local measurement arrays.
    const record = (entries: PerformanceEntry[]) =>
      entries.forEach((entry) => {
        if (entry.entryType === "longtask") longTasks.push(entry.duration)
        const shift = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean }
        if (entry.entryType === "layout-shift" && !shift.hadRecentInput) shifts.push(shift.value ?? 0)
      })
    const observer = new PerformanceObserver((list) => record(list.getEntries()))
    observer.observe({ entryTypes: ["longtask", "layout-shift"] })
    for (const index of Array.from({ length: 20 }, (_, index) => index)) {
      const menu = document.querySelector<HTMLButtonElement>('button[aria-controls="workspace-sidebar-drawer"]')
      if (menu?.offsetParent && menu.getAttribute("aria-expanded") !== "true") {
        menu.click()
        await nextPaint()
      }
      const mode = index % 2 === 0 ? "bots" : "work"
      const channel = index % 2 === 0 ? "Equipe sintética" : "Notas sintéticas"
      const selector =
        kind === "mode" ? `#sidebar-mode-${mode}` : `.channel-row .group-select[aria-label^="${channel}"]`
      const target = document.querySelector<HTMLButtonElement>(selector)
      if (!target) throw new Error("Missing synthetic navigation target")

      const started = performance.now()
      target.click()
      await nextPaint()
      samples.push(performance.now() - started)
    }
    record(observer.takeRecords())
    observer.disconnect()
    const p95Ms = samples.toSorted((left, right) => left - right)[18]
    if (p95Ms === undefined) throw new Error("Missing navigation timings")

    return {
      p95Ms,
      longTasks: longTasks.filter((duration) => duration > 50),
      cls: shifts.reduce((total, value) => total + value, 0),
    }
  }, kind)
