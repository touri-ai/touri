import { readdirSync, readFileSync, statSync } from "node:fs"
import { basename, join } from "node:path"
import { expect, it } from "vitest"

const ALLOWED = new Set(["browserSave.ts"])
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })

it("no UI source triggers a webview download (anchor download attribute or blob/data navigation)", () => {
  const offenders = walk(join(__dirname, "..", "src"))
    .filter((path) => /\.(ts|tsx)$/.test(path) && !ALLOWED.has(basename(path)))
    .filter((path) => /\bdownload=|\.download\s*=|setAttribute\(\s*["']download["']/.test(readFileSync(path, "utf8")))
  expect(offenders).toEqual([])
})

it("browser-only fallback is not reachable from the desktop shell", () => {
  const source = readFileSync(join(__dirname, "..", "src", "saveFile.ts"), "utf8")
  expect(source).toContain('"__TAURI_INTERNALS__" in window')
  expect(source.indexOf("hasNativeShell()")).toBeLessThan(source.indexOf("browserSave(input)"))
})
