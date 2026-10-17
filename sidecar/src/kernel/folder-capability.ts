import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Bot } from "@touri/contracts"
import { linuxSystemLinks } from "../platform/linux-programs"
import { canonicalPath, excludedBotFolders, resolveBotFolder, specificFoldersRequired } from "./bot-folders"

export { specificFoldersRequired } from "./bot-folders"

export const folderAccessUnavailable =
  "Este computador não consegue proteger o acesso a pastas. Nenhuma permissão foi adicionada. Você pode continuar conversando ou enviar um arquivo."

export const linuxProtectedFolders = (appData: string, home = homedir()): string[] => [
  ...new Set(
    [
      ...excludedBotFolders(appData, home),
      join(home, ".config"),
      join(home, ".local/share/keyrings"),
      join(home, ".gnupg"),
    ].map(canonicalPath),
  ),
]

export const folderGrantProblem = (bot: Pick<Bot, "machine" | "folders" | "anyFolderAccess">): string | null => {
  if (bot.machine !== "local" || (!bot.anyFolderAccess && !bot.folders?.length)) return null
  if (!hostFolderAccessAvailable()) return folderAccessUnavailable
  if (process.platform === "linux" && (bot.anyFolderAccess || bot.folders?.some((folder) => folder.path === "/")))
    return specificFoldersRequired
  try {
    if (bot.folders?.some((folder) => resolveBotFolder(folder.path, false) !== folder.path))
      return folderAccessUnavailable
  } catch {
    return folderAccessUnavailable
  }
  return null
}

// Keep this policy shared by the probe and every provider process. A binary on
// PATH alone is insufficient: containers can prohibit user/PID namespaces.
export const linuxSandboxBase = [
  "--die-with-parent",
  "--new-session",
  "--unshare-user",
  "--unshare-pid",
  "--unshare-ipc",
  "--unshare-uts",
  "--cap-drop",
  "ALL",
  // bwrap starts with an empty root. Never expose the host root, even read-only.
  ...["/usr/bin", "/usr/sbin", "/usr/lib", "/usr/lib64", "/usr/share/zoneinfo", "/usr/share/locale"]
    .filter(existsSync)
    .flatMap((path) => ["--ro-bind", path, path]),
  ...linuxSystemLinks(["/bin", "/sbin", "/lib", "/lib64"]),
  ...[
    "/etc/ld.so.cache",
    "/etc/alternatives",
    "/etc/resolv.conf",
    "/etc/hosts",
    "/etc/nsswitch.conf",
    "/etc/gai.conf",
    "/etc/localtime",
    "/etc/ssl/certs",
    "/etc/pki/tls/certs",
    "/usr/share/ca-certificates",
  ]
    .filter(existsSync)
    .flatMap((path) => ["--ro-bind", path, path]),
  "--proc",
  "/proc",
  "--dev",
  "/dev",
  // Host control sockets must not cross the filesystem boundary.
  "--tmpfs",
  "/run",
  "--tmpfs",
  "/tmp",
  "--tmpfs",
  "/var/tmp",
  "--tmpfs",
  "/touri",
  ...["home", "config", "cache", "state"].flatMap((directory) => ["--dir", `/touri/${directory}`]),
]

export const linuxSandboxBinary = (): string | null =>
  process.platform === "linux" ? Bun.which("bwrap", { PATH: "/usr/bin:/bin" }) : null

let linuxSandboxReady = false
let probing: Promise<void> | undefined

// The synchronous read is safe inside approval/configuration transactions. A
// synchronous subprocess in Bun can re-enter JS while an approval is committing.
export const hostFolderAccessAvailable = (): boolean =>
  process.platform === "darwin" ? existsSync("/usr/bin/sandbox-exec") : linuxSandboxReady && !!linuxSandboxBinary()

export const refreshHostFolderAccess = async (): Promise<boolean> => {
  if (process.platform !== "linux") return hostFolderAccessAvailable()
  if (!probing)
    probing = (async () => {
      const binary = linuxSandboxBinary()
      if (!binary) {
        linuxSandboxReady = false
        return
      }
      try {
        const child = Bun.spawn({
          cmd: [binary, ...linuxSandboxBase, "--", "/bin/true"],
          stdout: "ignore",
          stderr: "ignore",
        })
        const timeout = setTimeout(() => child.kill("SIGKILL"), 2000)
        try {
          linuxSandboxReady = (await child.exited) === 0
        } finally {
          clearTimeout(timeout)
        }
      } catch {
        linuxSandboxReady = false
      }
    })().finally(() => {
      probing = undefined
    })
  await probing
  return hostFolderAccessAvailable()
}
