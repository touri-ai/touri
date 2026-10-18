import { mkdir } from "node:fs/promises"
import { expect, test } from "@playwright/test"

const fixture = "/test/e2e/fixtures/mascot-parity.html"
type AvatarDrawWindow = Window & { avatarDraws: { body: number } }

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
  const before = await working.innerHTML()
  await page.mouse.move(600, 200)
  await page.waitForTimeout(200)
  expect(await working.innerHTML()).toBe(before)
  await expect(working).toHaveAttribute("data-avatar-animated", "false")
  expect(await working.evaluate((element) => getComputedStyle(element).animationName)).toBe("none")
})

test("runtime moods keep identity, freeze under reduced motion, and produce headless evidence", async ({
  page,
}, testInfo) => {
  test.setTimeout(60000)
  expect(testInfo.project.use.headless).toBe(true)
  const captureEvidence = process.env.TOURI_QA_SCREENSHOTS === "1"
  if (captureEvidence) await mkdir("/tmp/touri-evidence/frames", { recursive: true })
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.goto("/test/e2e/fixtures/avatars.html")
  const avatar = page.locator("#gallery .tb-avatar").first()
  const eye = avatar.locator("[data-avatar-eye]").first()
  const shape = await avatar.getAttribute("data-avatar-shape")
  let index = 0
  for (const mood of ["idle", "working", "waiting", "failed", "responded", "asleep", "connecting"]) {
    await page.getByLabel("Mood").selectOption(mood)
    await expect(avatar).toHaveAttribute("data-avatar-mood", mood)
    await expect(avatar).toHaveAttribute("data-avatar-shape", shape ?? "")
    if (mood === "working") {
      await expect(eye).toHaveAttribute("transform", /matrix/)
      const before = await eye.getAttribute("transform")

      await expect.poll(() => eye.getAttribute("transform")).not.toBe(before)
    }
    if (captureEvidence)
      await page.locator("#gallery").screenshot({ path: `/tmp/touri-evidence/bloub-${mood}.png`, animations: "allow" })
    for (let frame = 0; captureEvidence && frame < 6; frame++) {
      if (captureEvidence)
        await page.locator("#gallery").screenshot({
          path: `/tmp/touri-evidence/frames/bloub-${String(index++).padStart(3, "0")}.png`,
          animations: "allow",
        })
      await page.waitForTimeout(80)
    }
  }
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.getByLabel("Mood").selectOption("working")
  await expect(avatar).toHaveAttribute("data-avatar-animated", "false")
  const still = await avatar.locator(".tb-avatar-body").innerHTML()
  await page.mouse.move(500, 200)
  await page.waitForTimeout(700)
  expect(await avatar.locator(".tb-avatar-body").innerHTML()).toBe(still)
  await page.getByLabel("Mood").selectOption("failed")
  await expect(avatar).toHaveAttribute("data-avatar-expression", "triste")
  expect(await avatar.locator(".tb-avatar-body").innerHTML()).not.toBe(still)
  if (captureEvidence)
    await page.locator("#gallery").screenshot({ path: "/tmp/touri-evidence/bloub-reduced-motion.png" })
})

test("resting rows ignore global pointer movement and animate their montage on hover and focus", async ({ page }) => {
  test.setTimeout(90000)
  await page.clock.install()
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto(fixture)
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.locator("#gallery").evaluate((node) => node.remove())
  const button = page.locator("#hover-probe")
  await button.scrollIntoViewIfNeeded()
  const avatar = button.locator(".tb-avatar")
  const svg = avatar.locator(".tb-avatar-body")
  await page.clock.runFor(300)
  const still = await svg.innerHTML()
  await page.mouse.move(20, 20)
  await page.clock.runFor(500)
  expect(await svg.innerHTML()).toBe(still)
  await expect(avatar).toHaveAttribute("data-avatar-animated", "false")
  await button.hover()
  await expect(avatar).toHaveAttribute("data-avatar-animated", "true")
  const seen = new Set<string>()
  for (let i = 0; i < 27; i++) {
    await page.clock.runFor(500)
    seen.add((await avatar.getAttribute("data-avatar-state")) ?? "")
  }
  expect([...seen].sort()).toEqual(["idle", "wide", "wink"])
  await page.mouse.move(20, 20)
  await expect(avatar).toHaveAttribute("data-avatar-animated", "false")
  await button.focus()
  await expect(avatar).toHaveAttribute("data-avatar-animated", "true")
})

test("active avatars cap DOM draws and pause their body offscreen", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 200 })
  test.setTimeout(90000)
  await page.clock.install()
  await page.goto(fixture)
  const avatar = page.locator('[data-seed="mark"][data-mood="working"] .tb-avatar').first()
  await page.clock.runFor(100)
  await avatar.evaluate((element) => {
    const body = element.querySelector(".tb-avatar-body")
    if (!body) throw new Error("Missing avatar body")

    // The renderer reuses SVG nodes, so each draw updates attributes rather than children.
    const counts = { body: 0 }
    const fixtureWindow = window as AvatarDrawWindow
    fixtureWindow.avatarDraws = counts
    new MutationObserver(() => counts.body++).observe(body, {
      attributes: true,
      subtree: true,
      attributeFilter: ["d", "transform"],
    })
  })

  await page.clock.runFor(1000)

  const counts = await page.evaluate(() => (window as AvatarDrawWindow).avatarDraws)
  expect(counts.body).toBeGreaterThan(15)
  expect(counts.body).toBeLessThanOrEqual(30)
  await expect(avatar.locator(".tb-avatar-rings")).toHaveCount(0)
  await expect(avatar.locator(".tb-avatar-contour")).toHaveCSS("animation-duration", "1.2s")
  await page.locator("#gaze-probe").scrollIntoViewIfNeeded()
  await page.clock.runFor(100)
  const stopped = await avatar.innerHTML()
  await page.clock.runFor(500)
  expect(await avatar.innerHTML()).toBe(stopped)
})

test("optional pointer gaze follows nearby movement and a press nods; reduced motion disables it", async ({ page }) => {
  test.setTimeout(90000)
  await page.clock.install()
  await page.goto(fixture)
  await page.locator("#gallery").evaluate((node) => node.remove())
  const probe = page.locator("#gaze-probe .tb-avatar")
  await probe.scrollIntoViewIfNeeded()
  const box = await probe.boundingBox()
  if (!box) throw new Error("Missing gaze avatar")
  const eyes = probe.locator("[data-avatar-eye]")
  const initial = await eyes.first().getAttribute("transform")
  await page.mouse.move(box.x + box.width / 2 + 350, box.y + box.height / 2)
  await page.clock.runFor(800)
  expect(await eyes.first().getAttribute("transform")).not.toBe(initial)
  const matrices = await eyes.evaluateAll((nodes) =>
    nodes.map((eye) => (eye.getAttribute("transform") ?? "").slice(7, -1).split(",").map(Number)),
  )
  for (const matrix of matrices) {
    expect(Math.abs(matrix[4] ?? Infinity)).toBeLessThan(100)
    expect(Math.abs(matrix[5] ?? Infinity)).toBeLessThan(100)
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.clock.runFor(1000)
  const beforeNod = await eyes.first().getAttribute("transform")
  await probe.dispatchEvent("pointerdown", { pointerType: "mouse" })
  await page.clock.runFor(130)
  expect(await eyes.first().getAttribute("transform")).not.toBe(beforeNod)
  await page.emulateMedia({ reducedMotion: "reduce" })
  await expect(probe).toHaveAttribute("data-avatar-animated", "false")
  const frozen = await probe.innerHTML()
  await page.mouse.move(400, 400)
  await probe.dispatchEvent("pointerdown")
  await page.clock.runFor(1000)
  expect(await probe.innerHTML()).toBe(frozen)
})
