import { closeSync, fstatSync } from "node:fs"
import { lstat, opendir, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, parse, sep } from "node:path"
import type { FolderListing, RouteModule } from "@touri/contracts"
import { excludedBotFolders, withinFolder } from "../kernel/bot-folders"
import { createWorkspaceChildDirectory, openWorkspaceDirectory, openWorkspaceEntry } from "../kernel/files"

const MAX_FOLDERS = 100
const MAX_ENTRIES = 2_000
const invalidPath = /[\0\n\r,]/

export const createFolderRoutes = ({ appData, home = homedir() }: { appData: string; home?: string }): RouteModule => {
  const denied = (path: string, excluded: string[]) => excluded.some((root) => withinFolder(root, path))
  const directory = async (value: unknown, excluded: string[]) => {
    if (typeof value !== "string" || !isAbsolute(value) || value.length > 4096 || invalidPath.test(value))
      throw new Error("Escolha uma pasta com caminho absoluto válido.")
    const parts = value.split(sep).filter(Boolean)
    if (parts.some((part) => part.startsWith(".")) || denied(value, excluded))
      throw new Error("Esta pasta é protegida. Escolha outra pasta.")
    // Check every component before resolving: links and '..' must never bypass exclusions.
    let current = parse(value).root
    for (const part of parts) {
      current = join(current, part)
      if ((await lstat(current)).isSymbolicLink()) throw new Error("Escolha a pasta original, não um link simbólico.")
    }
    const path = await realpath(value)
    if (denied(path, excluded)) throw new Error("Esta pasta é protegida. Escolha outra pasta.")
    const identity = await lstat(path)
    if (!identity.isDirectory()) throw new Error("O caminho precisa ser uma pasta.")
    const fd = openWorkspaceDirectory({ root: "/", path: path.slice(1) })
    const pinned = fstatSync(fd)
    if (pinned.dev !== identity.dev || pinned.ino !== identity.ino) {
      closeSync(fd)
      throw new Error("A pasta mudou enquanto era aberta. Escolha a pasta novamente.")
    }
    return { path, fd }
  }
  const unchanged = (path: string, fd: number) => {
    const current = openWorkspaceDirectory({ root: "/", path: path.slice(1) })
    try {
      const before = fstatSync(fd)
      const after = fstatSync(current)
      if (before.dev !== after.dev || before.ino !== after.ino || denied(path, excludedBotFolders(appData, home)))
        throw new Error("A pasta mudou enquanto era aberta. Escolha a pasta novamente.")
    } finally {
      closeSync(current)
    }
  }
  const failure = (error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code
    const message =
      code === "EEXIST"
        ? "Já existe uma pasta ou arquivo com esse nome. Escolha outro nome."
        : code
          ? "Não foi possível abrir ou criar a pasta. Confira se ela existe e se você tem permissão."
          : (error as Error).message
    return { status: 400, json: { errorCode: "INVALID_ARGS", error: message } }
  }
  return {
    name: "folders",
    routes: [
      {
        method: "GET",
        path: "/folders",
        handler: async ({ query, signal }) => {
          let directoryFd: number | undefined
          try {
            signal.throwIfAborted()
            const excluded = excludedBotFolders(appData, home)
            const start = await realpath(home)
            const { path, fd } = await directory(query.path ?? start, excluded)
            directoryFd = fd
            const folders: FolderListing["folders"] = []
            let entries = 0
            let truncated = false
            const handle = await opendir(path)
            for await (const entry of handle) {
              signal.throwIfAborted()
              if (++entries > MAX_ENTRIES) {
                truncated = true
                break
              }
              if (entry.name.startsWith(".") || !entry.isDirectory() || entry.isSymbolicLink()) continue
              const child = join(path, entry.name)
              if (denied(child, excluded)) continue
              // Only return entries that also exist under the pinned, no-follow directory.
              let childFd: number | undefined
              try {
                childFd = openWorkspaceEntry(fd, entry.name)
                if (!fstatSync(childFd).isDirectory()) continue
              } catch {
                continue
              } finally {
                if (childFd !== undefined) closeSync(childFd)
              }
              if (folders.length === MAX_FOLDERS) {
                truncated = true
                break
              }
              folders.push({ name: entry.name, path: child })
            }
            unchanged(path, fd)
            folders.sort((a, b) => a.name.localeCompare(b.name))
            const parent = dirname(path)
            return {
              status: 200,
              json: {
                home: start,
                path,
                parent: parent === path ? null : parent,
                folders,
                truncated,
              } satisfies FolderListing,
            }
          } catch (error) {
            return failure(error)
          } finally {
            if (directoryFd !== undefined) closeSync(directoryFd)
          }
        },
      },
      {
        method: "POST",
        path: "/folders",
        handler: async ({ body }) => {
          let directoryFd: number | undefined
          try {
            const input = body as { path?: unknown; name?: unknown } | null
            const name = typeof input?.name === "string" ? input.name.trim() : ""
            if (!name || name.length > 255 || name.startsWith(".") || /[\\/\0\n\r,]/.test(name))
              throw new Error("Use um nome de pasta sem barras e que não comece com ponto.")
            const excluded = excludedBotFolders(appData, home)
            const { path: parent, fd } = await directory(input?.path, excluded)
            directoryFd = fd
            const path = join(parent, name)
            if (denied(path, excluded)) throw new Error("Esta pasta é protegida. Escolha outra pasta.")
            createWorkspaceChildDirectory(fd, name)
            unchanged(parent, fd)
            return { status: 201, json: { path } }
          } catch (error) {
            return failure(error)
          } finally {
            if (directoryFd !== undefined) closeSync(directoryFd)
          }
        },
      },
    ],
  }
}
