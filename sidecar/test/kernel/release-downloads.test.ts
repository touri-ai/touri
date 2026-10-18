import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import rootPackage from "../../../package.json"

const readme = readFileSync(join(import.meta.dir, "../../../README.md"), "utf8")
const releaseUrl = `https://github.com/touri-ai/touri/releases/download/v${rootPackage.version}`

test.each(["aarch64.dmg", "amd64.AppImage", "amd64.deb", "x64_en-US.msi", "x64-setup.exe"])(
  "the download table links the current release's %s installer",
  (suffix) => {
    const asset = `touri_${rootPackage.version}_${suffix}`
    const install = readme.match(/## Install \(GitHub Releases\)\n([\s\S]*?)(?=\n## )/)?.[1] ?? ""

    expect(install).toContain(`[${asset}](${releaseUrl}/${asset})`)
  },
)

test("Linux installation commands use the current release", () => {
  const linux = readme.match(/### Linux install\n([\s\S]*?)(?=\n###? )/)?.[1] ?? ""

  expect(linux).toContain(`chmod +x touri_${rootPackage.version}_amd64.AppImage`)
  expect(linux).toContain(`./touri_${rootPackage.version}_amd64.AppImage`)
  expect(linux).toContain(`sudo apt install ./touri_${rootPackage.version}_amd64.deb`)
})

test("installation explains the macOS pre-release and unsigned Windows warning", () => {
  const windows = readme.match(/### Windows install\n([\s\S]*?)(?=\n## )/)?.[1] ?? ""

  expect(readme).toContain("### macOS install (pre-release)")
  expect(windows).toContain("unsigned")
  expect(windows).toContain("SmartScreen")
  expect(windows).toContain("More info → Run anyway")
  expect(windows).toContain("Mais informações → Executar assim mesmo")
})

test("both macOS release builds request the disk image advertised for download", () => {
  const workflow = readFileSync(join(import.meta.dir, "../../../.github/workflows/release.yml"), "utf8")
  const builds = workflow.match(/run: bunx tauri build[^\n]+/g) ?? []

  expect(builds).toHaveLength(2)
  expect(builds.every((build) => build.includes("--target aarch64-apple-darwin --bundles app,dmg"))).toBe(true)
})
