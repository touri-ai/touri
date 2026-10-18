import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { mkdtemp, opendir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { getReleaseVersion } from "./release-artifacts.mjs"

export async function publishRelease(root, tag, { gh = runGitHub, log = console.log } = {}) {
  getReleaseVersion(tag)
  const assets = join(root, "release-assets")
  const names = await getPreparedAssetNames(assets)
  const published = await getPublishedAssetNames(tag, gh)
  if (!published) {
    // Create metadata once; upload checksums only after every installer succeeds.
    await gh([
      "release",
      "create",
      tag,
      "--verify-tag",
      "--prerelease",
      "--latest=false",
      "--title",
      tag,
      "--notes-file",
      join(root, "release-notes.md"),
    ])
  }

  const existing = new Set(published ?? [])
  for (const name of [...names, "SHA256SUMS"].filter((name) => existing.has(name))) {
    log(`Skipping existing release asset: ${name}`)
  }
  const missing = names.filter((name) => !existing.has(name))
  if (!missing.length && existing.has("SHA256SUMS")) return

  const temporary = await mkdtemp(join(tmpdir(), "touri-publish-"))
  try {
    await reconcileChecksums({ assets, tag, names, missing, existing, temporary, gh })
    for (const name of missing) await gh(["release", "upload", tag, join(assets, name)])
    if (!existing.has("SHA256SUMS")) await gh(["release", "upload", tag, join(assets, "SHA256SUMS")])
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function getPublishedAssetNames(tag, gh) {
  try {
    const release = JSON.parse(await gh(["api", `repos/{owner}/{repo}/releases/tags/${tag}`]))
    return release.assets.map((asset) => asset.name)
  } catch (error) {
    // Auth, network and server failures must not be mistaken for an absent release.
    if (error.stderr?.includes("(HTTP 404)")) return undefined
    throw error
  }
}

async function getPreparedAssetNames(directory) {
  const names = []
  for await (const entry of await opendir(directory)) {
    if (!entry.isFile() || names.length >= 10) throw new Error("Invalid prepared release assets")
    names.push(entry.name)
  }
  if (!names.includes("SHA256SUMS") || names.length < 2) throw new Error("Missing prepared release assets")

  return names.filter((name) => name !== "SHA256SUMS").toSorted()
}

async function reconcileChecksums({ assets, tag, names, missing, existing, temporary, gh }) {
  if (existing.has("SHA256SUMS")) {
    await gh(["release", "download", tag, "--pattern", "SHA256SUMS", "--dir", temporary])
    const manifest = await readFile(join(temporary, "SHA256SUMS"), "utf8")
    // A missing installer must match the immutable published manifest, even after a rebuild.
    for (const name of missing) {
      const checksum = await getChecksum(join(assets, name))
      if (!manifest.split("\n").includes(`${checksum}  ${name}`)) {
        throw new Error(`Published SHA256SUMS does not match missing asset: ${name}; use the original build artifacts`)
      }
    }
    return
  }

  // Hash preserved remote bytes, never the replacement produced by a nonreproducible rebuild.
  const sums = []
  for (const name of names) {
    if (existing.has(name)) await gh(["release", "download", tag, "--pattern", name, "--dir", temporary])
    const path = join(existing.has(name) ? temporary : assets, name)
    sums.push(`${await getChecksum(path)}  ${name}\n`)
  }
  await writeFile(join(assets, "SHA256SUMS"), sums.join(""))
}

async function getChecksum(path) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}

async function runGitHub(args) {
  const { stdout } = await promisify(execFile)("gh", args, {
    timeout: 5 * 60 * 1000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  })
  return stdout
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await publishRelease(process.cwd(), process.env.RELEASE_TAG)
}
