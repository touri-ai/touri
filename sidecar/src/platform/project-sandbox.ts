import { existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import type { BotFolder } from "@touri/contracts"
import { canonicalPath, resolveBotFolder, withinFolder } from "../kernel/bot-folders"
import { linuxProtectedFolders, linuxSandboxBase, linuxSandboxBinary } from "../kernel/folder-capability"
import { linuxProgramFiles, linuxProgramLinks } from "./linux-programs"
import { darwinSandboxProfile } from "./macos/sandbox"

export const projectSandboxCommand = ({
  roots,
  shell,
  command,
  folders = [],
  appData,
  env = {},
}: {
  roots: string[]
  shell: string
  command: string
  folders?: BotFolder[]
  appData?: string
  env?: Record<string, string>
}): { cmd: string; args: string[] } | null => {
  if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec"))
    return { cmd: "/usr/bin/sandbox-exec", args: ["-p", darwinSandboxProfile({ roots }), shell, "-c", command] }
  const binary = linuxSandboxBinary()
  if (!binary) return null
  try {
    const grants = folders.map((folder) => {
      const path = resolveBotFolder(folder.path, false)
      if (path !== folder.path) throw new Error("changed grant")
      return { ...folder, path }
    })
    const writable = [...new Set(roots.filter(existsSync).map(canonicalPath))]
    const executables = [
      shell,
      ...["node", "bun"].map((name) => Bun.which(name, { PATH: env.PATH ?? "/usr/bin:/bin" })),
    ].filter((path): path is string => !!path && existsSync(path))
    const programs = [...new Set(executables.flatMap(linuxProgramFiles))]
    const mounts = [...linuxSandboxBase]
    const bind = (path: string, write: boolean) => {
      if (["/", "/dev"].includes(path) || ["/proc", "/sys"].some((root) => withinFolder(root, path)))
        throw new Error("protected root")
      mounts.push(write ? "--bind" : "--ro-bind", path, path)
    }
    const canWrite = (path: string) =>
      !grants.some((folder) => folder.access === "read-only" && withinFolder(folder.path, path))
    for (const grant of grants) bind(grant.path, grant.access === "read-write")
    for (const path of writable) bind(path, canWrite(path))
    for (const grant of grants.filter((folder) => folder.access === "read-only")) bind(grant.path, false)
    // A broad project or granted home cannot expose the database, other bots or logins.
    const exposed = [...grants.map((grant) => grant.path), ...writable]
    for (const path of linuxProtectedFolders(appData ?? "/touri", homedir()).filter(existsSync)) {
      // Mask only when a broader mount would show it; otherwise it simply does not exist.
      if (!statSync(path).isDirectory() || !exposed.some((entry) => withinFolder(entry, path))) continue
      mounts.push("--tmpfs", path)
      for (const grant of grants.filter((folder) => withinFolder(path, folder.path)))
        bind(grant.path, grant.access === "read-write")
      for (const entry of writable.filter((entry) => withinFolder(path, entry))) bind(entry, canWrite(entry))
      mounts.push("--remount-ro", path)
    }
    for (const path of programs) bind(path, false)
    mounts.push(...linuxProgramLinks(executables, linuxSandboxBase), "--remount-ro", "/", "--", shell, "-c", command)
    return { cmd: binary, args: mounts }
  } catch {
    return null
  }
}
