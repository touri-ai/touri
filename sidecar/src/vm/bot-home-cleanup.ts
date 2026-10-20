import { CString, dlopen, read } from "bun:ffi"
import { closeSync, constants, fsyncSync } from "node:fs"
import { join } from "node:path"
import { openWorkspaceDirectoryIfPresent } from "../kernel/files"
import { direntNameOffset, errnoSymbol, libcLibrary, removeDirectoryFlag } from "../platform/posix"
import { nativeFileOperation } from "../platform/windows-native"

const openNative = () =>
  dlopen(libcLibrary, {
    openat: { args: ["i32", "cstring", "i32"], returns: "i32" },
    unlinkat: { args: ["i32", "cstring", "i32"], returns: "i32" },
    dup: { args: ["i32"], returns: "i32" },
    fdopendir: { args: ["i32"], returns: "ptr" },
    readdir: { args: ["ptr"], returns: "ptr" },
    closedir: { args: ["ptr"], returns: "i32" },
    [errnoSymbol]: { args: [], returns: "ptr" },
  }).symbols

let cachedNative: ReturnType<typeof openNative> | undefined
const native = () => (cachedNative ??= openNative())
const errno = (): number => {
  const pointer = native()[errnoSymbol]?.()
  return pointer ? read.i32(pointer) : 0
}
const cstring = (value: string): Buffer => Buffer.from(`${value}\0`)

/** Remove one bot home through pinned, no-follow directory descriptors. */
export const removeBotHomeDirectory = ({ root, path, botId }: { root: string; path: string; botId: string }): void => {
  if (!botId || botId === "." || botId === ".." || /[\\/\0]/.test(botId)) throw new Error("Pasta do bot inválida.")
  if (process.platform === "win32") {
    nativeFileOperation("remove_tree", { root, path: join(path, botId) })
    return
  }
  const parent = openWorkspaceDirectoryIfPresent({ root, path })
  if (parent === null) return
  const remove = (directory: number, name: string): void => {
    const child = native().openat(
      directory,
      cstring(name),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    if (child < 0) {
      const error = errno()
      if (error === 2) return
      if (error !== 20 && error !== 40 && error !== 62) throw new Error("Não foi possível remover a pasta do bot.")
      if (native().unlinkat(directory, cstring(name), 0) !== 0 && errno() !== 2)
        throw new Error("Não foi possível remover um arquivo do bot.")
      return
    }
    try {
      const duplicate = native().dup(child)
      const stream = native().fdopendir(duplicate)
      if (!stream) {
        closeSync(duplicate)
        throw new Error("Não foi possível ler a pasta do bot.")
      }
      try {
        while (true) {
          const entry = native().readdir(stream)
          if (!entry) break
          const entryName = new CString(entry, direntNameOffset).toString()
          if (entryName !== "." && entryName !== "..") remove(child, entryName)
        }
      } finally {
        native().closedir(stream)
      }
      fsyncSync(child)
    } finally {
      closeSync(child)
    }
    if (native().unlinkat(directory, cstring(name), removeDirectoryFlag) !== 0 && errno() !== 2)
      throw new Error("Não foi possível remover a pasta do bot.")
  }
  try {
    remove(parent, botId)
    fsyncSync(parent)
  } finally {
    closeSync(parent)
  }
}
