import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

const evidence = resolve(import.meta.dirname, "../../test-results/work-mode")
test.setTimeout(90_000)

test("switches and remembers Work mode, with channels and routine history", async ({ page }) => {
  mkdirSync(evidence, { recursive: true })
  await page.setViewportSize({ width: 1512, height: 982 })
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" })
  await page.addInitScript(() => {
    if (localStorage.getItem("touri.appearance.v1") === null) localStorage.setItem("touri.appearance.v1", "dark")
    if (localStorage.getItem("touri.sidebar.mode") === null) localStorage.setItem("touri.sidebar.mode", "work")
  })
  await page.goto("/test/e2e/work-mode-harness.html")
  await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()

  const workTab = page.getByRole("tab", { name: /^Work,/ })
  const botsTab = page.getByRole("tab", { name: /^Bots,/ })
  const channels = page.getByRole("region", { name: "Canais" })
  await expect(channels.getByRole("button", { name: /^Planejamento/ })).toBeVisible()

  await workTab.focus()
  await page.keyboard.press("ArrowLeft")
  await expect(botsTab).toBeFocused()
  await expect(botsTab).toHaveAttribute("aria-selected", "true")
  await expect(channels).toHaveCount(0)
  await page.keyboard.press("ArrowRight")
  await expect(workTab).toBeFocused()
  await expect(workTab).toHaveAttribute("aria-selected", "true")

  await botsTab.click()
  const botsPanel = page.locator("#sidebar-mode-panel-bots")
  const routineRow = botsPanel.getByRole("button", { name: /^Rotinas/ })
  await expect(routineRow).toContainText("Rotinas")
  await expect(routineRow).toContainText("30 hoje")
  await expect(botsPanel.locator('[data-bot-entry="bot-mark"] .thread-row')).toHaveCount(2)
  await routineRow.click()
  const routineHistory = page.locator(".routine-run-history")
  await expect(routineHistory).toHaveAttribute("open", "")
  await expect(routineHistory.getByRole("button", { name: "Abrir conversa" })).toHaveCount(30)

  await botsTab.click()
  await page.reload()
  await expect(page.getByRole("tab", { name: /^Bots,/ })).toHaveAttribute("aria-selected", "true")
  await expect(page.getByRole("region", { name: "Canais" })).toHaveCount(0)
  await page.getByRole("tab", { name: /^Work,/ }).click()

  for (const viewport of [
    { name: "desktop", width: 1512, height: 982 },
    { name: "phone", width: 390, height: 844 },
  ]) {
    for (const theme of ["light", "dark"] as const) {
      for (const mode of ["bots", "work"] as const) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height })
        await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme })
        await page.evaluate(
          ({ appearance, sidebarMode }) => {
            localStorage.setItem("touri.appearance.v1", appearance)
            localStorage.setItem("touri.sidebar.mode", sidebarMode)
          },
          { appearance: theme, sidebarMode: mode },
        )
        await page.reload()
        if (viewport.name === "phone") await page.locator(".mobile-menu-button").click()
        await expect(page.getByRole("region", { name: "Canais" })).toHaveCount(mode === "work" ? 1 : 0)
        if (mode === "bots") {
          const contrast = await new AxeBuilder({ page })
            .include(".sidebar-mode-tabs")
            .withRules(["color-contrast"])
            .analyze()
          expect(contrast.violations).toEqual([])
        }
        const botRow =
          mode === "work"
            ? page.locator('[data-work-bot-entry="bot-mark"] .bot-row-main')
            : page.locator('[data-bot-entry="bot-mark"] .bot-row-main')
        await botRow.click()
        await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
        await expect(page.locator(".chat-header-crumb")).toHaveText(mode === "work" ? "Mensagens diretas" : "Bots")
        if (viewport.name === "phone") await page.locator(".mobile-menu-button").click()
        const sidebar = page.locator(".bot-sidebar")
        await expect(sidebar).toBeVisible()
        await sidebar.screenshot({
          path: resolve(evidence, `${mode === "bots" ? "before" : "after"}-${viewport.name}-${theme}.png`),
          animations: "disabled",
        })
      }
    }
  }

  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => localStorage.setItem("touri.sidebar.mode", "work"))
  await page.reload()
  await page.locator(".mobile-menu-button").click()
  await expect(page.getByRole("tab", { name: /^Work,/ })).toHaveAttribute("aria-selected", "true")
  const touchTargetHeights = await page
    .locator(".sidebar-mode-tabs [role=tab], .group-select, .channel-create")
    .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height))
  expect(touchTargetHeights.length).toBeGreaterThanOrEqual(4)
  expect(touchTargetHeights.every((height) => height >= 44)).toBe(true)
})

test("captures an open channel on desktop and phone", async ({ page }) => {
  mkdirSync(evidence, { recursive: true })
  await page.addInitScript(() => {
    localStorage.setItem("touri.appearance.v1", "dark")
    localStorage.setItem("touri.sidebar.mode", "work")
  })

  for (const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "phone", width: 390, height: 844 },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" })
    await page.goto("/test/e2e/work-mode-harness.html")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    if (viewport.name === "phone") await page.locator(".mobile-menu-button").click()
    await page.getByRole("button", { name: /^Planejamento/ }).click()
    await expect(page.locator(".chat-header-crumb")).toHaveText("Canais / Planejamento")
    await page.screenshot({
      path: resolve(evidence, `channel-open-${viewport.name}.png`),
      animations: "disabled",
    })
  }
})

test("preserves each mode's independent scroll position when switching", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.addInitScript(() => localStorage.setItem("touri.sidebar.mode", "work"))
  await page.goto("/test/e2e/work-mode-harness.html")
  await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()

  const botsTab = page.getByRole("tab", { name: /^Bots,/ })
  const workTab = page.getByRole("tab", { name: /^Work,/ })
  const botsPanel = page.locator("#sidebar-mode-panel-bots")
  const workPanel = page.locator("#sidebar-mode-panel-work")
  const makeScrollable = async (panel: typeof botsPanel) => {
    await panel.evaluate((element) => {
      element.style.flex = "0 0 160px"
      element.style.height = "160px"
      element.style.paddingBottom = "200px"
      element.scrollTop = 100
    })
    await expect.poll(() => panel.evaluate((element) => element.scrollTop)).toBe(100)
  }

  await botsTab.click()
  await makeScrollable(botsPanel)
  await workTab.click()
  await makeScrollable(workPanel)
  await botsTab.click()
  await expect.poll(() => botsPanel.evaluate((element) => element.scrollTop)).toBe(100)
  await workTab.click()
  await expect.poll(() => workPanel.evaluate((element) => element.scrollTop)).toBe(100)
})

test("keeps the channel row mounted through rapid mode switches", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.addInitScript(() => localStorage.setItem("touri.sidebar.mode", "work"))
  await page.goto("/test/e2e/work-mode-harness.html?large")
  await expect(page.getByRole("region", { name: "Canais" })).toBeVisible()
  await expect(page.locator(".group-select")).toHaveCount(101)

  const workPanelNodes = await page
    .locator("#sidebar-mode-panel-work")
    .evaluate((panel) => panel.querySelectorAll("*").length)
  expect(workPanelNodes).toBeLessThan(4_000)

  const switchMetrics = await page.evaluate(async () => {
    const channelRow = document.querySelector(".group-select")
    const botsTab = document.querySelector<HTMLButtonElement>('[data-sidebar-mode="bots"]')
    const workTab = document.querySelector<HTMLButtonElement>('[data-sidebar-mode="work"]')
    if (!channelRow || !botsTab || !workTab) return { stayedMounted: false, maxFrameMs: Number.POSITIVE_INFINITY }

    const frame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve))
    let maxFrameMs = 0

    for (let iteration = 0; iteration < 20; iteration += 1) {
      const started = performance.now()
      botsTab.click()
      maxFrameMs = Math.max(maxFrameMs, (await frame()) - started)
      const workStarted = performance.now()
      workTab.click()
      maxFrameMs = Math.max(maxFrameMs, (await frame()) - workStarted)
    }

    return {
      stayedMounted: channelRow === document.querySelector(".group-select"),
      maxFrameMs,
    }
  })

  expect(switchMetrics.stayedMounted).toBe(true)
  expect(switchMetrics.maxFrameMs).toBeLessThan(250)
  await expect(page.getByRole("tab", { name: /^Work,/ })).toHaveAttribute("aria-selected", "true")
})
