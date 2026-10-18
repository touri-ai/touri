import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { appendFile, copyFile, mkdir, opendir, readFile, writeFile } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

export async function configureReleasePaths(env) {
  const homes = getRunnerHomes(env)
  if (!env.GITHUB_WORKSPACE || !env.GITHUB_ENV) throw new Error("Missing runner environment")

  const flags = [
    ...homes.map((home) => `--remap-path-prefix=${home}=/runner-home`),
    ...getPathVariants(env.GITHUB_WORKSPACE).map((workspace) => `--remap-path-prefix=${workspace}=/workspace`),
  ]
  // Cargo's encoded form preserves Windows paths containing spaces as single arguments.
  const settings = `RUSTFLAGS=${flags.join(" ")}\nCARGO_ENCODED_RUSTFLAGS=${flags.join("\x1f")}\n`
  await appendFile(env.GITHUB_ENV, settings)
}

export async function checkReleaseBinaries(paths, env) {
  const needles = getRunnerHomes(env).flatMap((home) => [Buffer.from(home), Buffer.from(home, "utf16le")])
  if (!paths.length) throw new Error("No release binaries provided")

  const overlap = Math.max(...needles.map((needle) => needle.length)) - 1
  for (const path of paths) {
    // Keep only one chunk and an overlap so paths split across reads are detected.
    let tail = Buffer.alloc(0)
    for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
      const bytes = Buffer.concat([tail, chunk])
      if (needles.some((needle) => bytes.includes(needle))) {
        throw new Error(`Runner home path found in ${basename(path)}`)
      }
      tail = bytes.subarray(-overlap)
    }
  }
}

export async function prepareRelease(root, tag) {
  const version = getReleaseVersion(tag)
  const notes = getReleaseNotes(await readFile(join(root, "CHANGELOG.md"), "utf8"), tag)
  const assets = await getReleaseAssets(join(root, "release-downloads"), version)
  const output = join(root, "release-assets")
  await mkdir(output) // Refuse stale output from an earlier preparation.

  const sums = await Promise.all(
    assets.map(async (asset) => {
      const destination = join(output, basename(asset))
      await copyFile(asset, destination)
      const hash = createHash("sha256")
      for await (const chunk of createReadStream(destination)) hash.update(chunk)
      return `${hash.digest("hex")}  ${basename(asset)}\n`
    }),
  )
  await writeFile(join(output, "SHA256SUMS"), sums.join(""))
  await writeFile(join(root, "release-notes.md"), notes)
}

export function getReleaseNotes(changelog, tag) {
  const version = getReleaseVersion(tag)
  const sections = changelog.replaceAll("\r\n", "\n").split(/^## /m)
  const section = sections.find((candidate) => candidate.split("\n", 1)[0]?.trim() === version)
  const [, ...body] = section?.split("\n") ?? []
  const notes = body.join("\n").trim()
  if (!notes) throw new Error("Missing or empty changelog section for release tag")

  return `${notes}\n`
}

export function getReleaseVersion(tag) {
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag ?? "") || tag !== tag.trim()) {
    throw new Error("Release tag must be numeric vX.Y.Z (no suffix or build metadata)")
  }
  return tag.slice(1)
}

async function getReleaseAssets(downloads, version) {
  const expected = {
    macos: [`touri_${version}_aarch64.dmg`],
    linux: [`touri_${version}_amd64.AppImage`, `touri_${version}_amd64.deb`],
    windows: [`touri_${version}_x64_en-US.msi`, `touri_${version}_x64-setup.exe`],
  }
  const groups = await Promise.all(
    Object.entries(expected).map(async ([platform, names]) => {
      const files = await getArtifactFiles(join(downloads, platform))
      const optional = platform === "macos" ? ["touri.app.tar.gz", "touri.app.tar.gz.sig", "latest.json"] : []
      if (files.some((file) => ![...names, ...optional].includes(basename(file)))) {
        throw new Error(`Unexpected ${platform} release asset`)
      }
      if (names.some((name) => files.filter((file) => basename(file) === name).length !== 1)) {
        throw new Error(`Missing or duplicate ${platform} installer`)
      }
      if (new Set(files.map((file) => basename(file))).size !== files.length) {
        throw new Error(`Duplicate ${platform} release asset`)
      }
      return files
    }),
  )
  return groups.flat().toSorted((left, right) => basename(left).localeCompare(basename(right), "en"))
}

async function getArtifactFiles(directory, depth = 0) {
  if (depth > 8) throw new Error("Artifact nesting limit exceeded")

  // Artifact layouts are small; cap entries and depth even in this one-shot CI helper.
  const entries = []
  for await (const entry of await opendir(directory)) {
    if (entries.length >= 100) throw new Error("Artifact entry limit exceeded")
    if (!entry.isDirectory() && !entry.isFile()) throw new Error("Non-regular artifact entry")
    const path = join(directory, entry.name)
    entries.push(entry.isDirectory() ? await getArtifactFiles(path, depth + 1) : [path])
    if (entries.flat().length > 100) throw new Error("Artifact file limit exceeded")
  }
  return entries.flat()
}

function getRunnerHomes(env) {
  const homes = [env.HOME, env.USERPROFILE].filter(Boolean).flatMap(getPathVariants)
  if (!homes.length) throw new Error("Missing runner home environment")

  return [...new Set(homes)]
}

function getPathVariants(path) {
  return [...new Set([path, path.replaceAll("\\", "/")])]
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, ...paths] = process.argv.slice(2)
  if (command === "configure") await configureReleasePaths(process.env)
  else if (command === "check") await checkReleaseBinaries(paths, process.env)
  else if (command === "prepare") await prepareRelease(process.cwd(), process.env.RELEASE_TAG)
  else if (command === "validate") getReleaseVersion(process.env.RELEASE_TAG)
  else throw new Error("Expected configure, check, prepare or validate")
}
