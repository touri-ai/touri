import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { hostLoginFileExists, loginTarget } from "../../src/vm/provider-login"

for (const provider of ["claude", "codex", "opencode"] as const)
  test(`${provider} host credential files use bounded regular-file reads on every OS`, () => {
    const targetDir = resolve("src-tauri/target/provider-file-fixtures")
    mkdirSync(targetDir, { recursive: true })
    const root = mkdtempSync(join(targetDir, "fixture-"))
    const target = loginTarget(provider)
    const directory = join(root, target.directory)
    try {
      expect(hostLoginFileExists(root, provider)).toBe(false)
      mkdirSync(directory, { recursive: true })
      const path = join(directory, target.file)
      writeFileSync(path, '{"fixture":"inert-credential"}')
      expect(hostLoginFileExists(root, provider)).toBe(true)
      writeFileSync(path, "x".repeat(20001))
      expect(hostLoginFileExists(root, provider)).toBe(false)
      writeFileSync(path, "")
      expect(hostLoginFileExists(root, provider)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
