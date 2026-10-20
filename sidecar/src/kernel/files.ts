import { CString, dlopen, read } from "bun:ffi"
import { randomBytes } from "node:crypto"
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  writeSync,
} from "node:fs"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import {
  closeOnExec,
  direntNameOffset,
  errnoSymbol,
  libcLibrary,
  quotaExceeded,
  removeDirectoryFlag,
} from "../platform/posix"
import { nativeFileOperation } from "../platform/windows-native"
import { TouriError } from "./errors"

// Node's path APIs cannot pin ancestor directories during rename. These small POSIX
// calls keep every operation relative to an O_NOFOLLOW directory descriptor.
const openNative = () =>
  dlopen(libcLibrary, {
    openat: { args: ["i32", "cstring", "i32", "u32"], returns: "i32" },
    mkdirat: { args: ["i32", "cstring", "u32"], returns: "i32" },
    renameat: { args: ["i32", "cstring", "i32", "cstring"], returns: "i32" },
    unlinkat: { args: ["i32", "cstring", "i32"], returns: "i32" },
    symlinkat: { args: ["cstring", "i32", "cstring"], returns: "i32" },
    dup: { args: ["i32"], returns: "i32" },
    fdopendir: { args: ["i32"], returns: "ptr" },
    readdir: { args: ["ptr"], returns: "ptr" },
    closedir: { args: ["ptr"], returns: "i32" },
    [errnoSymbol]: { args: [], returns: "ptr" },
  }).symbols
let cachedNative: ReturnType<typeof openNative> | undefined
const native = () => (cachedNative ??= openNative())

const cstring = (text: string): Buffer => Buffer.from(`${text}\0`)
const errno = (): number => {
  const pointer = native()[errnoSymbol]?.()
  return pointer ? read.i32(pointer) : 0
}
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | closeOnExec
const failure = (): TouriError => {
  const code = errno()
  if (code === 28 || code === quotaExceeded) return new TouriError("TOURI-E2002")
  return new TouriError(code === 13 || code === 1 ? "TOURI-E2000" : "TOURI-E2001")
}
const openAt = (parent: number, name: string, flags: number, mode = 0): number =>
  native().openat(parent, cstring(name), flags, mode)

const directoryAt = (parent: number, name: string, create: boolean): number => {
  if (create && native().mkdirat(parent, cstring(name), 0o700) < 0 && errno() !== 17) throw failure()
  const fd = openAt(parent, name, directoryFlags)
  if (fd < 0) throw new TouriError("TOURI-E2000")
  return fd
}

/** Pins an existing workspace directory without creating or modifying any path. Caller closes the fd. */
export const openWorkspaceDirectory = ({ root, path }: { root: string; path: string }): number => {
  if (process.platform === "win32")
    throw new Error("Native directory-descriptor workspace access is not available on Windows")
  if (path.includes("\0") || path.startsWith("/") || path.split("/").some((part) => part === ".."))
    throw new TouriError("TOURI-E2000")
  const absoluteRoot = resolve(root)
  let fd = openSync(resolve(realpathSync(dirname(absoluteRoot)), basename(absoluteRoot)), directoryFlags)
  try {
    for (const part of path.split("/").filter(Boolean)) {
      const next = directoryAt(fd, part, false)
      closeSync(fd)
      fd = next
    }
    return fd
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

/** Pins an existing workspace directory, or returns null when a path segment is absent. */
export const openWorkspaceDirectoryIfPresent = ({ root, path }: { root: string; path: string }): number | null => {
  if (process.platform === "win32")
    throw new Error("Native directory-descriptor workspace access is not available on Windows")
  if (path.includes("\0") || path.startsWith("/") || path.split("/").some((part) => part === ".."))
    throw new TouriError("TOURI-E2000")
  const absoluteRoot = resolve(root)
  let fd = openSync(resolve(realpathSync(dirname(absoluteRoot)), basename(absoluteRoot)), directoryFlags)
  try {
    for (const part of path.split("/").filter(Boolean)) {
      const next = openAt(fd, part, directoryFlags)
      if (next < 0) {
        if (errno() === 2) {
          closeSync(fd)
          return null
        }
        throw new TouriError("TOURI-E2000")
      }
      closeSync(fd)
      fd = next
    }
    return fd
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

/** Creates subdirectories under an existing root without following links or changing its permissions. */
export const createWorkspaceDirectory = ({
  root,
  path,
  identity,
}: {
  root: string
  path: string
  identity: { dev: number; ino: number }
}): void => {
  if (path.includes("\0") || path.startsWith("/") || path.split("/").some((part) => part === ".."))
    throw new TouriError("TOURI-E2000")
  let fd = openWorkspaceDirectory({ root, path: "" })
  try {
    const info = fstatSync(fd)
    if (info.dev !== identity.dev || info.ino !== identity.ino) throw new TouriError("TOURI-E2000")
    for (const part of path.split("/").filter(Boolean)) {
      const next = directoryAt(fd, part, true)
      closeSync(fd)
      fd = next
    }
  } finally {
    closeSync(fd)
  }
}

export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024

/** Read one bounded regular file through pinned, no-follow directory descriptors. */
export const readBoundedFile = ({ root, path, maxBytes }: { root: string; path: string; maxBytes: number }): Buffer => {
  if (process.platform === "win32") {
    const value = nativeFileOperation<string | null>("read_bounded", { root, path, max_bytes: maxBytes })
    if (value === null) throw new TouriError("TOURI-E2000")
    return Buffer.from(value, "base64")
  }
  const parts = pathParts(root, path)
  const name = parts.pop()
  if (!name) throw new TouriError("TOURI-E2000")
  const directory = openWorkspaceDirectory({ root, path: parts.join("/") })
  let fd: number
  try {
    fd = openWorkspaceEntry(directory, name)
  } finally {
    closeSync(directory)
  }
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.size > maxBytes) throw new Error("Escolha um arquivo de até 15 MB")
    const bytes = Buffer.alloc(info.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (!count) break
      offset += count
    }
    if (offset !== info.size) throw new Error("O arquivo mudou durante a leitura")
    return bytes.subarray(0, offset)
  } finally {
    closeSync(fd)
  }
}

/** Only these raster signatures are allowed to render in the authenticated origin. */
export const rasterMime = (bytes: Uint8Array): string | null => {
  const b = Buffer.from(bytes)
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png"
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg"
  if (["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString("ascii"))) return "image/gif"
  if (b.length >= 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP")
    return "image/webp"
  return null
}

export const attachmentMime = (bytes: Uint8Array): string => rasterMime(bytes) ?? "application/octet-stream"

/** Opens one entry relative to a pinned directory; symlinks and blocking device reads are refused. */
export const openWorkspaceEntry = (directory: number, name: string): number => {
  if (process.platform === "win32") throw new Error("Native workspace descriptors are unavailable on Windows")
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0"))
    throw new TouriError("TOURI-E2000")
  const fd = openAt(directory, name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | closeOnExec)
  if (fd < 0) throw new TouriError("TOURI-E2000")
  return fd
}

/** Creates one new child under a pinned directory, refusing existing entries. */
export const createWorkspaceChildDirectory = (directory: number, name: string): void => {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0"))
    throw new TouriError("TOURI-E2000")
  if (native().mkdirat(directory, cstring(name), 0o700) < 0) {
    if (errno() === 17) throw Object.assign(new Error("Directory exists"), { code: "EEXIST" })
    throw failure()
  }
}

const rootDirectory = (root: string): number => {
  if (root.includes("\0") || resolve(root) === sep) throw new TouriError("TOURI-E2000")
  const absolute = resolve(root)
  // Ancestors outside the application root may contain OS aliases (/var, /tmp).
  // Resolve those once, then walk the canonical parent without following links.
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 })
  const parent = realpathSync(dirname(absolute))
  let fd = openSync(sep, directoryFlags)
  try {
    for (const part of parent.split(sep).filter(Boolean)) {
      const next = directoryAt(fd, part, false)
      closeSync(fd)
      fd = next
    }
    const rootFd = directoryAt(fd, basename(absolute), true)
    try {
      fsyncSync(fd)
      return rootFd
    } catch (error) {
      closeSync(rootFd)
      throw error
    }
  } finally {
    closeSync(fd)
  }
}

const pathParts = (root: string, path: string): Array<string> => {
  if (path.includes("\0")) throw new TouriError("TOURI-E2000")
  const suffix = relative(resolve(root), resolve(path))
  if (suffix === ".." || suffix.startsWith(`..${sep}`) || suffix.startsWith(sep)) throw new TouriError("TOURI-E2000")
  return suffix.split(sep).filter(Boolean)
}

const withDirectory = <T>(root: string, parts: Array<string>, action: (fd: number) => T): T => {
  let fd: number | undefined
  try {
    fd = rootDirectory(root)
    for (const part of parts) {
      const next = directoryAt(fd, part, true)
      // Persist newly created directories as well as the final rename.
      try {
        fsyncSync(fd)
      } catch (error) {
        closeSync(next)
        throw error
      }
      closeSync(fd)
      fd = next
    }
    return action(fd)
  } catch (error) {
    if (error instanceof TouriError) throw error
    const code = error instanceof Error && "code" in error ? error.code : null
    throw new TouriError(
      code === "ENOSPC" || code === "EDQUOT"
        ? "TOURI-E2002"
        : code === "EACCES" || code === "EPERM" || code === "ELOOP" || code === "ENOTDIR"
          ? "TOURI-E2000"
          : "TOURI-E2001",
      { cause: error },
    )
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

const existingFile = (directory: number, name: string): number | null => {
  const fd = openAt(directory, name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | closeOnExec)
  if (fd < 0) {
    if (errno() === 2) return null
    throw new TouriError("TOURI-E2000")
  }
  try {
    const stats = fstatSync(fd)
    // A linked database or permission update must not modify another pathname.
    if (!stats.isFile() || stats.nlink > 1) throw new TouriError("TOURI-E2000")
    return fd
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

const validateTarget = (directory: number, name: string): void => {
  const fd = existingFile(directory, name)
  if (fd !== null) closeSync(fd)
}

export type FileWrite = { root: string; path: string; content: string | Uint8Array; mode?: number }

/** Injectable durability operations allow deterministic failure and ordering tests. */
export const createAtomicWriter = ({ sync = fsyncSync }: { sync?: (fd: number) => void } = {}) => {
  return ({ root, path, content, mode = 0o600 }: FileWrite): void => {
    if (process.platform === "win32") {
      nativeFileOperation("write", { root, path, content: Buffer.from(content).toString("base64") })
      return
    }
    const parts = pathParts(root, path)
    const name = parts.pop()
    if (!name) throw new TouriError("TOURI-E2000")
    withDirectory(root, parts, (directory) => {
      validateTarget(directory, name)
      const temporary = `.touri-${randomBytes(16).toString("hex")}.tmp`
      const fd = openAt(
        directory,
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | closeOnExec,
        0o600,
      )
      if (fd < 0) throw failure()
      let renamed = false
      try {
        const bytes = typeof content === "string" ? Buffer.from(content) : content
        for (let offset = 0; offset < bytes.byteLength; ) {
          const written = writeSync(fd, bytes, offset, bytes.byteLength - offset)
          if (written === 0) throw new TouriError("TOURI-E2001")
          offset += written
        }
        fchmodSync(fd, mode)
        sync(fd)
        validateTarget(directory, name)
        if (native().renameat(directory, cstring(temporary), directory, cstring(name)) < 0) throw failure()
        renamed = true
        sync(directory)
      } finally {
        closeSync(fd)
        if (!renamed) native().unlinkat(directory, cstring(temporary), 0)
      }
    })
  }
}

export const atomicWriteFile = createAtomicWriter()

export const ensurePrivateDirectory = ({
  root,
  path = root,
  mode = 0o700,
}: {
  root: string
  path?: string
  mode?: number
}): void => {
  if (process.platform === "win32") {
    nativeFileOperation("ensure_dir", { root, path })
    return
  }
  withDirectory(root, pathParts(root, path), (fd) => {
    fchmodSync(fd, mode)
    fsyncSync(fd)
  })
}

export const readPrivateFile = ({
  root,
  path,
  maxBytes,
}: {
  root: string
  path: string
  maxBytes?: number
}): Buffer | null => {
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1))
    throw new RangeError("O limite de bytes deve ser positivo")
  if (process.platform === "win32") {
    const value = nativeFileOperation<string | null>("read", {
      root,
      path,
      ...(maxBytes === undefined ? {} : { max_bytes: maxBytes }),
    })
    return value === null ? null : Buffer.from(value, "base64")
  }
  const parts = pathParts(root, path)
  const name = parts.pop()
  if (!name) throw new TouriError("TOURI-E2000")
  return withDirectory(root, parts, (directory) => {
    const fd = existingFile(directory, name)
    if (fd === null) return null
    try {
      if (maxBytes !== undefined) {
        const size = fstatSync(fd).size
        const start = Math.max(0, size - maxBytes)
        const bytes = Buffer.alloc(Math.min(size, maxBytes))
        let offset = 0
        while (offset < bytes.byteLength) {
          const count = readSync(fd, bytes, offset, bytes.byteLength - offset, start + offset)
          if (count === 0) break
          offset += count
        }
        return bytes.subarray(0, offset)
      }
      return readFileSync(fd)
    } finally {
      closeSync(fd)
    }
  })
}

/** Logs are bounded by their callers; replace the snapshot to avoid partial lines. */
export const atomicAppendFile = ({ root, path, content, maxBytes, mode }: FileWrite & { maxBytes?: number }): void => {
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1))
    throw new RangeError("O limite de bytes deve ser positivo")
  const previous =
    readPrivateFile({
      root,
      path,
      ...(maxBytes === undefined ? {} : { maxBytes: Math.min(Number.MAX_SAFE_INTEGER, maxBytes + 1) }),
    }) ?? Buffer.alloc(0)
  const bytes = typeof content === "string" ? Buffer.from(content) : content
  const combined = Buffer.concat([previous, bytes])
  const overflow = maxBytes === undefined ? 0 : Math.max(0, combined.byteLength - maxBytes)
  // Retain complete log lines when the snapshot reaches its byte limit.
  const start = overflow === 0 || combined[overflow - 1] === 10 ? overflow : combined.indexOf(10, overflow) + 1
  const bounded = overflow > 0 && start === 0 ? Buffer.alloc(0) : combined.subarray(start)
  atomicWriteFile({ root, path, content: bounded, ...(mode === undefined ? {} : { mode }) })
}

export const assertPrivateFile = ({ root, path, mode }: { root: string; path: string; mode?: number }): void => {
  if (process.platform === "win32") {
    nativeFileOperation("assert", { root, path })
    return
  }
  const parts = pathParts(root, path)
  const name = parts.pop()
  if (!name) throw new TouriError("TOURI-E2000")
  withDirectory(root, parts, (directory) => {
    const fd = existingFile(directory, name)
    if (fd === null) return
    try {
      if (mode !== undefined) {
        fchmodSync(fd, mode)
        fsyncSync(fd)
      }
    } finally {
      closeSync(fd)
    }
  })
}

export const removePrivateFile = ({ root, path }: { root: string; path: string }): void => {
  if (process.platform === "win32") {
    nativeFileOperation("remove", { root, path })
    return
  }
  const parts = pathParts(root, path)
  const name = parts.pop()
  if (!name) throw new TouriError("TOURI-E2000")
  withDirectory(root, parts, (fd) => {
    if (native().unlinkat(fd, cstring(name), 0) < 0 && errno() !== 2) throw failure()
    fsyncSync(fd)
  })
}

/** Remove a private tree through pinned directory handles without following links. */
export const removePrivateTree = ({ root, path }: { root: string; path: string }): void => {
  if (process.platform === "win32") {
    nativeFileOperation("remove_tree", { root, path })
    return
  }
  const parts = pathParts(root, path)
  const name = parts.pop()
  if (!name) throw new TouriError("TOURI-E2000")
  if (!existsSync(join(root, ...parts, name))) return
  const parent = openWorkspaceDirectory({ root, path: parts.join(sep) })
  const remove = (directory: number, entry: string): void => {
    const child = openAt(directory, entry, directoryFlags)
    if (child < 0) {
      const code = errno()
      if (code === 2) return
      if (code !== 20 && code !== 40 && code !== 62) throw failure()
      if (native().unlinkat(directory, cstring(entry), 0) < 0 && errno() !== 2) throw failure()
      return
    }
    try {
      const duplicate = native().dup(child)
      if (duplicate < 0) throw failure()
      const stream = native().fdopendir(duplicate)
      if (!stream) {
        closeSync(duplicate)
        throw failure()
      }
      try {
        while (true) {
          const item = native().readdir(stream)
          if (!item) break
          const childName = new CString(item, direntNameOffset).toString()
          if (childName !== "." && childName !== "..") remove(child, childName)
        }
      } finally {
        native().closedir(stream)
      }
      fsyncSync(child)
    } finally {
      closeSync(child)
    }
    if (native().unlinkat(directory, cstring(entry), removeDirectoryFlag) < 0 && errno() !== 2) throw failure()
  }
  try {
    remove(parent, name)
    fsyncSync(parent)
  } finally {
    closeSync(parent)
  }
}

export const movePrivateFile = ({ root, from, to }: { root: string; from: string; to: string }): void => {
  if (process.platform === "win32") {
    nativeFileOperation("move", { root, path: from, to })
    return
  }
  const source = pathParts(root, from)
  const target = pathParts(root, to)
  const sourceName = source.pop()
  const targetName = target.pop()
  if (!sourceName || !targetName) throw new TouriError("TOURI-E2000")
  withDirectory(root, source, (sourceFd) =>
    withDirectory(root, target, (targetFd) => {
      validateTarget(sourceFd, sourceName)
      validateTarget(targetFd, targetName)
      if (native().renameat(sourceFd, cstring(sourceName), targetFd, cstring(targetName)) < 0) throw failure()
      fsyncSync(targetFd)
      fsyncSync(sourceFd)
    }),
  )
}

export const replacePrivateSymlink = ({ root, path, target }: { root: string; path: string; target: string }): void => {
  if (target.includes("\0")) throw new TouriError("TOURI-E2000")
  if (process.platform === "win32") {
    nativeFileOperation("replace_symlink", { root, path, target })
    return
  }
  const parts = pathParts(root, path)
  const name = parts.pop()
  if (!name) throw new TouriError("TOURI-E2000")
  withDirectory(root, parts, (directory) => {
    const temporary = `.touri-${randomBytes(16).toString("hex")}.link`
    if (native().symlinkat(cstring(target), directory, cstring(temporary)) < 0) throw failure()
    try {
      if (native().renameat(directory, cstring(temporary), directory, cstring(name)) < 0) throw failure()
      fsyncSync(directory)
    } catch (error) {
      native().unlinkat(directory, cstring(temporary), 0)
      throw error
    }
  })
}

/** SQLite retains its own WAL/transaction protocol; never rename a live database. */
export const prepareDatabaseFile = ({ root, path }: { root: string; path: string }): string => {
  if (process.platform === "win32") return nativeFileOperation<string>("database", { root, path })
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    assertPrivateFile({ root, path: `${path}${suffix}`, mode: 0o600 })
  if (!existsSync(path)) atomicWriteFile({ root, path, content: "" })
  // Canonicalize only ancestors outside the app root (including macOS /var).
  // Keep the root and filename intact for SQLite's own NOFOLLOW checks.
  const absoluteRoot = resolve(root)
  return resolve(realpathSync(dirname(absoluteRoot)), basename(absoluteRoot), ...pathParts(root, path))
}
