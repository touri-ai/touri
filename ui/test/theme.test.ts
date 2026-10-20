import { readdirSync, readFileSync } from "node:fs"
import { afterEach, expect, test, vi } from "vitest"
import { initializeTheme, readTheme, setTheme } from "../src/design/theme"

const tokens = readFileSync("src/design/tokens.css", "utf8")
const css = readFileSync("src/styles.css", "utf8")
const motion = readFileSync("src/design/motion.css", "utf8")
const groups = readFileSync("src/components/groups.css", "utf8")
const sidebar = readFileSync("src/components/bot-sidebar.css", "utf8")
const declarations = (source: string): Record<string, string> =>
  Object.fromEntries([...source.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2]]))
const [base = "", light = ""] = tokens.split(':root[data-theme="light"]')
const channelsOf = (hex: string): number[] => {
  const expanded = hex.length === 4 ? `#${[...hex.slice(1)].map((char) => char + char).join("")}` : hex
  return [1, 3, 5].map((offset) => Number.parseInt(expanded.slice(offset, offset + 2), 16))
}
const toHex = (channels: number[]): string =>
  `#${channels.map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`
const palette = (theme: "dark" | "light") => {
  const values = { ...declarations(base), ...declarations(motion), ...(theme === "light" ? declarations(light) : {}) }
  const evaluate = (expression: string): string => {
    const value = expression.trim()
    const reference = value.match(/^var\((--[\w-]+)\)$/)?.[1]
    if (reference) return evaluate(values[reference] ?? `missing(${reference})`)
    const mix = value.match(/^color-mix\(in srgb, (.+)\)$/)?.[1]
    if (!mix) return value
    const parts = mix.match(/^(.+?) (\d+%|var\(--[\w-]+\)|calc\(.+?\)), (.+)$/)
    const percent = (parts?.[2] ?? "")
      .replace(/var\((--[\w-]+)\)/g, (_, name: string) => evaluate(values[name] ?? "0%"))
      .replace(/^calc\((.+)\)$/, "$1")
      .split("+")
      .reduce((sum, part) => sum + Number.parseFloat(part), 0)
    const from = channelsOf(evaluate(parts?.[1] ?? ""))
    const into = channelsOf(evaluate(parts?.[3] ?? ""))
    return toHex(from.map((channel, index) => (channel * percent) / 100 + (into[index] ?? 0) * (1 - percent / 100)))
  }
  return (name: string): string => {
    if (!values[name]) throw new Error(`Missing token ${name}`)
    return evaluate(`var(${name})`)
  }
}
const contrast = (foreground: string, background: string): number => {
  const luminance = (color: string): number => {
    const channels = channelsOf(color).map((value) => {
      const normalized = value / 255
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
    })
    return (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722
  }
  const a = luminance(foreground)
  const b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}
const migrated = ["bot-sidebar", "settings", "Composer", "screens"].map((name) =>
  readFileSync(`src/components/${name}.css`, "utf8"),
)

afterEach(() => {
  vi.restoreAllMocks()
  setTheme("dark")
  delete document.documentElement.dataset.theme
  document.documentElement.classList.remove("dark")
})

const surfaces = ["--bg", "--surface", "--raised", "--overlay"]
const textRoles = ["--text", "--text-2", "--link", "--info", "--success", "--warning", "--danger"]
const fills = ["--brand", "--info-fill", "--preview-avatar"]
const statusPairs = [
  ["--text-danger", "--surface-danger"],
  ["--text-danger", "--surface-notice"],
  ["--text-warning", "--surface-warning"],
  ["--text-success", "--surface-success"],
  ["--text-link", "--surface-info"],
  ["--text-secondary", "--surface-control"],
  ["--text-secondary", "--surface-control-raised"],
  ["--text-secondary", "--surface-selected"],
  ["--text", "--surface-control-raised"],
  ["--success", "--overlay"],
  ["--warning", "--surface-selected"],
  ["--warning", "--surface-control-raised"],
  ["--text-primary", "--surface-chat-user"],
  ["--text-secondary", "--surface-chat-user"],
]

test.each(["dark", "light"] as const)("%s text roles keep 4.5:1 (12px captions included) on every surface", (theme) => {
  const color = palette(theme)
  for (const text of textRoles) {
    for (const surface of surfaces) {
      expect(contrast(color(text), color(surface)), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5)
    }
  }
  for (const [text = "", surface = ""] of statusPairs) {
    expect(contrast(color(text), color(surface)), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5)
  }
  expect(color("--brand")).toBe("#dc2626")
  expect(color("--danger")).not.toBe(color("--brand"))
  for (const fill of fills) {
    expect(contrast(color("--text-on-accent"), color(fill)), `text on ${fill}`).toBeGreaterThanOrEqual(4.5)
  }
  expect(css).toMatch(
    /\.button-brand,\s*\.brand-button \{[^}]*background: var\(--brand\);[^}]*color: var\(--text-on-accent\)/,
  )
  expect(css).toMatch(/\.notification-badge \{[^}]*background: var\(--brand\);[^}]*color: var\(--text-on-accent\)/)
  expect(css).toMatch(
    /\.preview-chat-avatar \{[^}]*background: var\(--preview-avatar\);[^}]*color: var\(--text-on-accent\)/,
  )
  expect(css).toMatch(/\.section-tabs b \{[^}]*background: var\(--info-fill\);[^}]*color: var\(--text-on-accent\)/)
  expect(css).toMatch(/\.wizard-active i \{[^}]*background: var\(--info-fill\);[^}]*color: var\(--text-on-accent\)/)
  expect(sidebar).toMatch(
    /\.sidebar-unread \{[^}]*background: var\(--surface-control-raised\);[^}]*color: var\(--text\)/,
  )
})

test("light selected and raised surfaces keep visible borders", () => {
  const color = palette("light")
  for (const fill of ["--surface-selected", "--surface-control-raised"]) {
    expect(color(fill), fill).toBe("#ececef")
    expect(color(fill), fill).not.toBe(color("--border"))
  }
  expect(color("--border-chat-table")).toBe("#cfcfd6")
  expect(color("--surface-settings-switch")).toBe("#d1d1d6")
})

test("errors use the danger role and inline code stays at least 12px", () => {
  expect(css).toMatch(/\.notification-kind\.kind-error \{[^}]*color: var\(--danger\)/)
  expect(groups).toMatch(/\.group-thread-list button\[aria-current\] \{[^}]*color: var\(--danger\)/)
  expect(css).toMatch(/\.markdown-content :not\(pre\) > code \{[^}]*font-size: max\(0\.87em, var\(--fs-caption\)\)/)
})

test("the semantic roles carry the design system v2 hexes in both themes", () => {
  const roles = ["--bg", "--surface", "--raised", "--overlay", "--border", "--border-strong", "--text", "--text-2"]
  const status = ["--link", "--success", "--warning"]
  expect(roles.map((role) => palette("dark")(role))).toEqual([
    "#0e0e10",
    "#161618",
    "#1d1d20",
    "#232327",
    "#2c2c30",
    "#3a3a3f",
    "#f2f2f3",
    "#a9a9b0",
  ])
  expect(roles.map((role) => palette("light")(role))).toEqual([
    "#f6f6f7",
    "#fff",
    "#fff",
    "#f0f0f2",
    "#e4e4e7",
    "#cfcfd6",
    "#18181b",
    "#52525b",
  ])
  expect(status.map((role) => palette("dark")(role))).toEqual(["#5aa9ff", "#34c77b", "#f5a524"])
  expect(status.map((role) => palette("light")(role))).toEqual(["#0b63c4", "#177a46", "#965800"])
  expect(palette("dark")("--info-fill")).toBe("#1f6fd1")
  expect(palette("light")("--info-fill")).toBe("#0b63c4")
})

test("type, space, radius and motion follow the v2 scales and nothing renders below 12px", () => {
  const all = declarations(base)
  const scale = (prefix: string, names: string[]) => names.map((name) => all[`--${prefix}-${name}`])
  expect(scale("fs", ["display", "title", "subtitle", "emphasis", "body", "meta", "caption"])).toEqual([
    "32px",
    "24px",
    "20px",
    "17px",
    "15px",
    "13px",
    "12px",
  ])
  expect(scale("radius", ["xs", "sm", "md", "lg", "pill"])).toEqual(["6px", "10px", "14px", "20px", "999px"])
  expect(scale("motion", ["fast", "base", "calm"])).toEqual(["120ms", "200ms", "320ms"])
  const spaces = Object.entries(all)
    .filter(([name]) => name.startsWith("--space-"))
    .map(([, value]) => Number.parseInt(value ?? "", 10))
  expect(spaces.filter((value) => value > 2 && value % 4 !== 0)).toEqual([])
  const rawNeutrals = Object.keys(all).filter((name) => /^--neutral-\d+$/.test(name))
  expect(rawNeutrals).toEqual(["--neutral-0", "--neutral-1000"])
  for (const source of [css, ...migrated]) {
    expect(source).not.toMatch(/--type-\d+|--radius-\d+|font-size: (?:[0-9]|1[01])px/)
    expect(source).not.toMatch(/var\(--space-(?:3|5|6|7|9|10|11|13|14|15|17|18|22|23|25|27|29|30|35|38)\)/)
  }
})

test("the migrated components consume the semantic roles", () => {
  for (const source of migrated) {
    expect(source).toMatch(/var\(--(?:text|text-2|surface|bg|border|border-strong|brand)\)/)
    expect(source).not.toMatch(
      /var\(--(?:text-primary|text-secondary|surface-panel|surface-canvas|border-default|accent-brand)\)/,
    )
  }
})

test("every shipped stylesheet uses defined design scale tokens", () => {
  const stylesheets = readdirSync("src", { recursive: true })
    .filter((name) => name.endsWith(".css"))
    .map((name) => ({ name, source: readFileSync(`src/${name}`, "utf8") }))
  const definedTokens = new Set(Object.keys(declarations(tokens)))

  const missingTokens = stylesheets.flatMap(({ name, source }) =>
    Array.from(source.matchAll(/var\((--(?:fs|type|space|radius)-[\w-]+)\)/g))
      .map((match) => match[1] ?? "")
      .filter((token) => !definedTokens.has(token))
      .map((token) => `${name}: ${token}`),
  )

  expect(missingTokens).toEqual([])
})

test("the migration keeps touri fonts and components only consume defined color roles", () => {
  const color = palette("dark")
  expect(tokens).toContain('"DM Sans"')
  expect(tokens).toContain('"DM Mono"')
  expect(tokens).toContain('"Space Grotesk"')
  expect(css).not.toMatch(/#[\da-f]{3,8}\b|rgb\(/i)
  for (const match of css.matchAll(/var\((--[\w-]+)\)/g)) {
    // Avatar geometry is supplied dynamically by the existing avatar component.
    if (match[1]?.startsWith("--avatar-")) continue
    // The registered activity ink aliases a text role locally; its role references are checked below.
    if (match[1] === "--activity-ink") {
      expect(declarations(css)[match[1]]).toMatch(/^var\(--(?:text(?:-[\w-]+)?|warning|danger|success|link)\)$/)
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
