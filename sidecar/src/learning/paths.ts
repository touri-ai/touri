import { lstatSync } from "node:fs"
import { dirname, isAbsolute, join, relative, sep } from "node:path"
import { writePrivateFileAsync } from "../kernel/async-files"

/** Check links with lstat: existsSync follows them and misses dangling links. */
export const linkFree = (root: string, target: string, kind?: "file" | "directory"): boolean => {
  const path = relative(root, target)
  if (isAbsolute(path) || path.split(sep).includes("..")) return false
  let current = root
  for (const part of ["", ...path.split(sep).filter(Boolean)]) {
    current = part ? join(current, part) : current
    try {
      const stat = lstatSync(current)
      if (current === target && kind === "file" && !stat.isFile()) return false
      if (current === target && kind === "directory" && !stat.isDirectory()) return false
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) return false
      if (current !== target && !stat.isDirectory()) return false
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
    }
  }
  return true
}

export const writeAtomically = (path: string, content: string): Promise<void> =>
  writePrivateFileAsync({ root: dirname(path), path, content })
