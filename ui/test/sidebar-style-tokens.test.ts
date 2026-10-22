import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

const getCssSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8")

it("uses only declared design tokens in the sidebar and channel styles", () => {
  const componentCss = `${getCssSource("../src/components/bot-sidebar.css")}\n${getCssSource("../src/components/groups.css")}`
  const tokensCss = getCssSource("../src/design/tokens.css")
  const declared = new Set(
    [...tokensCss.matchAll(/--([\w-]+)\s*:/g), ...componentCss.matchAll(/--([\w-]+)\s*:/g)].map((match) => match[1]),
  )
  const referenced = new Set([...componentCss.matchAll(/var\(\s*--([\w-]+)/g)].map((match) => match[1]))
  const undefinedTokens = [...referenced].filter((token) => !declared.has(token))

  expect(undefinedTokens).toEqual([])
  expect(componentCss).toContain("content-visibility: auto")
  expect(componentCss).toContain("contain-intrinsic-size: auto 44px")
})
