import { expect, test } from "bun:test"
import { mergePath } from "../../src/kernel/shell-env"

test("Windows PATH keeps drive letters, uses semicolons and deduplicates case-insensitively", () => {
  const path = mergePath({
    platform: "win32",
    path: "C:\\Tools;D:\\Other;C:\\TOOLS",
    home: "C:\\fixture-profile",
    exists: () => false,
  })
  expect(path).toBe("C:\\Tools;D:\\Other")
  expect(mergePath({ platform: "linux", path: "/tools:/other:/tools", home: "/fixture", exists: () => false })).toBe(
    "/tools:/other",
  )
})
