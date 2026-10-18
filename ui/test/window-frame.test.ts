import { expect, test } from "vitest"
import { getWindowChrome } from "../src/components/WindowFrame"

const cases = [
  { native: true, userAgent: "Macintosh", search: "", expected: "overlay" },
  { native: true, userAgent: "Mac OS X", search: "?bot=demo", expected: "overlay" },
  { native: false, userAgent: "Macintosh", search: "", expected: "system" },
  { native: true, userAgent: "Macintosh", search: "?computer=demo", expected: "system" },
  { native: true, userAgent: "Linux", search: "", expected: "system" },
  { native: true, userAgent: "Windows NT", search: "", expected: "system" },
]

test.each(cases)("$userAgent with native=$native and $search uses $expected chrome", (input) => {
  const chrome = getWindowChrome(input)

  expect(chrome).toBe(input.expected)
})
