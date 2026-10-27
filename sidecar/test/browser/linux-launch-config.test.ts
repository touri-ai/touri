import { expect, test } from "bun:test"
import {
  deriveChromePortLaunchArgs,
  deriveChromeWindowConfig,
  getChromeExitCause,
  getChromeProfilePath,
} from "../../src/browser/launcher"

test("managed Linux browsers stay headful without a display and in server mode", () => {
  expect(deriveChromeWindowConfig({ env: {}, platform: "linux" }).headless).toBe(false)
  expect(deriveChromeWindowConfig({ env: { DISPLAY: ":1" }, platform: "linux" }).headless).toBe(false)
  expect(deriveChromeWindowConfig({ env: { TOURI_HEADLESS: "1", DISPLAY: ":1" }, platform: "linux" }).headless).toBe(
    false,
  )
})

test.each([undefined, "", "0", "true"])("sandbox opt-out requires exactly 1 (received %s)", (value) => {
  const args = deriveChromePortLaunchArgs({
    profile: "/data/browser/profile",
    port: 18888,
    env: { TOURI_BROWSER_NO_SANDBOX: value },
  })

  expect(args).not.toContain("--no-sandbox")
  expect(args).not.toContain("--disable-dev-shm-usage")
})

test("operator can explicitly opt out of the sandbox and use disk-backed shared memory", () => {
  const args = deriveChromePortLaunchArgs({
    profile: "/data/browser/profile",
    port: 18888,
    env: { TOURI_BROWSER_NO_SANDBOX: "1", TOURI_BROWSER_DISABLE_DEV_SHM_USAGE: "1" },
  })

  expect(args).toContain("--no-sandbox")
  expect(args).toContain("--disable-dev-shm-usage")
})

test("browser exit status distinguishes possible memory exhaustion from crashes", () => {
  expect(getChromeExitCause({ code: 137, signal: null })).toBe("memory")
  expect(getChromeExitCause({ code: null, signal: "SIGKILL" })).toBe("memory")
  expect(getChromeExitCause({ code: 1, signal: null })).toBe("crash")
  expect(getChromeExitCause({ code: 0, signal: null })).toBeNull()
})

test("ordinary Chrome launch preserves the native identity and graphics defaults", () => {
  const args = deriveChromePortLaunchArgs({
    profile: "/workspace/bot/browser/profile",
    port: 18888,
    env: { TOURI_HEADLESS: "1" },
  })

  expect(args).toEqual([
    "--user-data-dir=/workspace/bot/browser/profile",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1280,860",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=18888",
    "about:blank",
  ])
})

test("persistent profiles are stable and private to each bot", () => {
  const paths = { botsDir: "/workspace/bots", browserDir: "/workspace/browser" }

  const first = getChromeProfilePath(paths, "lia")
  const restarted = getChromeProfilePath(paths, "lia")
  const other = getChromeProfilePath(paths, "leo")

  expect(first).toBe("/workspace/bots/lia/browser/profile")
  expect(restarted).toBe(first)
  expect(other).not.toBe(first)
  expect(() => getChromeProfilePath(paths, "../escape")).toThrow("Invalid browser bot ID")
})
