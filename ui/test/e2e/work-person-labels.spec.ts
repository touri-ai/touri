import { expect, type Page, test } from "@playwright/test"

test.setTimeout(60_000)

const phase = process.env.WORK_PERSON_PHASE ?? "after"

for (const width of [1440, 390]) {
  test(`browser identity and mode responsiveness at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 })
    await page.goto(
      "/test/e2e/channel-browser-workspace-harness.html?viewer=person-requester&controller=owner&legacy=1",
    )
    await expect(page.getByRole("textbox", { name: "Mensagem para Léo" })).toBeVisible()
    if (width === 390) await page.locator(".mobile-menu-button").click()
    await page.getByRole("tab", { name: /^Work,/ }).click()
    await page.getByRole("button", { name: /^Viagens/ }).click()
    const chip = page.locator(".channel-chip")
    await expect(chip).toBeVisible()
    await expect(page.locator(".composer-browser-status")).toBeVisible()
    await expect(page.getByRole("article", { name: "Navegador do Léo" })).toBeVisible()
    await expect(page.locator(".channel-card-footer")).toBeVisible()
    const screenshot = process.env.WORK_PERSON_EVIDENCE
    if (screenshot) await page.screenshot({ path: `${screenshot}/${phase}-person-${width}.png` })
    if (phase !== "before") {
      await expect(chip).toHaveText("Léo no navegador·pedido de você·carla está no controle")
      await expect(page.locator(".composer-browser-status")).toContainText("carla está no controle")
      await expect(page.locator(".channel-card-footer")).toContainText("chama você")
      await expect(page.locator(".chat-panel")).not.toContainText("Owner")
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }

    const timings = await measureModeTimings(page, width)

    console.log(JSON.stringify({ phase, width, timings }))
    await info.attach("interaction-metrics", {
      body: JSON.stringify({ phase, width, timings }),
      contentType: "application/json",
    })
  })
}

async function measureModeTimings(page: Page, width: number) {
  await page.evaluate(() => {
    // Local, bounded samples bridge browser observers to the test without changing app state.
    const samples: number[] = []
    const longTasks: number[] = []
    const shifts: number[] = []
    const output = document.createElement("output")
    output.id = "mode-metrics"
    output.hidden = true
    output.dataset.count = "0"
    document.body.append(output)
    const observer = new PerformanceObserver((list) => {
      list.getEntries().forEach((entry) => {
        if (entry.entryType === "longtask") longTasks.push(entry.duration)
        if (entry.entryType !== "layout-shift" || !("value" in entry) || typeof entry.value !== "number") return
        if ("hadRecentInput" in entry && entry.hadRecentInput) return

        shifts.push(entry.value)
      })
    })
    observer.observe({ entryTypes: ["longtask", "layout-shift"] })
    const recordClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return
      if (!event.target.closest("[role=tab]")) return
      const start = performance.now()
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          samples.push(performance.now() - start)
          output.dataset.count = String(samples.length)
        }),
      )
    }
    document.addEventListener("click", recordClick, true)
    document.addEventListener(
      "fixture:finish-metrics",
      () => {
        observer.disconnect()
        document.removeEventListener("click", recordClick, true)
        const sorted = samples.toSorted((first, second) => first - second)
        output.textContent = JSON.stringify({
          p95Ms: sorted[18],
          longTasksOver50Ms: longTasks.length,
          maxTaskMs: Math.max(0, ...longTasks),
          cls: shifts.reduce((total, value) => total + value, 0),
          samples: samples.length,
        })
      },
      { once: true },
    )
  })
  for (const index of Array.from({ length: 20 }, (_, index) => index)) {
    const mode = index % 2 === 0 ? "Bots" : "Work"
    const tab = page.getByRole("tab", { name: new RegExp(`^${mode},`) })
    if (width === 390 && !(await tab.isVisible())) await page.locator(".mobile-menu-button").click()
    await tab.click()
    await expect(page.locator("#mode-metrics")).toHaveAttribute("data-count", String(index + 1))
  }

  return page.evaluate(() => {
    document.dispatchEvent(new Event("fixture:finish-metrics"))
    const output = document.getElementById("mode-metrics")
    const metrics: unknown = JSON.parse(output?.textContent ?? "null")
    output?.remove()

    return metrics
  })
}
