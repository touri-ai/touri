import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { linuxTests, needsNative, sidecarShard, testFiles } from "../../../.github/ci/selection"

const workflow = readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8")
const jobs = new Map(
  [...workflow.matchAll(/^ {2}([\w-]+):\n([\s\S]*?)(?=^ {2}[\w-]+:|$(?![\s\S]))/gm)].map((match) => [
    match[1],
    match[2] ?? "",
  ]),
)

test("required checks remain jobs; every shard must pass the sidecar gate", () => {
  for (const name of [
    "contracts",
    "sidecar",
    "rust",
    "ui",
    "vitest",
    "composer-performance",
    "license-check",
    "linux",
    "windows",
  ]) {
    expect(jobs.has(name)).toBe(true)
  }
  for (const name of ["rust", "linux", "windows"]) {
    expect(jobs.get(name)).not.toMatch(/^ {4}if:/m)
    expect(jobs.get(name)).toContain("if: needs.changes.outputs.native == 'true'")
  }
  expect(jobs.get("sidecar")).toContain("needs: sidecar-tests")
  expect(jobs.get("sidecar")).toContain("if: always()")
  expect(jobs.get("sidecar")).toContain('test "$RESULT" = success')
  expect(jobs.get("sidecar-tests")).toMatch(/shard: \[1, 2, 3\]/)
  expect(jobs.get("sidecar-tests")).toMatch(/run: bun \.github\/ci\/sidecar-tests\.ts \$\{\{ matrix.shard \}\}/)
})

test("installers and artifact uploads run on main/manual runs, with full Linux coverage", () => {
  for (const name of ["linux", "windows"]) {
    for (const step of jobs.get(name)?.split(/^ {6}- /m) ?? []) {
      if (step.includes("--bundles") || step.includes("actions/upload-artifact")) {
        expect(step).toContain("if: github.event_name != 'pull_request'")
      }
    }
  }
  expect(jobs.get("linux")).toContain(
    "if: github.event_name != 'pull_request'\n        run: bun test --timeout 30000 sidecar/test",
  )
  expect(jobs.get("linux")).toContain(
    "if: github.event_name == 'pull_request'\n        run: bun .github/ci/sidecar-tests.ts linux",
  )
  expect(workflow).toMatch(/cancel-in-progress: \$\{\{ github.event_name == 'pull_request' \}\}/)
})

test("verified downloads are saved before later checks can fail", () => {
  const composer = jobs.get("composer-performance") ?? ""
  const workspace = readFileSync(new URL("../../../.github/actions/setup-bun/action.yml", import.meta.url), "utf8")

  const browserSave = composer.indexOf("name: Save verified browser downloads")
  const browserCheck = composer.indexOf("name: Check long-conversation typing")
  const workspaceInstall = workspace.indexOf("run: bun install --frozen-lockfile")
  const workspaceSave = workspace.indexOf("name: Save verified workspace dependencies")

  expect(browserSave).toBeGreaterThan(0)
  expect(browserCheck).toBeGreaterThan(browserSave)
  expect(workspaceInstall).toBeGreaterThan(0)
  expect(workspaceSave).toBeGreaterThan(workspaceInstall)
  expect(composer).toContain("uses: actions/cache/save@")
  expect(workspace).toContain("uses: actions/cache/save@")
})

test("UI and documentation PRs skip native work; native, policy and workflow PRs run it", () => {
  expect(needsNative("pull_request", ["ui/src/App.tsx", "README.md"])).toBe(false)
  for (const path of [
    "src-tauri/src/main.rs",
    "src-tauri/Cargo.lock",
    "Cargo.toml",
    ".cargo/config.toml",
    "rust-toolchain.toml",
    ".github/workflows/ci.yml",
    ".github/actions/setup-bun/action.yml",
    "scripts/test-native-linux.sh",
    "scripts/test-rust-policy.py",
  ]) {
    expect(needsNative("pull_request", [path])).toBe(true)
  }
})

test("main and manual runs always keep native coverage, even with no changed paths", () => {
  for (const event of ["push", "workflow_dispatch"]) {
    expect(needsNative(event, [])).toBe(true)
    expect(needsNative(event, ["README.md"])).toBe(true)
  }
})

test("every current and future sidecar test belongs to exactly one nonempty shard", () => {
  const files = testFiles()
  const future = ["new-directory/nested/example.test.ts", "root.test.ts"]
  const shards = [1, 2, 3].map((shard) => [...files, ...future].filter((file) => sidecarShard(file) === shard))
  expect(shards.every((shard) => shard.length > 0)).toBe(true)
  expect(shards.flat().sort()).toEqual([...files, ...future].sort())
  expect(sidecarShard("runtime/runtime.test.ts")).not.toBe(sidecarShard("vm/runtime.test.ts"))
})

describe("test file discovery", () => {
  let root = ""
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "touri-ci-selection-"))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  test("keeps every supported suffix and extension, including new directories", () => {
    mkdirSync(join(root, "future/nested"), { recursive: true })
    const expected = [".test", "_test", ".spec", "_spec"].flatMap((suffix) =>
      ["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts"].map(
        (extension) => `future/nested/example${suffix}.${extension}`,
      ),
    )
    const fixtures = [...expected, "helper.ts", "example.test.json"]
    fixtures.forEach((file) => {
      writeFileSync(join(root, file), "")
    })

    const found = testFiles(root)

    expect(new Set(found)).toEqual(new Set(expected))
    expect(found).toHaveLength(expected.length)
  })
})

test("Linux PRs include platform, Linux and confinement tests without the full Unix suite", () => {
  const expected = [
    "kernel/sqlite-sync-benchmark.test.ts",
    "platform/transport.test.ts",
    "runtime/linux-folder-live.test.ts",
    "projects/linux-process-sandbox.test.ts",
    "mcp/shim-sandbox.test.ts",
    "runtime/local-sandbox.test.ts",
    "new/confinement.test.ts",
  ]
  expect(linuxTests([...expected, "runtime/runtime.test.ts", "vm/runtime.test.ts"])).toEqual(expected)
  const selected = linuxTests(testFiles())
  expect(selected.length).toBeGreaterThan(0)
  expect(selected.length).toBeLessThan(testFiles().length)
})
