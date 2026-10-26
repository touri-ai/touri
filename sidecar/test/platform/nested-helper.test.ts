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

test("a bytecode checkpoint callback persists its first native log write without unrelated input", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "touri-nested-helper-")))
  cleanups.add(() => rm(root, { recursive: true, force: true }))
  const binary = join(root, process.platform === "win32" ? "fixture.exe" : "fixture")
  const target = process.platform === "linux" && process.arch === "x64" ? ["--target=bun-linux-x64-baseline"] : []
  const build = await run(
    [process.execPath, "build", "--compile", "--bytecode", "--format=esm"].concat(target, [
      join(import.meta.dir, "nested-helper.fixture.ts"),
      join(import.meta.dir, "nested-helper.worker.ts"),
      "--outfile",
      binary,
    ]),
    root,
  )
  expect(build.code).toBe(0)

  const result = await run([binary, root], root)

  expect(result).toEqual({ code: 0, output: "first native log write persisted\n", errors: "" })
  expect(await Bun.file(join(root, "first.log")).text()).toBe("first native log write\n")
}, 60_000)

const run = async (cmd: string[], cwd: string) => {
  const child = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe", timeout: 15_000, killSignal: "SIGKILL" })
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
