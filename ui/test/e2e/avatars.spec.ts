import { mkdir } from "node:fs/promises"
import { expect, test } from "@playwright/test"
import { showBotPanel } from "./home-navigation"

const fixture = "/test/e2e/fixtures/mascot-parity.html"
type AvatarMutationWindow = Window & { avatarMutations: number }

test("all seeds and moods render at the reference sizes and freeze under reduced motion", async ({ page }, info) => {
  expect(info.project.use.headless).toBe(true)
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto(fixture)
  const avatars = page.locator("#gallery .tb-avatar")
  await expect(avatars).toHaveCount(126)
  const identities = await avatars.evaluateAll((nodes) =>
    nodes.map((node) => ({
      seed: node.getAttribute("data-bot-id"),
      shape: node.getAttribute("data-avatar-shape"),
      color: node.querySelector("[data-avatar-body]")?.getAttribute("fill"),
      size: (node as HTMLElement).style.width,
    })),
  )
  for (const seed of ["mark", "onb", "Panko", "seo", "qa-bot", "review"]) {
    const profiles = identities.filter((item) => item.seed === seed)
    expect(new Set(profiles.map((item) => item.shape)).size).toBe(1)
    expect(new Set(profiles.map((item) => item.color)).size).toBe(1)
    expect([...new Set(profiles.map((item) => item.size))]).toEqual(["24px", "32px", "40px"])
  }
  const working = page.locator('[data-seed="mark"][data-mood="working"] .tb-avatar').first()
  await expect(working).toHaveAttribute("data-avatar-animated", "false")
  await expect(working.locator(".tb-avatar-head")).toHaveCSS("animation-name", "none")
  await expect(working.locator(".tb-avatar-fx-steam-left")).toBeVisible()
})

test("runtime moods keep identity, animate with CSS, and produce headless evidence", async ({ page }, testInfo) => {
  test.setTimeout(60000)
  expect(testInfo.project.use.headless).toBe(true)
  const captureEvidence = process.env.TOURI_QA_SCREENSHOTS === "1"
  if (captureEvidence) await mkdir("/tmp/touri-evidence/frames", { recursive: true })
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.goto("/test/e2e/fixtures/avatars.html")
  const avatar = page.locator("#gallery .tb-avatar").first()
  const head = avatar.locator(".tb-avatar-head")
  const shape = await avatar.getAttribute("data-avatar-shape")
  const heads = {
    idle: "none",
    working: "tb-avatar-bob",
    waiting: "tb-avatar-bob",
    failed: "tb-avatar-shake",
    responded: "tb-avatar-hop",
    asleep: "tb-avatar-breathe",
    connecting: "tb-avatar-tilt",
  }
  let index = 0
  for (const [mood, animation] of Object.entries(heads)) {
    await page.getByLabel("Mood").selectOption(mood)
    await expect(avatar).toHaveAttribute("data-avatar-mood", mood)
    await expect(avatar).toHaveAttribute("data-avatar-shape", shape ?? "")
    await expect(head).toHaveCSS("animation-name", animation)
    if (captureEvidence)
      await page.locator("#gallery").screenshot({ path: `/tmp/touri-evidence/bull-${mood}.png`, animations: "allow" })
    for (let frame = 0; captureEvidence && frame < 6; frame++) {
      await page.locator("#gallery").screenshot({
        path: `/tmp/touri-evidence/frames/bull-${String(index++).padStart(3, "0")}.png`,
        animations: "allow",
      })
      await page.waitForTimeout(80)
    }
  }
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.getByLabel("Mood").selectOption("working")
  await expect(avatar).toHaveAttribute("data-avatar-animated", "false")
  await expect(head).toHaveCSS("animation-name", "none")
  const still = await avatar.locator(".tb-avatar-body").innerHTML()
  await page.getByLabel("Mood").selectOption("failed")
  await expect(avatar).toHaveAttribute("data-avatar-phase", "failed")
  expect(await avatar.locator(".tb-avatar-body").innerHTML()).not.toBe(still)
  if (captureEvidence)
    await page.locator("#gallery").screenshot({ path: "/tmp/touri-evidence/bull-reduced-motion.png" })
})

test("resting rows ignore global pointer movement and breathe on hover and focus", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.goto(fixture)
  await page.locator("#gallery").evaluate((node) => node.remove())
  const button = page.locator("#hover-probe")
  const avatar = button.locator(".tb-avatar")
  const head = avatar.locator(".tb-avatar-head")

  await page.mouse.move(20, 20)
  await expect(avatar).toHaveAttribute("data-avatar-animated", "false")
  await expect(head).toHaveCSS("animation-name", "none")
  await button.hover()
  await expect(avatar).toHaveAttribute("data-avatar-animated", "true")
  await expect(head).toHaveCSS("animation-name", "tb-avatar-breathe")
  await expect(avatar.locator(".tb-avatar-eyes")).toHaveCSS("animation-name", "tb-avatar-blink")
  await page.mouse.move(20, 20)
  await expect(avatar).toHaveAttribute("data-avatar-animated", "false")
  await button.focus()
  await expect(avatar).toHaveAttribute("data-avatar-animated", "true")
})

test("active avatars animate without touching the DOM", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.goto(fixture)
  const avatar = page.locator('[data-seed="mark"][data-mood="working"] .tb-avatar').first()
  await expect(avatar.locator(".tb-avatar-head")).toHaveCSS("animation-name", "tb-avatar-bob")
  await avatar.evaluate((element) => {
    const fixtureWindow = window as AvatarMutationWindow
    fixtureWindow.avatarMutations = 0
    new MutationObserver((records) => {
      fixtureWindow.avatarMutations += records.length
    }).observe(element, { attributes: true, childList: true, subtree: true })
  })

  await page.waitForTimeout(1000)

  expect(await page.evaluate(() => (window as AvatarMutationWindow).avatarMutations)).toBe(0)
})

test("group colour returns to its seeded automatic value and survives saving", async ({ page }, testInfo) => {
  test.setTimeout(60000)
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/test/e2e/groups-harness.html")
  await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
  await showBotPanel(page)
  await page.getByRole("button", { name: "Criar grupo", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Criar grupo", exact: true })
  await dialog.getByLabel("Nome do grupo").fill("Equipe QA")
  await dialog.getByRole("checkbox", { name: "mark", exact: true }).check()
  const preview = dialog.locator(".avatar-picker-stage [data-avatar-body]")
  const automatic = await preview.getAttribute("fill")
  const custom = automatic === "#3b93f0" ? "Cor Vermelho" : "Cor Azul"
  await dialog.getByRole("radio", { name: custom, exact: true }).check()
  await expect(preview).not.toHaveAttribute("fill", automatic ?? "")
  await dialog.screenshot({ path: testInfo.outputPath("group-custom-colour.png") })

  await dialog.getByRole("radio", { name: "Cor Automática", exact: true }).check()

  await expect(dialog.getByRole("radio", { name: "Cor Automática" })).toBeChecked()
  await expect(preview).toHaveAttribute("fill", automatic ?? "")
  await dialog.screenshot({ path: testInfo.outputPath("group-automatic-colour.png") })

  await dialog.getByRole("button", { name: "Criar grupo", exact: true }).click()

  await expect(page.getByRole("textbox", { name: "Mensagem para Equipe QA" })).toBeVisible()
  await expect(page.locator(".group-heading-name [data-avatar-body]")).toHaveAttribute("fill", automatic ?? "")

  await page.locator(".group-header").getByRole("button", { name: "Editar grupo", exact: true }).click()

  const settings = page.getByRole("dialog", { name: "Editar grupo", exact: true })
  await expect(settings.locator(".avatar-picker-stage [data-avatar-body]")).toHaveAttribute("fill", automatic ?? "")
})
