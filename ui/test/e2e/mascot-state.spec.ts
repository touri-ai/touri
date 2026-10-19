import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

const fixture = "/test/e2e/fixtures/mascot-states.html"
test("state poses preserve bull identity and readable activity responds to the same state", async ({ page }, info) => {
  test.setTimeout(60000)
  await page.clock.install()
  await page.goto(fixture)
  const avatar = page.locator("#probe > div:first-child .tb-avatar")
  const shape = await avatar.getAttribute("data-avatar-shape")
  const color = await avatar.locator("[data-avatar-body]").getAttribute("fill")
  for (const state of [
    "thinking",
    "working-tool",
    "waiting-approval",
    "typing",
    "error",
    "done",
    "sleeping",
    "parked",
    "listening",
    "idle",
  ]) {
    await page.getByLabel("Estado").selectOption(state)
    await expect(avatar).toHaveAttribute("data-mascot-state", state)
    await expect(avatar).toHaveAttribute("data-avatar-shape", shape ?? "")
    await expect(avatar.locator("[data-avatar-body]")).toHaveAttribute("fill", color ?? "")
    if (["thinking", "working-tool", "typing", "waiting-approval"].includes(state))
      await expect(page.locator("#probe .activity-mark")).toHaveAttribute("data-mascot-state", state)
    else await expect(page.locator("#probe .activity-mark")).toHaveCount(0)
  }
  await page.getByLabel("Estado").selectOption("working-tool")
  await page.clock.runFor(100)
  const mark = page.locator("#probe .activity-mark")
  await expect(mark.getByRole("status")).toHaveText("Trabalhando…")
  await expect(mark.locator(".activity-dots i")).toHaveCount(3)
  await expect(mark.locator(".activity-dots i").first()).toHaveCSS("animation-name", "activity-dot")
  await expect(mark.locator("linearGradient")).toHaveCount(0)
  await page.getByLabel("Estado").selectOption("waiting-approval")
  await expect(mark.getByRole("status")).toHaveText("Preciso da sua autorização.")
  await expect(mark.locator(".activity-dots")).toHaveCount(0)
  await page.getByLabel("Estado").selectOption("thinking")
  await expect(mark.getByRole("status")).toHaveText("Preparando a resposta…")
  await page.screenshot({ path: info.outputPath("mascot-states.png") })
  const audit = await new AxeBuilder({ page }).analyze()
  expect(audit.violations.filter((item) => ["serious", "critical"].includes(item.impact ?? ""))).toEqual([])
})

test("reduced motion freezes eyes, body, breathing and dots but retains status text", async ({ page }, info) => {
  await page.clock.install()
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto(fixture)
  const avatar = page.locator("#probe > div:first-child .tb-avatar")
  const mark = page.locator("#probe .activity-mark")
  await expect(avatar).toHaveAttribute("data-avatar-animated", "false")
  const still = await avatar.innerHTML()
  await expect(mark.locator(".tb-avatar")).toHaveAttribute("data-avatar-animated", "false")
  await expect(mark.locator(".activity-dots i").first()).toHaveCSS("animation-name", "none")
  await page.mouse.move(400, 300)
  await page.clock.runFor(2000)
  expect(await avatar.innerHTML()).toBe(still)
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0)
  expect(await avatar.evaluate((node) => getComputedStyle(node).animationName)).toBe("none")
  await page.getByLabel("Estado").selectOption("waiting-approval")
  await expect(page.locator("#probe .activity-mark")).toHaveText("Preciso da sua autorização.")
  await expect(avatar).toHaveAttribute("data-avatar-phase", "waiting")
  await page.screenshot({ path: info.outputPath("mascot-reduced-motion.png") })
})

for (const preference of ["system", "host"]) {
  test(`${preference}: reducing motion live freezes the avatar and preserves its state`, async ({ page }) => {
    await page.clock.install()
    await page.goto(fixture)
    const avatar = page.locator("#probe > div:first-child .tb-avatar")
    await expect(avatar).toHaveAttribute("data-avatar-animated", "true")
    if (preference === "system") await page.emulateMedia({ reducedMotion: "reduce" })
    else
      await page.evaluate(() => {
        document.documentElement.dataset.motion = "reduce"
      })
    await expect(avatar).toHaveAttribute("data-avatar-animated", "false")
    const still = await avatar.innerHTML()
    await page.clock.runFor(2000)
    expect(await avatar.innerHTML()).toBe(still)
    await expect(avatar).toHaveAttribute("data-mascot-phase", "thinking")
    await expect(page.locator("#probe .activity-mark")).toHaveText("Preparando a resposta…")
    if (preference === "system") await page.emulateMedia({ reducedMotion: "no-preference" })
    else
      await page.evaluate(() => {
        delete document.documentElement.dataset.motion
      })
    await expect(avatar).toHaveAttribute("data-avatar-animated", "true")
  })
}
