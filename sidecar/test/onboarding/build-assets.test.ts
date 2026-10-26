import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getEmbeddedUiSource } from "../../../scripts/embedded-ui"

const directories = new Set<string>()
afterEach(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true })
  directories.clear()
})

test("embeds the UI with portable relative imports and no build-machine paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "touri-onboarding-assets-"))
  directories.add(directory)
  const ui = join(directory, "ui")
  const imports = join(directory, "server")
  await mkdir(join(ui, "assets"), { recursive: true })
  await writeFile(join(ui, "index.html"), "<title>touri</title>")
  await writeFile(join(ui, "assets", "app.js"), "export const ready = true")

  const source = await getEmbeddedUiSource(ui, imports)

  expect(source).toContain('"./../ui/index.html"')
  expect(source).toContain('"assets/app.js"')
  expect(source).not.toContain(directory)
})
