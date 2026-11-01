import { closeSync, fstatSync, readSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { Bot } from "@touri/contracts"
import {
  getWorkspaceEntryNames,
  openWorkspaceDirectory,
  openWorkspaceEntry,
  rasterMime,
  readBoundedFile,
} from "../kernel/files"
import { getImagePattern } from "./evidence-pattern"
import { getWorkspacePath, WorkspacePathError } from "./workspace-path"

export type WorkspaceImageInput = {
  appData: string
  bot: Bot
  projectPath?: string | undefined
  path: string
  base?: string | undefined
  capture?: boolean
  pattern?: boolean
}
export type WorkspaceImageResult = { paths: string[] } | { bytes: Uint8Array; mime: string }
const MAX_BYTES = 15 * 1024 * 1024

/** Final-response capture can use existing bot permissions; direct previews stay scoped to folders. */
export const getWorkspaceImage = (input: WorkspaceImageInput): WorkspaceImageResult => {
  const bot = {
    ...input.bot,
    anyFolderAccess: Boolean(input.capture && (input.bot.access === "full" || input.bot.anyFolderAccess)),
  }
  const path = input.pattern ? dirname(input.path) : input.path
  const location = getImageLocation(input, bot, path)
  if (input.pattern) return { paths: getPatternImages(location.root, location.path, input.path) }
  if (/[?*[\]{}]/.test(input.path)) throw new WorkspacePathError(400)

  return getLocalImageBytes("/", join(location.root, location.path).slice(1))
}

export const getLocalImageBytes = (root: string, path: string): { bytes: Uint8Array; mime: string } => {
  if (process.platform === "win32") {
    const bytes = readBoundedFile({ root, path: resolve(root, path), maxBytes: MAX_BYTES })
    const mime = rasterMime(bytes.subarray(0, 12))
    if (!mime) throw Object.assign(new Error("Formato de imagem inválido"), { code: "IMAGE_UNSUPPORTED" })
    return { bytes, mime }
  }
  const directory = openWorkspaceDirectory({ root, path: dirname(path) === "." ? "" : dirname(path) })
  const fd = (() => {
    try {
      return openWorkspaceEntry(directory, path.split("/").at(-1) ?? "")
    } finally {
      closeSync(directory)
    }
  })()
  try {
    const info = fstatSync(fd)
    if (info.size > MAX_BYTES) throw Object.assign(new Error("Imagem acima de 15 MB"), { code: "IMAGE_TOO_LARGE" })
    if (!info.isFile()) throw Object.assign(new Error("Formato de imagem inválido"), { code: "IMAGE_UNSUPPORTED" })
    const bytes = Buffer.alloc(info.size + 1)
    // Descriptor offsets are local to this bounded worker read.
    let count = 0
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, count)
      if (!read) break
      count += read
    }
    if (count !== info.size) throw new Error("Imagem alterada durante a leitura")
    const content = bytes.subarray(0, count)
    const mime = rasterMime(content.subarray(0, 12))
    if (!mime) throw Object.assign(new Error("Formato de imagem inválido"), { code: "IMAGE_UNSUPPORTED" })
    return { bytes: content, mime }
  } finally {
    closeSync(fd)
  }
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
  // Every result is opened relative to the same pinned directory with O_NOFOLLOW.
  const matches: string[] = []
  for (const entry of getWorkspaceEntryNames(fd)) {
    const name = entry.toLowerCase()
    if (name.length < prefix.length + suffix.length || !name.startsWith(prefix) || !name.endsWith(suffix)) continue
    try {
      if (!isRasterEntry(fd, entry)) continue
      // Local accumulation is bounded to six validated results inside this worker operation.
      matches.push(join(dirname(pattern), entry))
      if (matches.length === 6) break
    } catch {}
  }
  return matches
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

const getImageLocation = (input: WorkspaceImageInput, bot: Bot, path: string) => {
  try {
    return getWorkspacePath(input.appData, bot, path, input.base, input.projectPath)
  } catch (error) {
    if (error instanceof WorkspacePathError && error.status === 403)
      throw Object.assign(new Error("Imagem fora da pasta do bot"), { code: "IMAGE_OUTSIDE_WORKSPACE" })
    throw error
  }
}
