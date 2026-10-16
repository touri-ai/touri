import { readFileSync } from "node:fs"
import { afterEach, expect, test, vi } from "vitest"
import { initializeTheme, readTheme, setTheme } from "../src/design/theme"

const tokens = readFileSync("src/design/tokens.css", "utf8")
const css = readFileSync("src/styles.css", "utf8")
const motion = readFileSync("src/design/motion.css", "utf8")
const declarations = (source: string): Record<string, string> =>
  Object.fromEntries([...source.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2]]))
const [base = "", light = ""] = tokens.split(':root[data-theme="light"]')
const palette = (theme: "dark" | "light") => {
  const values = { ...declarations(base), ...declarations(motion), ...(theme === "light" ? declarations(light) : {}) }
  const resolve = (name: string): string => {
    const value = values[name]
    if (!value) throw new Error(`Missing token ${name}`)
    return value.replace(/var\((--[\w-]+)\)/g, (_, child: string) => resolve(child))
  }
  return resolve
}
const contrast = (foreground: string, background: string): number => {
  const luminance = (color: string): number => {
    const expanded = color.length === 4 ? `#${[...color.slice(1)].map((char) => char + char).join("")}` : color
    const channels = [1, 3, 5].map((offset) => {
      const normalized = Number.parseInt(expanded.slice(offset, offset + 2), 16) / 255
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
    })
    return (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722
  }
  const a = luminance(foreground)
  const b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

afterEach(() => {
  vi.restoreAllMocks()
  setTheme("dark")
  delete document.documentElement.dataset.theme
  document.documentElement.classList.remove("dark")
})

test.each(["dark", "light"] as const)("%s text roles meet WCAG AA and brand stays touri red", (theme) => {
  const color = palette(theme)
  for (const text of ["--text-primary", "--text-body", "--text-secondary", "--text-tertiary"]) {
    const surfaces = ["--surface-canvas", "--surface-panel", "--surface-control"]
    if (text !== "--text-tertiary") surfaces.push("--surface-control-raised")
    for (const surface of surfaces) {
      expect(contrast(color(text), color(surface)), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5)
    }
  }
  expect(color("--accent-brand")).toBe("#dc2626")
  expect(contrast(color("--text-on-accent"), color("--accent-brand"))).toBeGreaterThanOrEqual(4.5)
  if (theme === "light") {
    expect(contrast(color("--text-on-accent"), color("--accent-info"))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(color("--text-link"), color("--surface-panel"))).toBeGreaterThanOrEqual(4.5)
  }
})

test("the migration keeps dark touri surfaces and fonts, and components only consume color roles", () => {
  const color = palette("dark")
  expect(color("--surface-canvas")).toBe("#0b0b0b")
  expect(color("--surface-panel")).toBe("#1c1c1e")
  expect(color("--text-tertiary")).toBe("#a1a1a6")
  expect(tokens).toContain('"DM Sans"')
  expect(tokens).toContain('"DM Mono"')
  expect(tokens).toContain('"Space Grotesk"')
  expect(css).not.toMatch(/#[\da-f]{3,8}\b|rgb\(/i)
  for (const match of css.matchAll(/var\((--[\w-]+)\)/g)) {
    // Avatar geometry is supplied dynamically by the existing avatar component.
    if (match[1]?.startsWith("--avatar-")) continue
    // The registered activity ink aliases a text role locally; its role references are checked below.
    if (match[1] === "--activity-ink") {
      expect(declarations(css)[match[1]]).toMatch(/^var\(--text-[\w-]+\)$/)
      continue
    }
    expect(() => color(match[1] ?? "")).not.toThrow()
  }
})

test("dark is the existing default, explicit themes persist and invalid storage is ignored", () => {
  expect(readTheme()).toBe("dark")
  setTheme("light")
  expect(readTheme()).toBe("light")
  expect(document.documentElement.dataset.theme).toBe("light")
  setTheme("dark")
  expect(document.documentElement.classList.contains("dark")).toBe(true)
  localStorage.setItem("touri.appearance.v1", "invalid")
  expect(readTheme()).toBe("dark")
})

test("system theme follows OS changes, explicit themes do not, and listeners clean up", () => {
  const media = new EventTarget() as EventTarget & { matches: boolean }
  media.matches = true
  vi.spyOn(window, "matchMedia").mockReturnValue(media as MediaQueryList)
  setTheme("system")
  const cleanup = initializeTheme()
  expect(document.documentElement.dataset.theme).toBe("dark")
  media.matches = false
  media.dispatchEvent(new Event("change"))
  expect(document.documentElement.dataset.theme).toBe("light")
  setTheme("dark")
  media.dispatchEvent(new Event("change"))
  expect(document.documentElement.dataset.theme).toBe("dark")
  cleanup()
  localStorage.setItem("touri.appearance.v1", "light")
  window.dispatchEvent(new Event("storage"))
  expect(document.documentElement.dataset.theme).toBe("dark")
})

test("unavailable local storage still allows the chosen theme to be displayed", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("unavailable")
  })
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("unavailable")
  })
  expect(readTheme()).toBe("dark")
  const cleanup = initializeTheme()
  expect(() => setTheme("light")).not.toThrow()
  expect(document.documentElement.dataset.theme).toBe("light")
  window.dispatchEvent(new Event("storage"))
  expect(document.documentElement.dataset.theme).toBe("light")
  cleanup()
})
