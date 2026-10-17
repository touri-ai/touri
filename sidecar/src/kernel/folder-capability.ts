import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Bot } from "@touri/contracts"
import { canonicalPath, excludedBotFolders } from "./bot-folders"

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
  "--ro-bind",
  "/",
  "/",
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
