import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export type ShimRecord = { pid: number; birth: string; thread: string }
export type ShimStatus = { record: ShimRecord; ppid: number }

const SHIM_COMMAND_MARKER = "mcp-stdio"
const KILL_GRACE_MS = 2_000

const shimDir = (runDir: string): string => join(runDir, "mcp-shims")

const runPs = (pid: number) => {
  try {
    return Bun.spawnSync({
      cmd: ["/bin/ps", "-o", "stat=,ppid=,lstart=,command=", "-p", String(pid)],
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      stdout: "pipe",
      stderr: "ignore",
      timeout: 5_000,
    })
  } catch {
    // A sandboxed shim (macOS Seatbelt) may not exec the setuid ps; registration is best-effort.
    return null
  }
}

const probe = (pid: number): { birth: string; ppid: number; command: string } | null => {
  const result = runPs(pid)
  if (!result) return null
  const match = result.stdout
    .toString()
    .trim()
    .match(/^(\S+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/)
  if (result.exitCode !== 0 || !match || /^[ZX]/.test(match[1] ?? "")) return null
  return { birth: match[3] ?? "", ppid: Number(match[2]), command: match[4] ?? "" }
}

/** Records this shim in the install's private run directory so a later sweep can prove ownership. */
export const registerShim = ({ runDir, thread }: { runDir: string; thread: string }): (() => void) => {
  const current = probe(process.pid)
  if (!current) return () => undefined
  const path = join(shimDir(runDir), `${process.pid}.json`)
  try {
    mkdirSync(shimDir(runDir), { recursive: true, mode: 0o700 })
    writeFileSync(path, JSON.stringify({ pid: process.pid, birth: current.birth, thread }), { mode: 0o600 })
  } catch {
    return () => undefined
  }
  return () => {
    try {
      unlinkSync(path)
    } catch {}
  }
}

const readRecords = (runDir: string): Array<{ path: string; record: ShimRecord }> => {
  const dir = shimDir(runDir)
  try {
    return readdirSync(dir)
      .filter((name) => /^\d+\.json$/.test(name))
      .flatMap((name) => {
        try {
          const record = JSON.parse(readFileSync(join(dir, name), "utf8")) as ShimRecord
          return record.pid === Number(name.slice(0, -5)) && Number.isSafeInteger(record.pid) && record.pid > 1
            ? [{ path: join(dir, name), record }]
            : []
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

const verified = (record: ShimRecord): { ppid: number } | null => {
  const current = probe(record.pid)
  if (!current || current.birth !== record.birth || !current.command.includes(SHIM_COMMAND_MARKER)) return null
  return { ppid: current.ppid }
}

const forget = (path: string): void => {
  try {
    unlinkSync(path)
  } catch {}
}

/** Lists shims recorded by this install that are still alive; stale records are dropped. */
export const listLiveShims = (runDir: string): Array<ShimStatus> =>
  readRecords(runDir).flatMap(({ path, record }) => {
    const live = verified(record)
    if (live) return [{ record, ppid: live.ppid }]
    forget(path)
    return []
  })

const killShim = (pid: number): void => {
  try {
    process.kill(pid, "SIGTERM")
  } catch {
    return
  }
  const timer = setTimeout(() => {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }, KILL_GRACE_MS)
  timer.unref()
}

/** Terminates leftover shims of this install (record + birth + command all match). Returns the pids signaled. */
export const reapOrphanShims = (runDir: string): Array<number> =>
  listLiveShims(runDir).map(({ record }) => {
    killShim(record.pid)
    return record.pid
  })
