import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"

const evidence = resolve(import.meta.dirname, "../../test-results/work-mode")

test("switches and remembers Work mode, with channels and routine history", async ({ page }) => {
  mkdirSync(evidence, { recursive: true })
  await page.setViewportSize({ width: 1512, height: 982 })
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" })
  await page.addInitScript(() => {
    localStorage.setItem("touri.appearance.v1", "dark")
    localStorage.setItem("touri.sidebar.mode", "work")
  })
  await page.goto("/test/e2e/work-mode-harness.html")
  await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()

  const workTab = page.getByRole("tab", { name: /^Work,/ })
  const botsTab = page.getByRole("tab", { name: /^Bots,/ })
  const channels = page.getByRole("region", { name: "Canais" })
  await expect(channels.getByRole("button", { name: "Planejamento", exact: true })).toBeVisible()
  await expect(page.getByText("Rotina Resumo diário · 30 hoje", { exact: true })).toBeVisible()
  await expect(page.locator('[data-bot-entry="bot-mark"] .thread-row')).toHaveCount(2)

  await workTab.focus()
  await page.keyboard.press("ArrowLeft")
  await expect(botsTab).toBeFocused()
  await expect(botsTab).toHaveAttribute("aria-selected", "true")
  await expect(channels).toHaveCount(0)
  await page.keyboard.press("ArrowRight")
  await expect(workTab).toBeFocused()
  await expect(workTab).toHaveAttribute("aria-selected", "true")

  await page.getByRole("button", { name: "Abrir histórico da rotina Resumo diário" }).click()
  const routineHistory = page.locator(".routine-run-history")
  await expect(routineHistory).toHaveAttribute("open", "")
  await expect(routineHistory.getByRole("button", { name: "Abrir conversa" })).toHaveCount(30)

  await botsTab.click()
  await page.reload()
  await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
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
        await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
        if (viewport.name === "phone") await page.locator(".mobile-menu-button").click()
        await expect(page.getByRole("region", { name: "Canais" })).toHaveCount(mode === "work" ? 1 : 0)
        await page.screenshot({
          path: resolve(evidence, `${mode === "bots" ? "before" : "after"}-${viewport.name}-${theme}.png`),
          fullPage: true,
          animations: "disabled",
        })
      }
    }
  }
})
