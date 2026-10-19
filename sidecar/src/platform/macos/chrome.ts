import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { ensurePrivateDirectoryAsync, writePrivateFileAsync } from "../../kernel/async-files"
export type ChromeDownloadDeps = {
  fetchFn?: (input: string, init?: RequestInit) => Promise<Response>
  writeFile?: (path: string, data: Uint8Array) => Promise<void>
  mkdir?: (path: string) => void | Promise<void>
  remove?: (path: string) => void | Promise<void>
  extract?: (args: { zipPath: string; destination: string }) => Promise<boolean>
  verify?: (path: string) => Promise<boolean>
  version?: string
}

export const systemChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const pinnedVersion = "131.0.6778.108"
const manifestUrl = "https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json"

const record = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== "object" || value === null) return null
  return value as Record<string, unknown>
}

const stringValue = (value: unknown): string | null => (typeof value === "string" ? value : null)

const defaultExtract = async ({ zipPath, destination }: { zipPath: string; destination: string }): Promise<boolean> => {
  const result = Bun.spawn({
    cmd: ["/usr/bin/ditto", "-x", "-k", zipPath, destination],
    stdout: "ignore",
    stderr: "ignore",
  })
  return (await result.exited) === 0
}

const defaultVerify = async (path: string): Promise<boolean> => {
  const verification = Bun.spawn({
    cmd: ["/usr/bin/codesign", "--verify", "--deep", "--strict", path],
    stdout: "ignore",
    stderr: "ignore",
  })
  if ((await verification.exited) !== 0) return false
  const details = Bun.spawn({ cmd: ["/usr/bin/codesign", "-dv", "--verbose=4", path], stdout: "pipe", stderr: "pipe" })
  const output = `${await new Response(details.stdout).text()}\n${await new Response(details.stderr).text()}`
  return (await details.exited) === 0 && output.includes("TeamIdentifier=EQHXZ8M8AV")
}

const manifestDownload = (value: unknown, version: string): string | null => {
  const root = record(value)
  const versions = root?.versions
  if (!Array.isArray(versions)) return null
  const selected = versions.find((item) => {
    const candidate = record(item)
    return candidate?.version === version
  })
  const selectedRecord = record(selected)
  const downloads = record(selectedRecord?.downloads)
  const chrome = downloads?.chrome
  if (!Array.isArray(chrome)) return null
  const macArm = chrome.find((item) => {
    const candidate = record(item)
    return candidate?.platform === "mac-arm64"
  })
  return stringValue(record(macArm)?.url)
}

export const downloadChromeForTesting = async ({
  destination,
  root = destination,
  deps = {},
}: {
  destination: string
  root?: string
  deps?: ChromeDownloadDeps
}): Promise<{ success: true; path: string; version: string } | { success: false; error: string }> => {
  const fetchFn = deps.fetchFn ?? fetch
  const writeFile = deps.writeFile ?? ((path, data) => writePrivateFileAsync({ root, path, content: data }))
  const makeDirectory = deps.mkdir ?? ((path) => ensurePrivateDirectoryAsync({ root, path }))
  const remove = deps.remove ?? ((path) => rm(path, { recursive: true, force: true }))
  const extract = deps.extract ?? defaultExtract
  const verify = deps.verify ?? defaultVerify
  const version = deps.version ?? process.env.TOURI_CHROME_FOR_TESTING_VERSION ?? pinnedVersion
  const versionDirectory = join(destination, version)
  const executable = join(
    versionDirectory,
    "chrome-mac-arm64",
    "Google Chrome for Testing.app",
    "Contents",
    "MacOS",
    "Google Chrome for Testing",
  )
  try {
    if (existsSync(executable) && (await verify(executable))) return { success: true, path: executable, version }
    const response = await fetchFn(manifestUrl)
    if (!response.ok)
      return { success: false, error: `Chrome for Testing manifest request failed (${response.status})` }
    const url = manifestDownload(await response.json(), version)
    if (!url) return { success: false, error: `No pinned Chrome for Testing mac-arm64 download for ${version}` }
    const archiveResponse = await fetchFn(url)
    if (!archiveResponse.ok)
      return { success: false, error: `Chrome for Testing download failed (${archiveResponse.status})` }
    const archive = new Uint8Array(await archiveResponse.arrayBuffer())
    await makeDirectory(versionDirectory)
    const zipPath = join(versionDirectory, "chrome.zip")
    await writeFile(zipPath, archive)
    const extracted = await extract({ zipPath, destination: versionDirectory })
    await remove(zipPath)
    if (!extracted || !existsSync(executable))
      return { success: false, error: "Chrome for Testing archive extraction failed" }
    if (!(await verify(executable)))
      return { success: false, error: "Chrome for Testing signature verification failed" }
    return { success: true, path: executable, version }
  } catch {
    return { success: false, error: "Chrome for Testing download failed unexpectedly" }
  }
}
