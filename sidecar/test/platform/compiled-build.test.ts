import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const directories = new Set<string>()
afterEach(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true })
  directories.clear()
})

test.skipIf(!["linux", "win32"].includes(process.platform) || process.arch !== "x64")(
  "the bytecode native sidecar completes its compiled worker and persisted-reply smoke",
  async () => {
    const root = resolve(import.meta.dir, "../../..")
    const windows = process.platform === "win32"
    const target = windows ? "bun-windows-x64" : "bun-linux-x64-baseline"
    const directory = await mkdtemp(join(tmpdir(), "touri-compiled-build-"))
    directories.add(directory)
    const binary = join(directory, windows ? "fixture-sidecar.exe" : "fixture-sidecar")
    const entries = [
      "main",
      "file-io-worker-entry",
      "auth-writer-worker-entry",
      "atomic-download-worker-entry",
      "workspace-attention-worker-entry",
    ]
    await run(
      [
        process.execPath,
        "build",
        "--compile",
        "--bytecode",
        "--format=esm",
        `--target=${target}`,
        ...entries.map((entry) => `sidecar/src/${entry}.ts`),
        "--outfile",
        binary,
      ],
      root,
    )
    const smoke = await run([process.execPath, "scripts/smoke-sidecar.ts", binary], root)

    expect(smoke).toContain("Compiled sidecar smoke passed")
  },
  180_000,
)

const run = async (cmd: string[], cwd: string): Promise<string> => {
  const child = Bun.spawn({
    cmd,
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 150_000,
    killSignal: "SIGKILL",
  })
  const [code, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(`Compiled build smoke failed (${code}): ${errors}`)

  return output
}
