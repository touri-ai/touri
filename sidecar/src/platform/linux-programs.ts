import { existsSync, lstatSync, readlinkSync } from "node:fs"
import { dirname, join } from "node:path"
import { canonicalPath } from "../kernel/bot-folders"

/** Expose executable files or their JS package, never their enclosing home. */
export const linuxProgramFiles = (path: string): string[] => {
  const real = canonicalPath(path)
  if (!/\.[cm]?js$/.test(real)) return [real]
  // A loose script does not authorize its ancestors. Only an installed package
  // has an independently identifiable runtime root (including scoped packages).
  const parts = dirname(real).split("/")
  const modules = parts.lastIndexOf("node_modules")
  if (modules >= 0 && parts[modules + 1]) {
    const scoped = parts[modules + 1]?.startsWith("@")
    if (scoped && !parts[modules + 2]) return [real]
    const directory = parts.slice(0, modules + (scoped ? 3 : 2)).join("/")
    if (existsSync(join(directory, "package.json"))) return [directory]
  }
  return [real]
}

export const linuxProgramLinks = (executables: string[], base: string[]): string[] =>
  executables.flatMap((path) => {
    const real = canonicalPath(path)
    if (real === path || base.includes(dirname(path))) return []
    return ["--dir", dirname(path), "--symlink", real, path]
  })

export const linuxSystemLinks = (paths: string[]): string[] =>
  paths
    .filter(existsSync)
    .flatMap((path) =>
      lstatSync(path).isSymbolicLink() ? ["--symlink", readlinkSync(path), path] : ["--ro-bind", path, path],
    )
