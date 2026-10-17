import { expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { retryTransient } from "../../src/runtime/transient-retry"
import { resolveExecutable } from "../../src/runtime/utils"

const outcomes = (messages: Array<string | null>) => {
  const calls = { count: 0 }
  const run = async (): Promise<string | null> => messages[Math.min(calls.count++, messages.length - 1)] ?? null
  return { calls, run }
}

test("a locked database is retried with backoff until it clears", async () => {
  const { calls, run } = outcomes(["database is locked", "database is locked", null])
  const result = await retryTransient({
    run,
    failureOf: (value) => value,
    canRetry: () => true,
    signal: new AbortController().signal,
  })
  expect(result).toBeNull()
  expect(calls.count).toBe(3)
}, 10_000)

test("a persistent lock surfaces after the bounded retries", async () => {
  const { calls, run } = outcomes(["database is locked"])
  const result = await retryTransient({
    run,
    failureOf: (value) => value,
    canRetry: () => true,
    signal: new AbortController().signal,
  })
  expect(result).toBe("database is locked")
  expect(calls.count).toBe(4)
}, 15_000)

test("container service failures retry once; other errors and started turns never retry", async () => {
  const service = outcomes(["failed to list containers (XPC connection error: Connection invalid)"])
  await retryTransient({
    run: service.run,
    failureOf: (v) => v,
    canRetry: () => true,
    signal: new AbortController().signal,
  })
  expect(service.calls.count).toBe(2)
  const other = outcomes(["boom"])
  await retryTransient({
    run: other.run,
    failureOf: (v) => v,
    canRetry: () => true,
    signal: new AbortController().signal,
  })
  expect(other.calls.count).toBe(1)
  const started = outcomes(["database is locked"])
  await retryTransient({
    run: started.run,
    failureOf: (v) => v,
    canRetry: () => false,
    signal: new AbortController().signal,
  })
  expect(started.calls.count).toBe(1)
})

test("a stale absolute CLI path falls back to the same binary on PATH", () => {
  const root = mkdtempSync(join(tmpdir(), "touri-cli-"))
  try {
    mkdirSync(join(root, "bin"))
    writeFileSync(join(root, "bin/codex"), "#!/bin/sh\n")
    chmodSync(join(root, "bin/codex"), 0o700)
    expect(resolveExecutable({ command: "/opt/gone/bin/codex", env: { PATH: join(root, "bin") } })).toEqual({
      success: true,
      path: join(root, "bin/codex"),
    })
    expect(
      resolveExecutable({ command: "/opt/gone/bin/touri-missing-cli", env: { PATH: "/nonexistent" } }),
    ).toMatchObject({
      success: false,
      errorCode: "cli_missing",
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
