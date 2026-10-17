import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { codexSessionsCheck } from "../../src/doctor/codex-sessions"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test("Doctor reports large host Codex history as information and explains bot isolation", async () => {
  const host = mkdtempSync(join(tmpdir(), "touri-codex-doctor-"))
  roots.push(host)
  const sessions = join(host, ".codex/sessions/2026/01")
  mkdirSync(sessions, { recursive: true })
  const rollout = join(sessions, "turn.jsonl")
  writeFileSync(rollout, "synthetic history")
  truncateSync(rollout, 128 * 1024 ** 2)
  writeFileSync(join(sessions, "second.jsonl"), "")
  symlinkSync(host, join(sessions, "loop"))
  const history = await codexSessionsCheck(host)
  expect(history).toMatchObject({ id: "codex-sessions", ok: true, status: "pass", fix: null })
  expect(history.detail).toContain("128.0 MiB")
  expect(history.detail).toContain("2 arquivos")
  expect(history.detail).toContain("grande")
  expect(history.detail).toContain("CODEX_HOME isolado por bot")
  expect(history.detail).not.toContain(host)
  expect(history.detail).not.toContain("turn.jsonl")
  rmSync(join(host, ".codex/sessions"), { recursive: true })
  expect((await codexSessionsCheck(host)).detail).toContain("0 arquivos")
})

test("Doctor honors cancellation while measuring session metadata", async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(codexSessionsCheck(tmpdir(), controller.signal)).rejects.toThrow()
})
