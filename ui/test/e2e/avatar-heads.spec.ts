import { expect, test } from "@playwright/test"
import type { createMockApi } from "../../src/api/mock"
import { showBotAdvanced } from "./home-navigation"

type AvatarFixtureWindow = Window & { groupsQa: { api: ReturnType<typeof createMockApi> } }

test.use({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" })

test("head gallery shows seven actual silhouettes and retains them when the mood changes", async ({ page }) => {
  await page.goto("/test/e2e/fixtures/avatars.html?still&theme=light")
  const cards = page.locator("#shape-gallery figure")
  await expect(cards).toHaveCount(7)
  const original = await cards.evaluateAll((nodes) =>
    nodes.map((node) => ({
      label: node.querySelector("figcaption")?.textContent,
      heads: Array.from(node.querySelectorAll("[data-avatar-body]"), (head) => head.getAttribute("d")),
      eyes: node.querySelector(".tb-avatar-eyes path")?.getAttribute("transform"),
    })),
  )

  await page.getByLabel("Mood", { exact: true }).selectOption("working")
  await page.getByLabel("Theme", { exact: true }).selectOption("dark")

  expect(new Set(original.map((card) => card.heads[0])).size).toBe(7)
  expect(new Set(original.map((card) => card.eyes)).size).toBe(7)
  const hasConsistentSizes = original.every(
    (card) => card.heads.length === 3 && card.heads.every((head) => head === card.heads[0]),
  )
  expect(hasConsistentSizes).toBe(true)
  await expect(page.locator(".avatar-evidence")).toHaveAttribute("data-theme", "dark")
  await expect(page.locator("#shape-gallery .tb-avatar-aura")).toHaveCount(21)
  const working = await cards.evaluateAll((nodes) =>
    nodes.map((node) => ({
      label: node.querySelector("figcaption")?.textContent,
      heads: Array.from(node.querySelectorAll("[data-avatar-body]"), (head) => head.getAttribute("d")),
      eyes: node.querySelector(".tb-avatar-eyes path")?.getAttribute("transform"),
    })),
  )
  expect(working).toEqual(original)
})

test("a legacy cloud head survives preview changes, saving settings and reopening", async ({ page }) => {
  await page.goto("/test/e2e/groups-harness.html")
  await expect(page.getByRole("textbox", { name: "Mensagem para mark", exact: true })).toBeVisible()
  await page.evaluate(async () => {
    const fixtureWindow = window as AvatarFixtureWindow
    await fixtureWindow.groupsQa.api.request(
      "PATCH /bots/:id",
      { avatarShape: "nuage", avatarSeed: "saved-head-fixture", color: "#e8483f" },
      { id: "bot-mark" },
    )
  })
  await showBotAdvanced(page)
  const dialog = page.getByRole("dialog", { name: "Configurações de mark", exact: true })
  const preview = dialog.locator(".avatar-picker-stage [data-avatar-body]")
  const head = await preview.getAttribute("d")
  if (!head) throw new Error("Missing cloud head")
  expect(head.startsWith("M50 32")).toBe(true)

  await dialog.getByRole("radio", { name: "Trabalhando", exact: true }).check()
  await dialog.getByRole("radio", { name: "Chifres Curtos", exact: true }).check()
  await dialog.getByRole("radio", { name: "Acessório Óculos", exact: true }).check()
  await dialog.getByRole("radio", { name: "Cor Azul", exact: true }).check()

  await expect(preview).toHaveAttribute("d", head)
  await expect(preview).toHaveAttribute("fill", "#3b93f0")
  await expect(dialog.locator(".avatar-picker-stage .tb-avatar")).toHaveAttribute("data-avatar-phase", "working")
  const thumbnails = await dialog
    .locator(".avatar-options [data-avatar-body]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("d")))
  expect(thumbnails).toEqual(Array.from({ length: 11 }, () => head))

  await dialog.getByRole("button", { name: "Salvar configurações", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('.bot-row-main [data-bot-id="bot-mark"] [data-avatar-body]')).toHaveAttribute("d", head)
  const saved = await page.evaluate(() => {
    const fixtureWindow = window as AvatarFixtureWindow
    const bot = fixtureWindow.groupsQa.api.getState().bots.find((candidate) => candidate.id === "bot-mark")

    return { shape: bot?.avatarShape, seed: bot?.avatarSeed, color: bot?.color }
  })
  expect(saved).toEqual({ shape: "nuage:short-glasses", seed: "saved-head-fixture", color: "#3b93f0" })

  await showBotAdvanced(page)

  await expect(preview).toHaveAttribute("d", head)
  await expect(dialog.getByRole("radio", { name: "Chifres Curtos", exact: true })).toBeChecked()
  await expect(dialog.getByRole("radio", { name: "Acessório Óculos", exact: true })).toBeChecked()
  await dialog.getByRole("button", { name: "Restaurar automático", exact: true }).click()
  await expect(preview).toHaveAttribute("d", head)
  await expect(dialog.getByRole("radio", { name: "Cor Automática", exact: true })).toBeChecked()
})
