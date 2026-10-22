import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"
import { showBotConversations } from "./home-navigation"

const evidence = resolve(import.meta.dirname, "../../test-results/work-mode")
test.setTimeout(90_000)

test("switches and remembers Work mode, with channels and routine history", async ({ page }) => {
  // This matrix includes eight navigations, screenshots and accessibility audits.
  test.setTimeout(300_000)
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
  const conversations = await showBotConversations(page)
  const routineRow = conversations.getByRole("button", { name: /^Rotinas/ })
  await expect(routineRow).toContainText("Rotinas")
  await expect(routineRow).toContainText("30 hoje")
  await expect(conversations.locator(".thread-row")).toHaveCount(2)
  await routineRow.click()
  const routineHistory = page.locator(".routine-run-history")
  await expect(routineHistory).toHaveAttribute("data-open", "true")
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
        const contrast = await new AxeBuilder({ page })
          .include(".sidebar-mode-tabs")
          .withRules(["color-contrast"])
          .analyze()
        expect(contrast.violations).toEqual([])
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
  await expect(page.getByRole("region", { name: "Canais" })).toBeVisible()
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
    await expect(page.locator(".group-header .chat-header-crumb")).toHaveCount(0)
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
  await expect(page.getByRole("region", { name: "Canais" })).toBeVisible()

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
    const frameTimes: number[] = []
    const handlerTimes: number[] = []
    let maxFrameMs = 0

    for (let iteration = 0; iteration < 20; iteration += 1) {
      const started = performance.now()
      botsTab.click()
      handlerTimes.push(performance.now() - started)
      frameTimes.push((await frame()) - started)
      maxFrameMs = Math.max(maxFrameMs, frameTimes.at(-1) ?? 0)
      const workStarted = performance.now()
      workTab.click()
      handlerTimes.push(performance.now() - workStarted)
      frameTimes.push((await frame()) - workStarted)
      maxFrameMs = Math.max(maxFrameMs, frameTimes.at(-1) ?? 0)
    }

    return {
      stayedMounted: channelRow === document.querySelector(".group-select"),
      maxFrameMs,
      frameP95Ms: frameTimes.toSorted((left, right) => left - right)[Math.ceil(frameTimes.length * 0.95) - 1],
      handlerP95Ms: handlerTimes.toSorted((left, right) => left - right)[Math.ceil(handlerTimes.length * 0.95) - 1],
    }
  })

  console.log("Work mode switching: 40 switches, 101 channels", JSON.stringify(switchMetrics))
  const panelHeights = await page
    .locator(".sidebar-mode-panel")
    .evaluateAll((panels) => panels.map((panel) => panel.getBoundingClientRect().height))
  expect(panelHeights.every((height) => height > 0)).toBe(true)
  expect(Math.abs((panelHeights[0] ?? 0) - (panelHeights[1] ?? 0))).toBeLessThan(1)
  expect(switchMetrics.stayedMounted).toBe(true)
  expect(switchMetrics.maxFrameMs).toBeLessThan(250)
  await expect(page.getByRole("tab", { name: /^Work,/ })).toHaveAttribute("aria-selected", "true")
})

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "compact", width: 1024, height: 700 },
  { name: "phone", width: 390, height: 844 },
]) {
  for (const mode of ["live", "held", "finished"]) {
    test(`the actual Work transcript shows ${mode} browser activity at ${viewport.name}`, async ({ page }) => {
      mkdirSync(evidence, { recursive: true })
      await page.setViewportSize(viewport)
      await page.addInitScript(() => {
        localStorage.setItem("touri.appearance.v1", "dark")
        localStorage.setItem("touri.sidebar.mode", "work")
      })
      await page.goto(`/test/e2e/work-mode-harness.html?browser=${mode}`)
      await expect(page.getByRole("textbox", { name: "Mensagem para Léo" })).toBeVisible()
      if (viewport.width <= 600) await page.locator(".mobile-menu-button").click()
      await page.getByRole("button", { name: /^Viagens/ }).click()
      const card = page.locator(".message-assistant .browser-activity-card")
      await expect(card).toHaveCount(1)
      await expect(card).toBeVisible()
      await expect(page.locator(".channel-members-button")).toHaveAccessibleName("Membros do canal: 2 pessoas · 1 bot")
      await expect(page.locator(".group-header-actions")).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
      if (mode !== "finished") {
        await expect(page.locator(".browser-narration")).toContainText("Abri a busca.")
        await expect(page.locator(".browser-activity-checklist")).toHaveCount(0)
      }
      const header = page.locator(".group-header")
      const title = header.locator(".group-heading-name strong")
      await expect(title).toHaveText("Viagens")
      expect(await title.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
      if (mode === "live") {
        const columns = await card
          .locator(".browser-activity-content")
          .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)
        expect(columns).toBe(viewport.width > 1100 ? 2 : 1)
        await expect(card.getByRole("img", { name: "Página atual do navegador" })).toBeVisible()
        await expect(card.getByRole("progressbar")).toBeVisible()
        await expect(card.getByRole("button", { name: "Assumir", exact: true })).toBeEnabled()
        await expect(page.locator(".composer-browser-status")).toHaveCount(1)
        await expect(card.locator(".browser-activity-subtitle")).toContainText("estadias.example.test")
        await expect(card.getByText(/estadias\.example\.test/)).toHaveCount(1)
      }
      if (mode === "held") {
        await expect(card.getByRole("progressbar")).toHaveCount(0)
        await expect(card.locator('[data-running="true"]')).toHaveCount(0)
        await expect(card.getByText("Prévia oculta para o canal enquanto Ana digita")).toBeVisible()
        await expect(card.locator(".browser-activity-preview img, .browser-activity-preview canvas")).toHaveCount(0)
        await expect(page.locator(".composer-browser-status")).toContainText("Ana está no controle")
        await expect(card.getByText("Este navegador está sob seu controle.")).toHaveCount(0)
        await expect(card.getByText("Uma pessoa está controlando esta aba; o bot está pausado.")).toHaveCount(1)
      }
      if (mode === "finished") {
        await expect(card.getByRole("button", { name: /Usou o navegador · 4 ações/ })).toBeVisible()
        await expect(card.getByText("Ver o que ele fez")).toBeVisible()
        await expect(card.locator(".browser-activity-thumbnail img")).toBeVisible()
        await expect(page.locator(".message-assistant ol li")).toHaveCount(2)
      }
      await card
        .locator(mode === "finished" ? ".browser-activity-summary" : ".browser-activity-header")
        .scrollIntoViewIfNeeded()
      await page.screenshot({
        path: resolve(evidence, `work-browser-${mode}-${viewport.name}.png`),
        animations: "disabled",
        fullPage: true,
      })
    })
  }
}
