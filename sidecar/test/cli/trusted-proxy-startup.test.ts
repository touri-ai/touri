import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const cleanups = new Set<() => Promise<unknown>>()
afterEach(async () => {
  await Array.from(cleanups).reduceRight(async (previous, cleanup) => {
    await previous
    await cleanup()
  }, Promise.resolve())
  cleanups.clear()
})

test("a short proxy secret fails before opening the authentication store or acquiring its runtime lease", async () => {
  const directory = await mkdtemp(join(tmpdir(), "touri-proxy-startup-"))
  cleanups.add(() => rm(directory, { recursive: true, force: true }))
  const secretFile = join(directory, "proxy-secret")
  await writeFile(secretFile, "too-short", { mode: 0o600 })
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      join(import.meta.dir, "../../src/cli/main.ts"),
      "serve",
      "--data-dir",
      directory,
      "--trust-proxy",
      "--trust-proxy-email",
      "X-Forwarded-Email",
      "--trust-proxy-secret-file",
      secretFile,
    ],
    stdout: "pipe",
    stderr: "pipe",
  })
  cleanups.add(async () => {
    child.kill()
    await child.exited
  })
  const output = new Response(child.stdout).text()
  const diagnostic = new Response(child.stderr).text()

  const [code, stdout, stderr] = await Promise.all([child.exited, output, diagnostic])
  const files = await readdir(directory)

  expect(code).toBe(1)
  expect(stdout).not.toContain("listening on")
  expect(stderr).toContain("--trust-proxy-secret-file must hold a secret of at least 32 characters")
  expect(files).not.toContain("auth.db")
  expect(files).not.toContain("run")
})
