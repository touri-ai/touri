import { afterAll, afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  checkReleaseBinaries,
  configureReleasePaths,
  getReleaseNotes,
  prepareRelease,
} from "../../../scripts/release-artifacts.mjs"

const fixtures = await mkdtemp(join(tmpdir(), "touri-release-"))
const installers = [
  "macos/dmg/touri_1.2.3_aarch64.dmg",
  "linux/appimage/touri_1.2.3_amd64.AppImage",
  "linux/deb/touri_1.2.3_amd64.deb",
  "windows/msi/touri_1.2.3_x64_en-US.msi",
  "windows/nsis/touri_1.2.3_x64-setup.exe",
]

afterEach(async () => {
  await Promise.all((await readdir(fixtures)).map((name) => rm(join(fixtures, name), { recursive: true, force: true })))
})
afterAll(() => rm(fixtures, { recursive: true, force: true }))

test("only the tagged changelog section becomes release notes", () => {
  const changelog =
    "# Changelog\r\n\r\n## 1.2.4\r\nFuture\r\n## 1.2.3\r\n\r\n### Fixes\r\nTagged\r\n## 1.2.2\r\nOld\r\n"

  expect(getReleaseNotes(changelog, "v1.2.3")).toBe("### Fixes\nTagged\n")
})

test.each(["v1.2.3", "v1.2.30", "v1.2.3;echo injected", "v1.2.3\nextra"])(
  "missing, empty or unsafe version fails closed: %s",
  (tag) => {
    expect(() => getReleaseNotes("## 1.2.3\n\n## 1.2.4\nFuture\n", tag)).toThrow()
  },
)

test("a heading at EOF is not release notes", () => {
  expect(() => getReleaseNotes("## 1.2.3", "v1.2.3")).toThrow("Missing or empty")
})

test("flattens all five installers and hashes their actual bytes", async () => {
  const root = await makeReleaseFixture()

  await prepareRelease(root, "v1.2.3")

  const names = installers.map((path) => path.split("/").at(-1))
  const sums = await readFile(join(root, "release-assets/SHA256SUMS"), "utf8")
  expect((await readdir(join(root, "release-assets"))).toSorted()).toEqual([...names, "SHA256SUMS"].toSorted())
  await Promise.all(
    names.map(async (name) => {
      const bytes = await readFile(join(root, "release-assets", name))
      expect(sums).toContain(`${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`)
    }),
  )
  expect(await readFile(join(root, "release-notes.md"), "utf8")).toBe("Tagged changes\n")
})

test.each(installers)("cannot publish without %s", async (installer) => {
  const root = await makeReleaseFixture()
  await rm(join(root, "release-downloads", installer))

  await expect(prepareRelease(root, "v1.2.3")).rejects.toThrow("Missing or duplicate")
})

test("duplicate basenames in different directories cannot overwrite release assets", async () => {
  const root = await makeReleaseFixture()
  await writeFile(join(root, "release-downloads/linux/touri_1.2.3_amd64.deb"), "duplicate")

  await expect(prepareRelease(root, "v1.2.3")).rejects.toThrow("Missing or duplicate")
})

test("unexpected executable artifacts are rejected", async () => {
  const root = await makeReleaseFixture()
  await writeFile(join(root, "release-downloads/windows/unexpected.exe"), "untrusted")

  await expect(prepareRelease(root, "v1.2.3")).rejects.toThrow("Unexpected windows")
})

test.skipIf(process.platform === "win32")("artifact symlinks cannot escape the download directory", async () => {
  const root = await makeReleaseFixture()
  await symlink(join(root, "CHANGELOG.md"), join(root, "release-downloads/macos/escape"))

  await expect(prepareRelease(root, "v1.2.3")).rejects.toThrow("Non-regular artifact")
})

test.each(["utf8", "utf16le"])("detects a Windows home across a stream boundary (%s)", async (encoding) => {
  const root = await mkdtemp(join(fixtures, "binary-"))
  const path = join(root, "touri.exe")
  const home = "C:\\CI Runner"
  const prefix = Buffer.alloc(1024 * 1024 - 3, 1)
  await writeFile(path, Buffer.concat([prefix, Buffer.from(home.replaceAll("\\", "/"), encoding)]))

  await expect(checkReleaseBinaries([path], { USERPROFILE: home })).rejects.toThrow(
    "Runner home path found in touri.exe",
  )
})

test("checks every binary, including the compiled sidecar", async () => {
  const root = await mkdtemp(join(fixtures, "binary-"))
  const shell = join(root, "touri")
  const sidecar = join(root, "touri-sidecar")
  await writeFile(shell, "clean binary")
  await writeFile(sidecar, "compiled in /opt/ci/runner/workspace")

  await expect(checkReleaseBinaries([shell], { HOME: "/opt/ci/runner" })).resolves.toBeUndefined()
  await expect(checkReleaseBinaries([shell, sidecar], { HOME: "/opt/ci/runner" })).rejects.toThrow(
    "Runner home path found in touri-sidecar",
  )
})

test("missing binaries and unknown runner homes cannot pass the privacy gate", async () => {
  await expect(checkReleaseBinaries([join(fixtures, "missing")], { HOME: "/opt/ci/runner" })).rejects.toThrow()
  await expect(checkReleaseBinaries([], {})).rejects.toThrow("Missing runner home")
})

test("remaps native and slash-normalized Windows paths without splitting spaces", async () => {
  const root = await mkdtemp(join(fixtures, "env-"))
  const environment = join(root, "github-env")

  await configureReleasePaths({
    USERPROFILE: "C:\\CI Runner",
    GITHUB_WORKSPACE: "D:\\CI Workspace\\touri",
    GITHUB_ENV: environment,
  })

  const settings = await readFile(environment, "utf8")
  expect(settings).toContain("RUSTFLAGS=--remap-path-prefix=")
  expect(settings).toContain("CARGO_ENCODED_RUSTFLAGS=--remap-path-prefix=C:\\CI Runner=/runner-home\x1f")
  expect(settings).toContain("--remap-path-prefix=C:/CI Runner=/runner-home")
  expect(settings).toContain("--remap-path-prefix=D:/CI Workspace/touri=/workspace")
})

async function makeReleaseFixture() {
  const root = await mkdtemp(join(fixtures, "release-"))
  await writeFile(join(root, "CHANGELOG.md"), "## 1.2.3\n\nTagged changes\n\n## 1.2.2\n\nOld\n")
  await Promise.all(
    installers.map(async (installer) => {
      const path = join(root, "release-downloads", installer)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, `synthetic installer: ${installer}`)
    }),
  )
  return root
}
