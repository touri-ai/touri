import { closeSync, fstatSync, readSync } from "node:fs"
import { basename, dirname, isAbsolute, normalize } from "node:path"
import { readWindowsGrantedFile } from "../platform/read-windows-granted-file"
import { openWorkspaceDirectory, openWorkspaceEntry } from "./files"

export type GrantedFileTarget = { path: string; dev: string; ino: string; maxBytes: number }

export const readGrantedFileAsync = async (target: GrantedFileTarget, signal: AbortSignal): Promise<Buffer> => {
  if (!isAbsolute(target.path) || target.path.includes("\0") || normalize(target.path) !== target.path)
    throw new Error("Caminho de arquivo inválido")
  if (process.platform === "win32") return readWindowsGrantedFile({ target, signal })

  return readGrantedFile(target)
}

const readAll = (fd: number, size: number): Buffer => {
  const bytes = Buffer.alloc(size + 1)
  let offset = 0
  while (offset < bytes.length) {
    const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
    if (!count) break
    offset += count
  }
  if (offset !== size) throw new Error("O arquivo mudou durante a leitura")
  return bytes.subarray(0, offset)
}

/**
 * Reads exactly the file the shell granted: canonical absolute path, no-follow descriptors for every
 * component, regular file only, and the open descriptor must match the device and inode the shell pinned.
 */
export const readGrantedFile = ({ path, dev, ino, maxBytes }: GrantedFileTarget): Buffer => {
  if (!isAbsolute(path) || path.includes("\0") || normalize(path) !== path)
    throw new Error("Caminho de arquivo inválido")
  const directory = openWorkspaceDirectory({ root: "/", path: dirname(path).slice(1) })
  const fd = (() => {
    try {
      return openWorkspaceEntry(directory, basename(path))
    } finally {
      closeSync(directory)
    }
  })()
  try {
    const info = fstatSync(fd, { bigint: true })
    if (!info.isFile()) throw new Error("Escolha um arquivo, não uma pasta")
    if (String(info.dev) !== dev || String(info.ino) !== ino) throw new Error("O arquivo mudou depois de ser solto")
    if (info.size > BigInt(maxBytes)) throw new Error("Escolha um arquivo de até 15 MB")
    return readAll(fd, Number(info.size))
  } finally {
    closeSync(fd)
  }
}
