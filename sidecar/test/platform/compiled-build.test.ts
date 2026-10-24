import { expect, test } from "bun:test"
import { resolve } from "node:path"

test.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "the bytecode native sidecar completes its compiled worker and persisted-reply smoke",
  async () => {
    const root = resolve(import.meta.dir, "../../..")
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
        "--target=bun-linux-x64-baseline",
        ...entries.map((entry) => `sidecar/src/${entry}.ts`),
        "--outfile",
        "src-tauri/binaries/touri-sidecar-x86_64-unknown-linux-gnu",
      ],
      root,
    )
    const smoke = await run([process.execPath, "scripts/smoke-sidecar.ts"], root)

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
