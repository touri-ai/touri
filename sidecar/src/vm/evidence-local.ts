import { closeSync, fstatSync, opendirSync, readSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { Bot } from "@touri/contracts"
import { openWorkspaceDirectory, openWorkspaceEntry, rasterMime, readBoundedFile } from "../kernel/files"
import { getImagePattern } from "./evidence-pattern"
import { getWorkspacePath, WorkspacePathError } from "./workspace-path"

export type WorkspaceImageInput = {
  appData: string
  bot: Bot
  projectPath?: string | undefined
  path: string
  base?: string | undefined
  pattern?: boolean
}
export type WorkspaceImageResult = { paths: string[] } | { bytes: Uint8Array; mime: string }
const MAX_BYTES = 15 * 1024 * 1024

/** Runs in the file worker: automatic previews never inherit unrestricted host access. */
export const getWorkspaceImage = (input: WorkspaceImageInput): WorkspaceImageResult => {
  const bot = { ...input.bot, anyFolderAccess: false }
  const path = input.pattern ? dirname(input.path) : input.path
  const location = getWorkspacePath(input.appData, bot, path, input.base, input.projectPath)
  if (input.pattern) return { paths: getPatternImages(location.root, location.path, input.path) }
  if (/[?*[\]{}]/.test(input.path)) throw new WorkspacePathError(400)

  return getLocalImageBytes("/", join(location.root, location.path).slice(1))
}

export const getLocalImageBytes = (root: string, path: string): { bytes: Uint8Array; mime: string } => {
  const bytes = readBoundedFile({ root, path: resolve(root, path), maxBytes: MAX_BYTES })
  const mime = rasterMime(bytes.subarray(0, 12))
  if (!mime) throw new Error("Invalid raster image")

  return { bytes, mime }
}

const getPatternImages = (root: string, directory: string, pattern: string): string[] => {
  const { prefix, suffix } = getImagePattern(pattern)
  const fd = openWorkspaceDirectory({ root: "/", path: join(root, directory).slice(1) })
  // Directory iteration stays pinned while checking each result with the same no-follow reader.
  try {
    return getDirectoryMatches(fd, pattern, prefix, suffix)
  } finally {
    closeSync(fd)
  }
}

const getDirectoryMatches = (fd: number, pattern: string, prefix: string, suffix: string): string[] => {
  const handle = opendirSync(`${process.platform === "linux" ? "/proc/self/fd" : "/dev/fd"}/${fd}`)
  try {
    const matches: string[] = []
    for (let count = 0; count < 512 && matches.length < 6; count += 1) {
      const entry = handle.readSync()
      if (!entry) break
      const name = entry.name.toLowerCase()
      if (
        !entry.isFile() ||
        name.length < prefix.length + suffix.length ||
        !name.startsWith(prefix) ||
        !name.endsWith(suffix)
      )
        continue
      try {
        if (!isRasterEntry(fd, entry.name)) continue
        // Local accumulation is bounded to six validated results inside this worker operation.
        matches.push(join(dirname(pattern), entry.name))
      } catch {}
    }
    return matches
  } finally {
    handle.closeSync()
  }
}

const isRasterEntry = (directory: number, name: string): boolean => {
  const fd = openWorkspaceEntry(directory, name)
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.size > MAX_BYTES) return false
    const header = Buffer.alloc(12)

    return rasterMime(header.subarray(0, readSync(fd, header, 0, 12, 0))) !== null
  } finally {
    closeSync(fd)
  }
}
