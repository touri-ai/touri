import { expect, type Locator, type Page } from "@playwright/test"
import { test } from "./production-fixture"

test.use({
  reducedMotion: "reduce",
  // Recorder instrumentation is excluded from timing; screenshots below remain explicit.
  trace: "off",
})
test.setTimeout(60_000)

for (const width of [1440, 1000, 760, 390]) {
  test(`Work approval review exposes its card and keyboard controls at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 })
    await page.goto("/test/e2e/work-approval-harness.html")
    const review = getApprovalReview(page)
    const panel = page.getByRole("button", { name: "Painel do bot", exact: true })
    await expect(review).toBeVisible()
    if (width > 620) await expect(page.locator(".approval-notice")).toBeHidden()
    await panel.click()
    await expect(page.locator("#bot-panel")).toBeVisible()

    await review.click()
    const card = page.locator('[data-approval-id="folder-review"]')
    await expect(card).toBeVisible()
    const screenshot = process.env.WORK_APPROVAL_CAPTURE
      ? `${process.env.WORK_APPROVAL_CAPTURE}/review-${width}.png`
      : info.outputPath(`work-approval-${width}.png`)
    await page.screenshot({ path: screenshot, animations: "disabled" })
    await info.attach(`Work approval ${width}`, { path: screenshot, contentType: "image/png" })

    await expect(page.locator("#bot-panel")).toHaveCount(0)
    await expect(panel).toHaveAttribute("aria-expanded", "false")
    await expect(card).toBeFocused()
    const approve = card.getByRole("button", { name: "Aprovar", exact: true })
    const deny = card.getByRole("button", { name: "Negar", exact: true })
    for (const control of [approve, deny]) {
      await expect(control).toBeInViewport()
      expect(
        await control.evaluate((element) => {
          const rect = element.getBoundingClientRect()
          return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
        }),
      ).toBe(true)
    }
    await page.keyboard.press("Enter")
    await page.keyboard.press("Space")
    await expect(approve).toBeVisible()
    await page.keyboard.press("Tab")
    await expect(approve).toBeFocused()
    await page.keyboard.press("Tab")
    await expect(deny).toBeFocused()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}

for (const width of [1440, 760, 390]) {
  test(`Work channel review exposes its approval at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 })
    await page.goto("/test/e2e/work-approval-harness.html?channel")
    const review = getApprovalReview(page)
    await expect(review).toBeVisible()
    await page.getByRole("button", { name: "Painel do bot", exact: true }).click()

    await review.click()

    const card = page.locator('[data-approval-id="folder-review"]')
    await expect(card).toBeVisible()
    const screenshot = process.env.WORK_APPROVAL_CAPTURE
      ? `${process.env.WORK_APPROVAL_CAPTURE}/channel-review-${width}.png`
      : info.outputPath(`work-channel-approval-${width}.png`)
    await page.screenshot({ path: screenshot, animations: "disabled" })
    await info.attach(`Work channel approval ${width}`, { path: screenshot, contentType: "image/png" })

    await expect(page.locator("#bot-panel")).toHaveCount(0)
    await expect(card).toBeFocused()
    await expect(page.locator(".group-header")).toContainText("Planejamento")
  })
}

for (const source of ["desktop", "phone"] as const) {
  test(`Work approval resolved on ${source} syncs to both open sessions`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 844 })
    await page.goto("/test/e2e/work-approval-harness.html")
    await expect(getApprovalReview(page)).toBeVisible()
    const popup = page.waitForEvent("popup")
    await page.evaluate(() => window.open("/test/e2e/work-approval-harness.html?peer"))
    const phone = await popup
    await phone.setViewportSize({ width: 390, height: 844 })
    await expect(getApprovalReview(phone)).toBeVisible()
    // Both full app instances subscribe to the same synthetic host; no reload or polling.
    await getApprovalReview(page).click()
    await getApprovalReview(phone).click()
    const sender = source === "desktop" ? page : phone

    await sender.getByRole("button", { name: "Aprovar", exact: true }).click()

    for (const session of [page, phone]) {
      await expect(session.getByRole("button", { name: "Aprovar", exact: true })).toHaveCount(0)
      await expect(session.locator(".sidebar-needs-you")).toHaveCount(0)
      await expect(session.locator(".approval-notice")).toHaveText("Autorizado. Retomando a tarefa.")
      await expect(session.getByRole("button", { name: "Notificações, 1 precisa de atenção" })).toHaveCount(0)
    }
  })
}

test("Work approval review stays within the interaction budget", async ({ page }, info) => {
  await page.setViewportSize({ width: 760, height: 844 })
  await page.goto("/test/e2e/work-approval-harness.html")
  await expect(getApprovalReview(page)).toBeVisible()
  await page.getByRole("button", { name: "Painel do bot", exact: true }).click()
  await expect(page.locator(".bot-panel-tabs")).toBeVisible()
  await getApprovalReview(page).click()
  await expect(page.locator('[data-approval-id="folder-review"]')).toBeVisible()
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Performance.enable", { timeDomain: "threadTicks" })
  await page.evaluate(() => {
    const recordTasks = (entries: PerformanceEntry[]) =>
      entries.forEach((entry) => {
        performance.mark("approval-long-task", { startTime: entry.startTime, detail: entry.duration })
      })
    const recordShifts = (entries: PerformanceEntry[]) =>
      entries
        .filter((entry) => !Reflect.get(entry, "hadRecentInput"))
        .forEach((entry) => {
          performance.mark("approval-layout-shift", {
            startTime: entry.startTime,
            detail: Number(Reflect.get(entry, "value")),
          })
        })
    const tasks = new PerformanceObserver((list) => recordTasks(list.getEntries()))
    const layout = new PerformanceObserver((list) => recordShifts(list.getEntries()))
    const measureReview = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return
      if (!event.target.closest("button.sidebar-needs-you")) return

      const started = event.timeStamp
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          performance.measure("approval-review", { start: started, end: performance.now() })
          console.debug("approval-review-complete")
        }),
      )
    }
    const prepareReview = () =>
      requestAnimationFrame(() => requestAnimationFrame(() => performance.mark("approval-setup-ready")))
    tasks.observe({ type: "longtask" })
    layout.observe({ type: "layout-shift" })
    document.addEventListener("click", measureReview, true)
    window.addEventListener("touri:prepare-approval-probe", prepareReview)
    window.addEventListener(
      "touri:stop-approval-probe",
      () => {
        recordTasks(tasks.takeRecords())
        recordShifts(layout.takeRecords())
        tasks.disconnect()
        layout.disconnect()
        document.removeEventListener("click", measureReview, true)
        window.removeEventListener("touri:prepare-approval-probe", prepareReview)
      },
      { once: true },
    )
  })
  for (const index of Array.from({ length: 20 }, (_, index) => index)) {
    const panel = page.getByRole("button", { name: "Painel do bot", exact: true })
    if ((await panel.getAttribute("aria-expanded")) !== "true") await clickControl(page, panel)
    await expect(page.locator(".bot-panel-tabs")).toBeVisible()
    const review = getApprovalReview(page)
    await review.hover()
    await page.evaluate(() => window.dispatchEvent(new Event("touri:prepare-approval-probe")))
    await expect
      .poll(() => page.evaluate(() => performance.getEntriesByName("approval-setup-ready").length))
      .toBe(index + 1)

    // Resolve geometry before sampling; completion arrives without injecting browser polling work.
    const point = await getControlPoint(review)
    const completed = page.waitForEvent("console", {
      predicate: (message) => message.type() === "debug" && message.text() === "approval-review-complete",
    })
    const before = await cdp.send("Performance.getMetrics")
    await page.mouse.click(point.x, point.y)
    await completed
    const after = await cdp.send("Performance.getMetrics")
    const cpuMs = (getTaskSeconds(after.metrics) - getTaskSeconds(before.metrics)) * 1000
    await page.evaluate((duration) => performance.mark("approval-thread-cpu", { detail: duration }), cpuMs)
    await expect(page.locator('[data-approval-id="folder-review"]')).toBeFocused()
  }
  await cdp.send("Performance.disable")
  await cdp.detach()
  const measurements = await page.evaluate(() => {
    window.dispatchEvent(new Event("touri:stop-approval-probe"))
    const reviews = performance.getEntriesByName("approval-review")
    const sorted = reviews.map((entry) => entry.duration).toSorted((a, b) => a - b)
    const isReviewWork = (start: number, duration: number) =>
      reviews.some((review) => start < review.startTime + review.duration && start + duration > review.startTime)
    const tasks = performance.getEntriesByName("approval-long-task") as PerformanceMark[]
    const shifts = performance.getEntriesByName("approval-layout-shift") as PerformanceMark[]
    const cpu = (performance.getEntriesByName("approval-thread-cpu") as PerformanceMark[])
      .map((entry) => Number(entry.detail))
      .toSorted((left, right) => left - right)
    const getReview = (start: number, duration: number) =>
      reviews.find((review) => start < review.startTime + review.duration && start + duration > review.startTime)
    const startsDuringReview = (start: number) =>
      reviews.some((review) => start >= review.startTime && start < review.startTime + review.duration)

    return {
      samples: reviews.length,
      p95Ms: sorted[18],
      maxMs: sorted.at(-1),
      cpuP95Ms: cpu[18],
      cpuMaxMs: cpu.at(-1),
      longTasks: tasks.filter((entry) => startsDuringReview(entry.startTime)).map((entry) => Number(entry.detail)),
      overlappingLongTasks: tasks
        .filter((entry) => isReviewWork(entry.startTime, Number(entry.detail)))
        .map((entry) => ({
          durationMs: Number(entry.detail),
          startBeforeClickMs:
            (getReview(entry.startTime, Number(entry.detail))?.startTime ?? entry.startTime) - entry.startTime,
        })),
      setupLongTasks: tasks
        .filter((entry) => !isReviewWork(entry.startTime, Number(entry.detail)))
        .map((entry) => Number(entry.detail)),
      cls: shifts
        .filter((entry) => isReviewWork(entry.startTime, 0.001))
        .reduce((sum, entry) => sum + Number(entry.detail), 0),
    }
  })
  await info.attach("approval interaction measurements", {
    body: JSON.stringify(measurements),
    contentType: "application/json",
  })
  console.log(`Work approval interaction: ${JSON.stringify(measurements)}`)

  expect(measurements.samples).toBe(20)
  expect(measurements.p95Ms).toBeLessThan(100)
  expect(measurements.maxMs).toBeLessThan(500)
  expect(measurements.cpuP95Ms).toBeLessThan(16)
  expect(measurements.cpuMaxMs).toBeLessThan(50)
  expect(measurements.longTasks).toHaveLength(0)
  expect(measurements.overlappingLongTasks).toHaveLength(0)
  expect(measurements.cls).toBeLessThan(0.001)
})

const clickControl = async (page: Page, control: Locator) => {
  const point = await getControlPoint(control)
  await page.mouse.click(point.x, point.y)
}

const getControlPoint = async (control: Locator) => {
  const bounds = await control.boundingBox()
  if (!bounds) throw new Error("Missing control geometry")

  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
}

const getTaskSeconds = (metrics: Array<{ name: string; value: number }>): number => {
  const task = metrics.find((metric) => metric.name === "TaskDuration")
  if (!task) throw new Error("Missing renderer CPU metric")

  return task.value
}

const getApprovalReview = (page: Page) =>
  page.locator(".sidebar-needs-you:visible, .approval-notice:visible .notice-review")
