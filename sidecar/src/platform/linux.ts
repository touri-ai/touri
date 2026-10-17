import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { posix } from "node:path"

const { join } = posix
export const defaultDataRoot = (home = homedir(), env = process.env) =>
  env.TOURI_HEADLESS === "1" ? join(home, ".touri") : join(env.XDG_DATA_HOME || join(home, ".local", "share"), "touri")
export const secretStoreLabel = "Secret Service"
export const secretStoreFix =
  "Unlock your desktop keyring and ensure a Secret Service (for example GNOME Keyring or KeePassXC) is running on the session D-Bus"
export const appOpenCommand = "touri"
export const installTools = [
  ["git", "Install git with your distribution package manager"],
  ["node", "Install Node.js 22 or newer"],
  ["pnpm", "npm install -g pnpm"],
  ["podman", "Install rootless Podman and enable unprivileged user namespaces"],
  ["docker", "Install Docker Engine or Docker Desktop"],
]

export const systemSettingsCommand = "Review system network and proxy settings"

export type ProcessIdentity = { startTime: string; parentPid: number; alive: boolean }
/** /proc start ticks identify PID reuse without launching a subprocess during startup. */
export const parseProcessIdentity = (pid: number, stat: string): ProcessIdentity | null => {
  const start = stat.indexOf("(")
  const end = stat.lastIndexOf(")")
  if (start < 1 || end <= start || Number(stat.slice(0, start).trim()) !== pid) return null
  const fields = stat
    .slice(end + 1)
    .trim()
    .split(/\s+/)
  const parentPid = Number(fields[1])
  const ticks = fields[19]
  if (!Number.isSafeInteger(parentPid) || parentPid < 0 || !ticks || !/^\d+$/.test(ticks)) return null
  return { startTime: `linux:${ticks}`, parentPid, alive: !/^[ZX]$/.test(fields[0] ?? "") }
}
export const processIdentity = (pid: number): ProcessIdentity | null => {
  if (!Number.isSafeInteger(pid) || pid < 1) return null
  try {
    return parseProcessIdentity(pid, readFileSync(`/proc/${pid}/stat`, "utf8"))
  } catch {
    return null
  }
}
