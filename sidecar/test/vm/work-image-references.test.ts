import { afterEach, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot } from "@touri/contracts"
import { getWorkspaceImageAsync } from "../../src/kernel/async-files"
import { getWorkspaceImage } from "../../src/vm/evidence-local"

const root = join(tmpdir(), `touri-image-test-${randomUUID()}`)
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
afterEach(() => rmSync(root, { recursive: true, force: true }))

const makeWorkspace = () => {
  const workspace = join(root, "workspace")
  const evidence = join(root, "evidence")
  mkdirSync(workspace, { recursive: true })
  mkdirSync(evidence)
  const bot = {
    homeDir: workspace,
    cwd: workspace,
    folders: [{ path: evidence, access: "read-only" }],
    machine: "local",
    anyFolderAccess: true,
  } as Bot

  return { bot, workspace, evidence, appData: join(root, "private-state") }
}

test("expands only filename patterns in the workspace and explicit evidence grants, with six results", async () => {
  const input = makeWorkspace()
  Array.from({ length: 9 }, (_, index) => writeFileSync(join(input.evidence, `round-${index}.png`), png))
  writeFileSync(join(input.evidence, "round-fake.png"), "<html>not an image</html>")
  symlinkSync(join(input.evidence, "round-0.png"), join(input.evidence, "round-link.png"))

  const result = await getWorkspaceImageAsync({ ...input, path: join(input.evidence, "round-*.png"), pattern: true })

  expect("paths" in result && result.paths).toHaveLength(6)
  expect("paths" in result && result.paths.every((path) => /^round-\d\.png$/.test(path.split("/").at(-1) ?? ""))).toBe(
    true,
  )
})

test("admits simultaneous filename lookups without charging each one as a full image", async () => {
  const input = makeWorkspace()
  writeFileSync(join(input.workspace, "round-1.png"), png)

  const results = await Promise.allSettled(
    Array.from({ length: 6 }, () => getWorkspaceImageAsync({ ...input, path: "round-*.png", pattern: true })),
  )

  expect(results).toEqual(Array.from({ length: 6 }, () => ({ status: "fulfilled", value: { paths: ["round-1.png"] } })))
})

test("does not turn unrestricted bot access into automatic host-file previews", async () => {
  const input = makeWorkspace()
  writeFileSync(join(root, "private.png"), png)
  symlinkSync(root, join(input.workspace, "escape"))
  symlinkSync(join(root, "private.png"), join(input.workspace, "link.png"))
  const denied = [
    "../private.png",
    "%2e%2e/private.png",
    join(root, "private.png"),
    "escape/private.png",
    "link.png",
    "../*.png",
    "escape/*.png",
    "*/private.png",
  ]

  for (const path of denied) {
    const operation = () => getWorkspaceImage({ ...input, path, pattern: path.includes("*") })

    expect(operation).toThrow()
  }
  await expect(getWorkspaceImageAsync({ ...input, path: "escape/private.png" })).rejects.toThrow()
})

test("reads literal relative and absolute images asynchronously and refuses globs as file reads", async () => {
  const input = makeWorkspace()
  writeFileSync(join(input.workspace, "screen.png"), png)
  writeFileSync(join(input.workspace, "screen one.png"), png)

  for (const path of [
    "screen.png",
    join(input.workspace, "screen.png"),
    "screen one.png",
    join(input.workspace, "screen one.png"),
  ]) {
    const result = await getWorkspaceImageAsync({ ...input, path })

    expect("bytes" in result && Buffer.from(result.bytes)).toEqual(png)
    expect("mime" in result && result.mime).toBe("image/png")
  }
  expect(() => getWorkspaceImage({ ...input, path: "*.png" })).toThrow()
  expect(() => getWorkspaceImage({ ...input, path: "**/*.png", pattern: true })).toThrow()
})
