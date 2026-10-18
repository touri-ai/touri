import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Kernel } from "@touri/contracts"
import { providerLoginChecks } from "../../src/doctor/providerLogin"

const cleanups = new Set<() => void>()

afterEach(() => {
  cleanups.forEach((close) => {
    close()
  })
  cleanups.clear()
})

test.each([
  ["darwin", false, "Mac"],
  ["linux", false, "computador"],
  ["linux", true, "servidor"],
  ["win32", false, "computador"],
] as const)("%s headless=%s login diagnostics identify the actual host", async (platform, headless, noun) => {
  const { kernel, home } = getFixture()

  const checks = await providerLoginChecks(kernel, home, new AbortController().signal, { platform, headless })

  expect(checks).toHaveLength(1)
  expect(checks[0]?.detail).toContain(`ausente neste ${noun}.`)
})

const getFixture = () => {
  const db = new Database(":memory:")
  const home = mkdtempSync(join(tmpdir(), "touri-hostlabel-doctor-"))
  db.exec(`
    CREATE TABLE bots (id TEXT, name TEXT, provider TEXT, machine TEXT, vm_provider_login INTEGER, archived_at INTEGER);
    CREATE TABLE settings (key TEXT, value_json TEXT);
    INSERT INTO bots VALUES ('fixture', 'Bot de teste', 'codex', 'vm', 1, NULL);
    INSERT INTO settings VALUES ('vm-login-source:fixture:codex', '"host-file"');
  `)
  cleanups.add(() => {
    db.close()
    rmSync(home, { recursive: true, force: true })
  })

  return { kernel: { db } as Kernel, home }
}
