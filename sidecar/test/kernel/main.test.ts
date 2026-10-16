import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const readFirstLine = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = stream.getReader()
  let output = ""
  while (!output.includes("\n")) {
    const chunk = await reader.read()
    if (chunk.done) break
    output += new TextDecoder().decode(chunk.value)
  }
  reader.releaseLock()
  return output.slice(0, output.indexOf("\n"))
}

test("serve mode prints a handshake and skips missing work-package modules", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-serve-"))
  mkdirSync(root, { recursive: true })
  const child = Bun.spawn({
    cmd: ["bun", "run", "sidecar/src/main.ts", "serve"],
    cwd: join(import.meta.dir, "..", "..", ".."),
    env: { ...process.env, TOURI_APP_DATA: root, TOURI_UI_TOKEN: "serve-token", TOURI_HEADLESS: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    const line = await readFirstLine(child.stdout)
    const handshake = JSON.parse(line) as { type: string; port: number; version: string; schemaVersion: number }
    expect(handshake).toMatchObject({ type: "touri-sidecar-ready", version: "0.1.0", schemaVersion: 17 })
    expect(handshake.port).toBeGreaterThan(0)
    child.kill()
    await child.exited
    const log = await Bun.file(join(root, "logs", "sidecar.log")).text()
    const order = ["store", "mcp", "projects", "browser", "computer", "runtime", "importer"].map((name) =>
      log.search(new RegExp(`(skipping missing module|initialized module|module init failed) \\./${name}/index\\.ts`)),
    )
    expect(order.every((position) => position >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(log).not.toContain("module init failed")
  } finally {
    child.kill()
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
