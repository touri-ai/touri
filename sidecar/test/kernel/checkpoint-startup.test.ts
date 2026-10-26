import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
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

test("a standalone checkpoint worker starts and stops without unrelated event-loop activity", async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-checkpoint-startup-"))
  cleanups.add(() => rm(root, { recursive: true, force: true }))
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "checkpoint-startup.fixture.ts"), root], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
    killSignal: "SIGKILL",
  })
  cleanups.add(async () => {
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
  })

  const [code, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])

  expect({ code, output, errors }).toEqual({ code: 0, output: "checkpoint worker started and stopped\n", errors: "" })
}, 15_000)
