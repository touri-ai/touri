import { createHash } from "node:crypto"
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { Bot, BotFolder } from "@touri/contracts"
import { errorRegistry } from "@touri/contracts"

export const specificFoldersRequired = errorRegistry["TOURI-E2011"].message
export const protectedFolder = errorRegistry["TOURI-E2012"].message

export const withinFolder = (root: string, path: string): boolean => {
  const part = relative(root, path)
  return part === "" || (!part.startsWith(`..${sep}`) && part !== ".." && !isAbsolute(part))
}

export const folderGuestPath = (path: string): string => {
  const name =
    basename(path)
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .slice(0, 64) || "folder"
  return `/host/${name}-${createHash("sha256").update(path).digest("hex").slice(0, 8)}`
}

// Do not follow links while walking. A granted tree must not silently expose a
// second host tree. Runtime callers with a minimal filesystem can validate just
// the root: links created after approval then dangle without blocking later turns.
export const resolveBotFolder = (path: string, inspectContents = true): string => {
  if (!isAbsolute(path) || /[\0\n\r,]/.test(path)) throw new Error("Escolha uma pasta com caminho absoluto válido.")
  const canonical = realpathSync(path)
  if (!statSync(canonical).isDirectory()) throw new Error("O caminho precisa ser uma pasta.")
  if (process.platform === "linux" && canonical === "/") throw new Error(specificFoldersRequired)
  if (process.platform === "linux" && ["/proc", "/sys", "/dev"].some((root) => withinFolder(root, canonical)))
    throw new Error(protectedFolder)
  if (lstatSync(path).isSymbolicLink()) throw new Error("Escolha a pasta original, não um link simbólico.")
  if (!inspectContents) return canonical
  const pending = [canonical]
  let entries = 0
  while (pending.length) {
    const directory = pending.pop()
    if (!directory) break
    if (!withinFolder(canonical, realpathSync(directory)))
      throw new Error("A pasta contém um link simbólico que aponta para fora dela.")
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (++entries > 100_000) throw new Error("Esta pasta é muito grande para validar. Escolha uma subpasta.")
      const child = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        if (!withinFolder(canonical, realpathSync(child)))
          throw new Error("A pasta contém um link simbólico que aponta para fora dela.")
      } else if (entry.isDirectory()) pending.push(child)
    }
  }
  return canonical
}

export const parseBotFolders = (value: unknown): BotFolder[] => {
  if (!Array.isArray(value) || value.length > 32) throw new Error("Escolha até 32 pastas.")
  const folders: BotFolder[] = []
  for (const item of value) {
    if (!item || typeof item.path !== "string" || !["read-only", "read-write"].includes(item.access))
      throw new Error("Pasta ou nível de acesso inválido.")
    const path = resolveBotFolder(item.path)
    const access = item.access as BotFolder["access"]
    for (const folder of folders) {
      if (folder.path === path) throw new Error("Esta pasta já está na lista.")
      if ((withinFolder(folder.path, path) || withinFolder(path, folder.path)) && folder.access !== access)
        throw new Error("Pastas sobrepostas precisam ter o mesmo nível de acesso.")
    }
    folders.push({ path, access })
  }
  return folders
}

// Keep both the spelling and realpath: a sensitive directory may itself be a
// symlink. Missing leaves still need a deny rule if they are created later.
export const canonicalPath = (path: string): string => {
  try {
    return realpathSync(path)
  } catch (error) {
    // Bun cannot realpath a live Unix socket on macOS; canonicalize its parent.
    if (!["ENOENT", "EACCES", "EPERM", "EOPNOTSUPP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
    const parent = resolve(path, "..")
    return parent === path ? path : join(canonicalPath(parent), basename(path))
  }
}

export const excludedBotFolders = (appData: string, home = homedir()): string[] => [
  ...new Set(
    [
      join(home, "Library/Keychains"),
      join(home, ".ssh"),
      join(home, "Library/Safari"),
      join(home, "Library/Containers/com.apple.Safari"),
      join(home, "Library/Group Containers/group.com.apple.Safari"),
      join(home, "Library/Application Support/Google/Chrome"),
      join(home, "Library/Application Support/Google/Chrome Canary"),
      join(home, "Library/Application Support/Google/Chrome Beta"),
      join(home, "Library/Application Support/Chromium"),
      join(home, "Library/Application Support/Microsoft Edge"),
      join(home, "Library/Application Support/BraveSoftware/Brave-Browser"),
      join(home, "Library/Application Support/Firefox"),
      join(home, "Library/Application Support/Arc"),
      join(home, "Library/Application Support/Zen"),
      join(home, "Library/Application Support/Opera"),
      join(home, "Library/Application Support/com.operasoftware.Opera"),
      join(home, "Library/Application Support/com.operasoftware.OperaGX"),
      join(home, "Library/Application Support/Vivaldi"),
      join(home, "Library/Application Support/TorBrowser-Data"),
      appData,
    ].flatMap((path) => [path, canonicalPath(path)]),
  ),
]

export const botFolderFingerprint = (bot: Pick<Bot, "folders" | "anyFolderAccess" | "access">): string =>
  createHash("sha256")
    .update(JSON.stringify([bot.folders ?? [], bot.anyFolderAccess ?? false, bot.access]))
    .digest("hex")
