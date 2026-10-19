import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { assertBunToolchain, getBunToolchainError, pinnedBunVersion } from "../../../scripts/bun-toolchain"

const root = join(import.meta.dir, "..", "..", "..")
const workflowDir = join(root, ".github", "workflows")

const getWorkflowBunVersions = (): Array<string> =>
  readdirSync(workflowDir)
    .filter((name) => name.endsWith(".yml"))
    .flatMap((name) => [...readFileSync(join(workflowDir, name), "utf8").matchAll(/bun-version:\s*([0-9.]+)/g)])
    .map((match) => match[1] ?? "")

describe("bun toolchain", () => {
  test("accepts the pinned version", () => {
    expect(getBunToolchainError(pinnedBunVersion)).toBeUndefined()
    expect(() => assertBunToolchain(pinnedBunVersion)).not.toThrow()
  })

  test("rejects an older runtime that would be embedded in the binary", () => {
    expect(getBunToolchainError("1.2.21", "1.4.3")).toContain("install Bun 1.4.3")
    expect(() => assertBunToolchain("1.2.21")).toThrow("Bun 1.2.21 cannot build touri binaries")
  })

  test("CI and release workflows build with the pinned version", () => {
    const versions = getWorkflowBunVersions()
    expect(versions.length).toBeGreaterThan(0)
    expect(new Set(versions)).toEqual(new Set([pinnedBunVersion]))
  })

  test("every binary build script checks the toolchain before compiling", () => {
    const scripts = ["build-cli.ts", "build-sidecar.ts"].map((name) =>
      readFileSync(join(root, "scripts", name), "utf8"),
    )
    expect(scripts.every((source) => source.includes("assertBunToolchain()"))).toBe(true)
  })
})
