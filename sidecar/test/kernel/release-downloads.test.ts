import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const readme = readFileSync(join(import.meta.dir, "../../../README.md"), "utf8")

test("Linux installation links a versioned Debian asset with its exact command and checksum", () => {
  const linux = readme.match(/### Linux install\n([\s\S]*?)(?=\n## )/)?.[1] ?? ""
  const download = linux.match(
    /\]\((https:\/\/github\.com\/touri-ai\/touri\/releases\/download\/v(\d+\.\d+\.\d+))\/(touri_[^)]+\.deb)\)/,
  )
  expect(download).not.toBeNull()
  const [, release, version, asset] = download ?? []
  expect(asset).toBe(`touri_${version}_amd64.deb`)
  expect(linux).toContain(`sudo apt install ./${asset}`)
  const checksum = linux.split(`SHA-256 for \`${asset}\`:`)[1]?.match(/```text\n([a-f0-9]{64})\n```/)?.[1]
  expect(checksum).toMatch(/^[a-f0-9]{64}$/)
  expect(linux).toContain(`](${release}/SHA256SUMS)`)
})

test("the Linux prerelease keeps an explicit macOS download", () => {
  const install = readme.match(/## Install \(GitHub Releases\)\n([\s\S]*?)(?=\n### Linux install)/)?.[1] ?? ""
  expect(install).toContain("](https://github.com/touri-ai/touri/releases/download/v0.1.0/touri_0.1.0_aarch64.dmg)")
  expect(install).toContain("macOS download remains v0.1.0")
})
