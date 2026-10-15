import { expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import rootPackage from "../../../package.json"
import { resolveTouriVersion } from "../../src/version"

const sourceRoot = join(import.meta.dir, "..", "..", "src")

const sourceFiles = (dir: string): Array<string> =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return full.endsWith(".ts") ? [full] : []
  })

test("without TOURI_VERSION the sidecar reports the root package version", () => {
  expect(resolveTouriVersion({})).toBe(rootPackage.version)
  expect(resolveTouriVersion({ TOURI_VERSION: "  " })).toBe(rootPackage.version)
})

test("an explicit TOURI_VERSION still wins", () => {
  expect(resolveTouriVersion({ TOURI_VERSION: "9.8.7" })).toBe("9.8.7")
})

test("no sidecar source hardcodes its own version", () => {
  const hardcoded = /TOURI_VERSION\s*\?\?\s*["']|name:\s*"touri[\w-]*",\s*version:\s*"\d|ok:\s*true,\s*version:\s*"\d/
  const offenders = sourceFiles(sourceRoot).filter((file) => hardcoded.test(readFileSync(file, "utf8")))
  expect(offenders).toEqual([])
})
