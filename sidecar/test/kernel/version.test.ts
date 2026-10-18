import { expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import rootPackage from "../../../package.json"
import { resolveTouriVersion } from "../../src/version"

const sourceRoot = join(import.meta.dir, "..", "..", "src")
const repoRoot = join(import.meta.dir, "..", "..", "..")

test("the 0.3.0 release keeps workspace and desktop versions in sync", () => {
  expect(rootPackage.version).toBe("0.3.0")
  for (const file of [
    "sidecar/package.json",
    "ui/package.json",
    "packages/contracts/package.json",
    "src-tauri/tauri.conf.json",
  ]) {
    const manifest = JSON.parse(readFileSync(join(repoRoot, file), "utf8"))
    expect(manifest.version).toBe(rootPackage.version)
  }
  const cargo = readFileSync(join(repoRoot, "src-tauri/Cargo.toml"), "utf8")
  const lock = readFileSync(join(repoRoot, "src-tauri/Cargo.lock"), "utf8")
  const workspaces = readFileSync(join(repoRoot, "bun.lock"), "utf8").split('  "packages": {')[0] ?? ""
  const workspaceVersions = [...workspaces.matchAll(/"version": "([^"]+)"/g)].map((match) => match[1])
  expect(workspaceVersions).toEqual([rootPackage.version, rootPackage.version, rootPackage.version])
  expect(cargo.match(/^version = "([^"]+)"/m)?.[1]).toBe(rootPackage.version)
  expect(lock.match(/name = "touri"\nversion = "([^"]+)"/)?.[1]).toBe(rootPackage.version)
})

test("the Debian package declares the documented Linux runtime dependencies", () => {
  const config = JSON.parse(readFileSync(join(repoRoot, "src-tauri/tauri.conf.json"), "utf8"))
  const linux = JSON.parse(readFileSync(join(repoRoot, "src-tauri/tauri.linux.conf.json"), "utf8"))
  // Tauri replaces arrays in platform overrides instead of appending to them.
  const depends = linux.bundle?.linux?.deb?.depends ?? config.bundle.linux?.deb?.depends
  expect(depends).toEqual(
    expect.arrayContaining(["libwebkit2gtk-4.1-0", "libsecret-1-0", "libsqlite3-0", "xdg-utils", "dbus-user-session"]),
  )
})

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
