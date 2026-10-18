import { expect, test } from "@playwright/test"
import { installMemoryCounters } from "./desktop-memory-profile"

test.use({ trace: "off" })
test.setTimeout(60_000)

test("code fences render without retaining a WebAssembly runtime", async ({ page }) => {
  await page.addInitScript(installMemoryCounters)

  await page.goto("/test/e2e/desktop-memory-harness.html")
  await expect(page.locator(".markdown-code")).toHaveCount(30, { timeout: 30_000 })
  await expect(page.locator(".markdown-highlight .shiki").first()).toBeAttached({ timeout: 30_000 })
  const instantiations = await page.evaluate(() => Reflect.get(window, "desktopMemoryCounters").wasmInstantiations)

  expect(instantiations).toBe(0)
  await expect(page.locator(".message-scroll")).toContainText('const sample = { value: 42, label: "exemplo" }')
})
