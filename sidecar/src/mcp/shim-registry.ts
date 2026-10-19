import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  ensurePrivateDirectoryAsync,
  removePrivateFileAsync,
  removePrivateFileIfMatchesAsync,
  writePrivateFileAsync,
} from "../kernel/async-files"
import { runPs } from "../kernel/ps"

export type ShimRecord = { pid: number; birth: string; thread: string }
export type ShimStatus = { record: ShimRecord; ppid: number }

const SHIM_COMMAND_MARKER = "mcp-stdio"
const KILL_GRACE_MS = 2_000

const shimDir = (runDir: string): string => join(runDir, "mcp-shims")

const probe = async (pid: number): Promise<{ birth: string; ppid: number; command: string } | null> => {
  // A sandboxed shim (macOS Seatbelt) may not exec the setuid ps; registration is best-effort.
  const result = await runPs(["-o", "stat=,ppid=,lstart=,command=", "-p", String(pid)], 5_000)
  if (!result) return null
  const match = result.stdout.trim().match(/^(\S+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/)
  if (result.exitCode !== 0 || !match || /^[ZX]/.test(match[1] ?? "")) return null
  return { birth: match[3] ?? "", ppid: Number(match[2]), command: match[4] ?? "" }
}

/** Records this shim in the install's private run directory so a later sweep can prove ownership. */
export const registerShim = async ({ runDir, thread }: { runDir: string; thread: string }): Promise<() => void> => {
  // Namespace PIDs do not identify host processes. The enclosing provider owns
  // and reaps this whole PID namespace; never publish these IDs to the host sweep.
  if (process.platform === "linux" && process.env.TOURI_PID_NAMESPACE === "1") return () => undefined
  const current = await probe(process.pid)
  if (!current) return () => undefined
  const path = join(shimDir(runDir), `${process.pid}.json`)
  try {
    await ensurePrivateDirectoryAsync({ root: runDir, path: shimDir(runDir) })
    await writePrivateFileAsync({
      root: runDir,
      path,
      content: JSON.stringify({ pid: process.pid, birth: current.birth, thread }),
    })
  } catch {
    return () => undefined
  }
  return () => {
    void removePrivateFileAsync({ root: runDir, path }).catch(() => {})
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

const verified = async (record: ShimRecord): Promise<{ ppid: number } | null> => {
  const current = await probe(record.pid)
  if (!current || current.birth !== record.birth || !current.command.includes(SHIM_COMMAND_MARKER)) return null
  return { ppid: current.ppid }
}

const forget = async (runDir: string, path: string, record: ShimRecord): Promise<void> => {
  await removePrivateFileIfMatchesAsync({ root: runDir, path, content: JSON.stringify(record) }).catch(() => {})
}

/** Lists shims recorded by this install that are still alive; stale records are dropped. */
export const listLiveShims = async (runDir: string): Promise<Array<ShimStatus>> => {
  const live: Array<ShimStatus> = []
  for (const { path, record } of readRecords(runDir)) {
    const current = await verified(record)
    if (current) live.push({ record, ppid: current.ppid })
    else await forget(runDir, path, record)
  }
  return live
}

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
export const reapOrphanShims = async (runDir: string): Promise<Array<number>> =>
  (await listLiveShims(runDir)).map(({ record }) => {
    killShim(record.pid)
    return record.pid
  })
