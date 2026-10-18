import { expect, test } from "bun:test"
import { getHostKind, getHostNoun } from "@touri/contracts"
import { getHost, getHostIdentity } from "../../src/platform/host"

test.each([
  ["darwin", false, "mac", "Mac", "Mac"],
  ["linux", false, "computer", "computador", "computer"],
  ["win32", false, "computer", "computador", "computer"],
  ["freebsd", false, "computer", "computador", "computer"],
  ["linux", true, "server", "servidor", "server"],
  ["darwin", true, "server", "servidor", "server"],
] as const)("%s headless=%s reports %s in both languages", (platform, headless, expected, portuguese, english) => {
  const host = getHostKind(platform, headless)

  expect(host).toBe(expected)
  expect(getHost(platform, headless)).toBe(host)
  expect(getHostIdentity(platform, headless)).toEqual({ hostKind: host, host: host === "mac" ? "mac" : "server" })
  expect(getHostNoun(host)).toBe(portuguese)
  expect(getHostNoun(host, "en")).toBe(english)
})
