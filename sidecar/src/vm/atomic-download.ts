import { dlopen, read } from "bun:ffi"
import { randomBytes } from "node:crypto"
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, writeSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { openWorkspaceDirectory } from "../kernel/files"
import { canonicalSystemPath, errnoSymbol, libcLibrary } from "../platform/posix"

const openNative = () =>
  dlopen(libcLibrary, {
    openat: { args: ["i32", "cstring", "i32", "u32"], returns: "i32" },
    [errnoSymbol]: { args: [], returns: "ptr" },
    linkat: { args: ["i32", "cstring", "i32", "cstring", "i32"], returns: "i32" },
    renameat: { args: ["i32", "cstring", "i32", "cstring"], returns: "i32" },
    unlinkat: { args: ["i32", "cstring", "i32"], returns: "i32" },
  }).symbols
let cachedNative: ReturnType<typeof openNative> | undefined
const native = () => (cachedNative ??= openNative())

const errno = () => {
  const pointer = native()[errnoSymbol]?.()
  return pointer ? read.i32(pointer) : 0
}
const c = (value: string) => Buffer.from(`${value}\0`)

/** Stream privately, then publish one fully downloaded and synced regular file. */
export const atomicDownload = async (
  response: Response,
  path: string,
  { sync = fsyncSync }: { sync?: typeof fsyncSync } = {},
) => {
  if (!response.ok || !response.body || path.includes("\0")) throw new Error("Snapshot inválido")
  const target = canonicalSystemPath(resolve(path))
  const directory = openWorkspaceDirectory({ root: "/", path: dirname(target).slice(1) })
  const name = basename(target)
  const temporary = `.touri-${randomBytes(16).toString("hex")}.download`
  let fd: number | undefined
  let published = false
  let backup: string | undefined
  const validate = () => {
    const existing = native().openat(
      directory,
      c(name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0,
    )
    if (existing < 0) {
      if (errno() === 2) return false
      throw new Error("Destino de snapshot inválido")
    }
    try {
      const stat = fstatSync(existing)
      if (!stat.isFile() || stat.nlink !== 1) throw new Error("Destino de snapshot inválido")
      return true
    } finally {
      closeSync(existing)
    }
  }
  const reader = response.body.getReader()
  try {
    validate()
    fd = native().openat(
      directory,
      c(temporary),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    if (fd < 0) throw new Error("Não foi possível preparar o snapshot")
    fchmodSync(fd, 0o600)
    while (true) {
      const next = await reader.read()
      if (next.done) break
      for (let offset = 0; offset < next.value.length; ) {
        const count = writeSync(fd, next.value, offset, next.value.length - offset)
        if (count <= 0) throw new Error("Gravação incompleta do snapshot")
        offset += count
      }
    }
    sync(fd)
    const existed = validate()
    sync(directory)
    if (existed) {
      backup = `.touri-${randomBytes(16).toString("hex")}.backup`
      if (native().linkat(directory, c(name), directory, c(backup), 0) < 0)
        throw new Error("Não foi possível preservar o snapshot anterior")
    }
    if (native().renameat(directory, c(temporary), directory, c(name)) < 0)
      throw new Error("Não foi possível publicar o snapshot")
    published = true
    try {
      sync(directory)
    } catch (error) {
      if (backup) {
        if (native().renameat(directory, c(backup), directory, c(name)) < 0)
          throw new Error("Falha ao restaurar snapshot anterior")
        backup = undefined
      } else native().unlinkat(directory, c(name), 0)
      throw error
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
    if (fd !== undefined && fd >= 0) closeSync(fd)
    if (!published) native().unlinkat(directory, c(temporary), 0)
    if (backup) native().unlinkat(directory, c(backup), 0)
    closeSync(directory)
  }
}
