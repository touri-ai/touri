import { afterEach, expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
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

const compiledModes = [false, true]
compiledModes.forEach((compiled) => {
  test(`a ${compiled ? "bytecode" : "source"} checkpoint worker starts and stops without unrelated activity`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "touri-checkpoint-startup-")))
    cleanups.add(() => rm(root, { recursive: true, force: true }))
    const fixture = join(import.meta.dir, "checkpoint-startup.fixture.ts")
    const binary = join(root, process.platform === "win32" ? "fixture.exe" : "fixture")
    if (compiled) {
      const build = await run([
        process.execPath,
        "build",
        "--compile",
        "--bytecode",
        "--format=esm",
        fixture,
        "--outfile",
        binary,
      ])
      if (build.code !== 0) throw new Error(`Checkpoint fixture build failed: ${build.errors}`)
    }

    const result = await run(compiled ? [binary, root] : [process.execPath, fixture, root])

    expect(result).toEqual({ code: 0, output: "checkpoint worker started and stopped\n", errors: "" })
  }, 30_000)
})

const run = async (cmd: string[]) => {
  const child = Bun.spawn(cmd, {
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

  return { code, output, errors }
}
