import { afterAll, afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { publishRelease } from "../../../scripts/publish-release.mjs"

const fixtures = await mkdtemp(join(tmpdir(), "touri-publish-test-"))
const names = ["touri_1.2.3_aarch64.dmg", "touri_1.2.3_amd64.deb"]
const promoted = { title: "Promoted release", body: "Reviewed notes", prerelease: false, latest: true }

afterEach(async () => {
  await Promise.all((await readdir(fixtures)).map((name) => rm(join(fixtures, name), { recursive: true, force: true })))
})
afterAll(() => rm(fixtures, { recursive: true, force: true }))

test("creates metadata only for a new release and uploads SHA256SUMS last", async () => {
  const root = await makePreparedRelease()
  const github = makeGitHub()

  await publishRelease(root, "v1.2.3", github)

  expect(github.getRelease().metadata).toEqual({
    title: "v1.2.3",
    body: "Tagged changes\n",
    prerelease: true,
    latest: false,
  })
  expect(github.calls.find((args) => args[1] === "create")).toContain("--verify-tag")
  expect(github.calls.filter((args) => args[1] === "upload").map((args) => basename(args[3]))).toEqual([
    ...names,
    "SHA256SUMS",
  ])
  expectPublishedChecksums(github)
})

test("rerunning a complete promoted release preserves every byte and all metadata, logging each skip", async () => {
  const root = await makePreparedRelease()
  const github = makeGitHub({ metadata: promoted, assets: getPublishedAssets() })
  const before = github.getRelease()

  await publishRelease(root, "v1.2.3", github)

  expect(github.getRelease()).toEqual(before)
  expect(github.calls).toHaveLength(1)
  expect(github.logs).toEqual([...names, "SHA256SUMS"].map((name) => `Skipping existing release asset: ${name}`))
})

test("a partial release keeps existing bytes and hashes them when SHA256SUMS is missing", async () => {
  const root = await makePreparedRelease()
  const original = Buffer.from("original nonreproducible installer")
  const github = makeGitHub({ metadata: promoted, assets: { [names[0]]: original } })

  await publishRelease(root, "v1.2.3", github)

  expect(github.getRelease().metadata).toEqual(promoted)
  expect(github.getRelease().assets[names[0]]).toEqual(original)
  expect(github.calls.filter((args) => args[1] === "upload").map((args) => basename(args[3]))).toEqual([
    names[1],
    "SHA256SUMS",
  ])
  expectPublishedChecksums(github)
})

test("upload failure leaves published assets intact and no premature manifest; a rebuild resumes safely", async () => {
  const root = await makePreparedRelease()
  const github = makeGitHub({ failUploadOnce: names[1] })

  await expect(publishRelease(root, "v1.2.3", github)).rejects.toThrow("Upload failed")

  const firstUpload = github.getRelease().assets[names[0]]
  expect(Object.keys(github.getRelease().assets)).toEqual([names[0]])
  await writeFile(join(root, "release-assets", names[0]), "rebuilt bytes differ")

  await publishRelease(root, "v1.2.3", github)

  expect(github.getRelease().assets[names[0]]).toEqual(firstUpload)
  expect(github.calls.filter((args) => args[1] === "create")).toHaveLength(1)
  expectPublishedChecksums(github)
})

test("an existing manifest permits only missing assets with matching bytes", async () => {
  const root = await makePreparedRelease()
  const assets = getPublishedAssets()
  const github = makeGitHub({ metadata: promoted, assets: { SHA256SUMS: assets.SHA256SUMS } })
  await Promise.all(names.map((name) => writeFile(join(root, "release-assets", name), assets[name])))

  await publishRelease(root, "v1.2.3", github)

  expect(github.getRelease().assets).toEqual(assets)
  expect(github.getRelease().metadata).toEqual(promoted)
  expect(github.calls.filter((args) => args[1] === "upload")).toHaveLength(names.length)
  expect(github.logs).toContain("Skipping existing release asset: SHA256SUMS")
})

test("a rebuild conflicting with published SHA256SUMS fails before any upload", async () => {
  const root = await makePreparedRelease()
  const github = makeGitHub({ metadata: promoted, assets: { SHA256SUMS: getPublishedAssets().SHA256SUMS } })
  const before = github.getRelease()

  await expect(publishRelease(root, "v1.2.3", github)).rejects.toThrow("use the original build artifacts")

  expect(github.getRelease()).toEqual(before)
  expect(github.calls.some((args) => args[1] === "upload")).toBe(false)
})

test.each(["gh: Bad credentials (HTTP 401)", "gh: Server error (HTTP 500)", "network timeout"])(
  "release lookup errors fail without creating or modifying a release: %s",
  async (stderr) => {
    const root = await makePreparedRelease()
    const github = makeGitHub({ lookupError: stderr })

    await expect(publishRelease(root, "v1.2.3", github)).rejects.toThrow(stderr)

    expect(github.calls).toHaveLength(1)
    expect(github.getRelease().metadata).toBeUndefined()
  },
)

test("unsafe or suffixed tags fail before calling GitHub", async () => {
  const root = await makePreparedRelease()
  const github = makeGitHub()

  await expect(publishRelease(root, "v1.2.3-rc.1", github)).rejects.toThrow("numeric vX.Y.Z")

  expect(github.calls).toEqual([])
})

async function makePreparedRelease() {
  const root = await mkdtemp(join(fixtures, "release-"))
  await mkdir(join(root, "release-assets"))
  await Promise.all(names.map((name) => writeFile(join(root, "release-assets", name), `new build: ${name}`)))
  await writeFile(join(root, "release-assets/SHA256SUMS"), "recomputed before upload\n")
  await writeFile(join(root, "release-notes.md"), "Tagged changes\n")
  return root
}

function getPublishedAssets() {
  const assets = Object.fromEntries(names.map((name) => [name, Buffer.from(`original build: ${name}`)]))
  const sums = names.map((name) => `${createHash("sha256").update(assets[name]).digest("hex")}  ${name}\n`).join("")
  return { ...assets, SHA256SUMS: Buffer.from(sums) }
}

function expectPublishedChecksums(github) {
  const assets = github.getRelease().assets
  const manifest = assets.SHA256SUMS.toString()
  for (const name of names) {
    expect(manifest).toContain(`${createHash("sha256").update(assets[name]).digest("hex")}  ${name}\n`)
  }
}

function makeGitHub(options = {}) {
  // State is local to this fake GitHub boundary; no globals or live releases are changed.
  let metadata = options.metadata
  let failedUpload = false
  const assets = new Map(Object.entries(options.assets ?? {}))
  const calls = []
  const logs = []
  const getValue = (args, flag) => args[args.indexOf(flag) + 1]
  const gh = async (args) => {
    calls.push([...args])
    if (args.includes("--clobber") || args[1] === "edit") throw new Error("Destructive release mutation")
    if (args[0] === "api") {
      const stderr = options.lookupError ?? (!metadata ? "gh: Not Found (HTTP 404)" : undefined)
      if (stderr) throw Object.assign(new Error(stderr), { stderr })
      return JSON.stringify({ assets: [...assets.keys()].map((name) => ({ name })) })
    }
    if (args[1] === "create") {
      if (metadata) throw new Error("Release already exists")
      metadata = {
        title: getValue(args, "--title"),
        body: await readFile(getValue(args, "--notes-file"), "utf8"),
        prerelease: args.includes("--prerelease"),
        latest: !args.includes("--latest=false"),
      }
      return ""
    }
    if (args[1] === "download") {
      const name = getValue(args, "--pattern")
      if (!assets.has(name)) throw new Error("Missing remote asset")
      await writeFile(join(getValue(args, "--dir"), name), assets.get(name))
      return ""
    }
    if (args[1] !== "upload") throw new Error("Unexpected GitHub command")
    const name = basename(args[3])
    if (assets.has(name)) throw new Error("Asset already exists")
    if (name === options.failUploadOnce && !failedUpload) {
      failedUpload = true
      throw new Error("Upload failed")
    }
    assets.set(name, await readFile(args[3]))
    return ""
  }
  return {
    gh,
    log: (message) => logs.push(message),
    calls,
    logs,
    getRelease: () => ({ metadata, assets: Object.fromEntries(assets) }),
  }
}
