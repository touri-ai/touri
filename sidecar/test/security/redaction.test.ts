import { expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createKernel } from "../../src/kernel"
import { flushFileIoAsync } from "../../src/kernel/async-files"

const rootPath = (): string => mkdtempSync(join(tmpdir(), "touri-security-redaction-"))

test("redaction masks required token shapes in logger output while preserving ordinary URLs", async () => {
  const root = rootPath()
  const runtime = createKernel({ appData: root })
  const values = [
    "sk-proj-1234567890ab",
    "ghp_1234567890abcdef",
    "AKIA1234567890ABCDEF",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature-value",
    "https://alice:secret@example.com/private",
  ]
  try {
    for (const value of values) expect(runtime.kernel.redact(`prefix ${value} suffix`)).not.toContain(value)
    expect(runtime.kernel.redact("https://example.com/public")).toContain("https://example.com/public")
    runtime.kernel.log({
      level: "info",
      module: "security-test",
      msg: values.join(" "),
      data: { nested: values },
    })
    await flushFileIoAsync()
    const log = readFileSync(join(root, "logs", "sidecar.log"), "utf8")
    for (const value of values) expect(log).not.toContain(value)
  } finally {
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test("sidecar application logs rotate at 10 MB and retain five generations", async () => {
  const root = rootPath()
  const runtime = createKernel({ appData: root })
  try {
    const payload = "x".repeat(2 * 1024 * 1024)
    for (let index = 0; index < 31; index += 1)
      runtime.kernel.log({ level: "info", module: "rotation-test", msg: `${index}:${payload}` })
    await flushFileIoAsync()
    const files = readdirSync(join(root, "logs"))
      .filter((name) => name === "sidecar.log" || /^sidecar\.log\.\d+$/.test(name))
      .sort()
    expect(files).toContain("sidecar.log")
    expect(files).not.toContain("sidecar.log.6")
    expect(files.length).toBeLessThanOrEqual(6)
    for (const file of files) {
      const path = join(root, "logs", file)
      expect(statSync(path).size).toBeLessThanOrEqual(10 * 1024 * 1024)
      expect(statSync(path).mode & 0o777).toBe(0o600)
    }
  } finally {
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test("existing security directories are corrected to mode 0700", () => {
  const root = rootPath()
  const directories = [
    root,
    ...["bots", "attachments", "projects", "browser", "sessions", "imports", "logs"].map((name) => join(root, name)),
    join(root, "run"),
  ]
  for (const directory of directories) {
    mkdirSync(directory, { recursive: true })
    chmodSync(directory, 0o755)
  }
  const runtime = createKernel({ appData: root })
  try {
    for (const directory of [...directories, join(root, "run", "mcp-tokens")])
      expect(statSync(directory).mode & 0o777).toBe(0o700)
  } finally {
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
})
