import { existsSync, lstatSync, readlinkSync } from "node:fs"
import { dirname, join } from "node:path"
import { canonicalPath } from "../kernel/bot-folders"

/** Expose executable files or their JS package, never their enclosing home. */
export const linuxProgramFiles = (path: string): string[] => {
  const real = canonicalPath(path)
  if (!/\.[cm]?js$/.test(real)) return [real]
  let directory = dirname(real)
  while (directory !== "/") {
    if (existsSync(join(directory, "package.json"))) return [directory]
    directory = dirname(directory)
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
