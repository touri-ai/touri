import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const registry = join(import.meta.dir, "..", "..", "src", "mcp", "shim-registry.ts")
const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

// Local bots run inside a Seatbelt profile; macOS never lets a sandboxed process exec the setuid /bin/ps.
test.skipIf(process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))(
  "registering a shim inside a sandbox that cannot run ps does not crash the shim",
  () => {
    const root = mkdtempSync(join(tmpdir(), "touri-shim-sandbox-"))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const script = join(root, "register.ts")
    writeFileSync(
      script,
      `import { registerShim } from ${JSON.stringify(registry)}\nconst unregister = registerShim({ runDir: ${JSON.stringify(root)}, thread: "thread" })\nunregister()\nprocess.stdout.write("registered-ok")\n`,
    )
    const profile = '(version 1)(allow default)(deny process-exec (literal "/bin/ps"))'
    const result = Bun.spawnSync({
      cmd: ["/usr/bin/sandbox-exec", "-p", profile, process.execPath, script],
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    })
    expect(result.stderr.toString()).not.toContain("EPERM")
    expect(result.stdout.toString()).toBe("registered-ok")
    expect(result.exitCode).toBe(0)
  },
)
