import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { removePrivateTree } from "../../src/kernel/files"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

for (const entry of ["../../src/store/bot-home.ts", "../../src/main.ts", "../../src/cli/main.ts"]) {
  test(`the ${entry.includes("cli/") ? "server CLI" : "desktop sidecar"} entry can write the bounded private bot home`, async () => {
    const root = await mkdtemp(join(tmpdir(), "touri-home-entry-"))
    roots.push(root)
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL(entry, import.meta.url)), "write-bot-home"], {
      env: { ...process.env, TOURI_APP_DATA: root },
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    })
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000)
    child.stdin.write(
      JSON.stringify({ operation: "write", botId: "fixture-bot", instructions: "Useful synthetic instructions." }),
    )
    await child.stdin.end()

    const code = await child.exited
    clearTimeout(timer)

    expect(code).toBe(0)
    expect(await readFile(join(root, "bots", "fixture-bot", "SOUL.md"), "utf8")).toBe("Useful synthetic instructions.")
  })
}

test("private bot home cleanup unlinks symlinks without deleting their targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-home-cleanup-"))
  roots.push(root)
  const home = join(root, "bots", "fixture-bot")
  const outside = join(root, "outside.txt")
  await mkdir(home, { recursive: true })
  await writeFile(join(home, "SOUL.md"), "Synthetic instructions.")
  await writeFile(outside, "Keep this file.")
  await symlink(outside, join(home, "external-link"))

  removePrivateTree({ root, path: home })

  expect(await readFile(outside, "utf8")).toBe("Keep this file.")
  await expect(readdir(home)).rejects.toThrow()
})
