import { expect, test } from "bun:test"
import { getBrowserExecutableCheck } from "../../src/doctor/browser-executable"

test("a missing browser gives installation guidance without starting a session", async () => {
  const result = await getBrowserExecutableCheck({
    platform: "linux",
    path: "/fixture/bin",
    which: () => null,
    canExecute: async () => {
      throw new Error("No executable should be probed")
    },
    signal: new AbortController().signal,
  })

  expect(result).toMatchObject({ id: "browser-executable", status: "warn" })
  expect(result.detail).toContain("Instale um navegador compatível")
  expect(JSON.stringify(result)).not.toContain("/fixture")
})

test("an installed browser does not claim that its transport or page is ready", async () => {
  const result = await getBrowserExecutableCheck({
    platform: "linux",
    path: "/fixture/bin",
    which: (name) => (name === "chromium" ? "/fixture/bin/browser" : null),
    canExecute: async (file) => file === "/fixture/bin/browser",
    signal: new AbortController().signal,
  })

  expect(result).toMatchObject({ status: "pass" })
  expect(result.detail).toContain("serão verificadas")
  expect(JSON.stringify(result)).not.toContain("/fixture")
})

test("a broken explicit executable fails even if another browser is on PATH", async () => {
  const result = await getBrowserExecutableCheck({
    platform: "linux",
    path: "/fixture/bin",
    executable: "/fixture/missing",
    which: () => "/fixture/other",
    canExecute: async () => false,
    signal: new AbortController().signal,
  })

  expect(result.status).toBe("warn")
})

test("a canceled diagnostic stops before probing the browser", async () => {
  const controller = new AbortController()
  controller.abort()

  await expect(
    getBrowserExecutableCheck({
      platform: "linux",
      path: "",
      which: () => null,
      signal: controller.signal,
    }),
  ).rejects.toThrow()
})
