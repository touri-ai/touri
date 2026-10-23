import { expect, test } from "bun:test"
import { deriveChromeWindowConfig, getChromeExitCause } from "../../src/browser/launcher"

test("Linux without a display and server mode automatically use the headless browser", () => {
  expect(deriveChromeWindowConfig({ env: {}, platform: "linux" }).headless).toBe(true)
  expect(deriveChromeWindowConfig({ env: { DISPLAY: ":1" }, platform: "linux" }).headless).toBe(false)
  expect(deriveChromeWindowConfig({ env: { TOURI_HEADLESS: "1", DISPLAY: ":1" }, platform: "linux" }).headless).toBe(
    true,
  )
})

test("browser exit status distinguishes possible memory exhaustion from crashes", () => {
  expect(getChromeExitCause({ code: 137, signal: null })).toBe("memory")
  expect(getChromeExitCause({ code: null, signal: "SIGKILL" })).toBe("memory")
  expect(getChromeExitCause({ code: 1, signal: null })).toBe("crash")
  expect(getChromeExitCause({ code: 0, signal: null })).toBeNull()
})
