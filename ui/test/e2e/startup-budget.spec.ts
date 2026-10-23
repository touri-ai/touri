import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { promisify } from "node:util"
import { gzip } from "node:zlib"
import { expect, test } from "@playwright/test"
import type { Manifest } from "vite"

const compress = promisify(gzip)
const output = resolve(import.meta.dirname, "../../dist")
const optionalModules = [
  "src/components/BotLibrary.tsx",
  "src/components/ConversationStart.tsx",
  "src/components/GroupModal.tsx",
  "src/components/GroupPanel.tsx",
  "src/components/RoutineEditor.tsx",
  "src/components/WorkspaceScreens.tsx",
]

test("keeps the production startup payload below 400 KB gzip with optional modules deferred", async () => {
  const manifest = JSON.parse(await readFile(resolve(output, ".vite/manifest.json"), "utf8")) as Manifest
  const initialFiles = Array.from(new Set(["index.html"].concat(getInitialFiles(manifest, "index.html"))))
  const sizes = await Promise.all(initialFiles.map((file) => getGzipBytes(resolve(output, file))))
  const initialGzipBytes = sizes.reduce((total, size) => total + size, 0)

  console.info(JSON.stringify({ initialGzipBytes, limitBytes: 400_000 }))
  expect(initialGzipBytes).toBeLessThanOrEqual(400_000)
  expect(manifest["index.html"]?.isEntry).toBe(true)
  optionalModules.forEach((key) => {
    const chunk = manifest[key]
    expect(chunk?.isDynamicEntry).toBe(true)
    expect(initialFiles).not.toContain(chunk?.file)
  })
  const welcomeStyles = Object.values(manifest)
    .flatMap((chunk) => chunk.css ?? [])
    .filter((file) => file.includes("/conversation-start-"))
  expect(welcomeStyles.length).toBeGreaterThan(0)
  welcomeStyles.forEach((file) => {
    expect(initialFiles).not.toContain(file)
  })
  const avatarStyles = Object.values(manifest)
    .flatMap((chunk) => chunk.css ?? [])
    .filter((file) => /\/(?:AvatarPicker|avatar-picker)-/.test(file))
  expect(avatarStyles.length).toBeGreaterThan(0)
  avatarStyles.forEach((file) => {
    expect(initialFiles).not.toContain(file)
  })
  const previewStyles = manifest["src/components/WorkspaceScreens.tsx"]?.css ?? []
  expect(previewStyles.length).toBeGreaterThan(0)
  previewStyles.forEach((file) => {
    expect(initialFiles).not.toContain(file)
  })
  const dialogStyles = manifest["src/components/GroupModal.tsx"]?.css ?? []
  expect(dialogStyles.length).toBeGreaterThan(0)
  dialogStyles.forEach((file) => {
    expect(initialFiles).not.toContain(file)
  })
})

const getInitialFiles = (manifest: Manifest, root: string): string[] => {
  // Local sets visit each chunk once, including shared dependencies and cycles.
  const seen = new Set<string>()
  const files = new Set<string>()
  const visit = (key: string): void => {
    if (seen.has(key)) return
    seen.add(key)
    const chunk = manifest[key]
    if (!chunk) throw new Error("Missing startup chunk")

    files.add(chunk.file)
    chunk.css?.forEach((file) => {
      files.add(file)
    })
    chunk.imports?.forEach(visit)
  }
  visit(root)

  return Array.from(files)
}

const getGzipBytes = async (file: string): Promise<number> => (await compress(await readFile(file))).length
