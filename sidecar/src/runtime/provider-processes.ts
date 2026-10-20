import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Kernel } from "@touri/contracts"
import {
  ensurePrivateDirectoryAsync,
  removePrivateFileIfMatchesAsync,
  writePrivateFileAsync,
} from "../kernel/async-files"
import { readPrivateFile } from "../kernel/files"
import { runPs } from "../kernel/ps"
import { terminateWindowsProvider, windowsProviderIdentity } from "../platform/windows-native"
import type { ChildProcess } from "./provider-io"

// The CLI children have their own process groups and can outlive a crashed sidecar.
// Persist their birth identity before reading output; a reused PID must never be killed.
const identity = async (pid: number): Promise<{ birth: string; alive: boolean } | null> => {
  if (process.platform === "win32") return windowsProviderIdentity(pid)
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
      return { birth: `${fields[2]} ${fields[19]}`, alive: fields[0] !== "Z" && fields[0] !== "X" }
    } catch {
      return null
    }
  }
  const result = await runPs(["-o", "stat=,pgid=,lstart=", "-p", String(pid)], 5_000)
  const value = result?.stdout.trim() ?? ""
  const split = value.indexOf(" ")
  return result?.exitCode === 0 && split > 0 ? { birth: value.slice(split).trim(), alive: !/^[ZX]/.test(value) } : null
}

const directory = (kernel: Kernel): string => join(kernel.paths.runDir, "provider-processes")

const isAlive = async (pid: number): Promise<boolean> => {
  const current = await identity(pid)
  if (current) return current.alive
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const GROUP_KILL_GRACE_MS = 2_000

const signalGroup = (pgid: number, signal: "SIGTERM" | "SIGKILL"): boolean => {
  try {
    process.kill(-pgid, signal)
    return true
  } catch {
    return false
  }
}

/** When the provider leader exits, whatever it left in its process group (MCP shims, helpers) is stopped. */
export const reapGroupAfterExit = (child: ChildProcess): void => {
  // The Windows stdio helper's native job closes when its leader exits.
  if (process.platform === "win32") return
  void child.exited
    .then(() => {
      if (!signalGroup(child.pid, "SIGTERM")) return
      setTimeout(() => signalGroup(child.pid, "SIGKILL"), GROUP_KILL_GRACE_MS).unref()
    })
    .catch(() => undefined)
}

export const trackProviderProcess = async (kernel: Kernel, child: ChildProcess): Promise<void> => {
  if (child.target === "remote") return
  reapGroupAfterExit(child)
  const processIdentity = await identity(child.pid)
  if (!processIdentity) {
    try {
      process.kill(child.pid, 0)
    } catch {
      return
    } // The child may already have exited.
    child.kill("SIGKILL")
    throw new Error("Não foi possível identificar o processo do provedor")
  }
  if (!processIdentity.alive) return
  const birth = processIdentity.birth
  const path = join(directory(kernel), `${child.pid}.json`)
  try {
    await writePrivateFileAsync({
      root: kernel.paths.appData,
      path,
      content: JSON.stringify({ pid: child.pid, birth }),
    })
  } catch (error) {
    child.kill("SIGKILL")
    throw error
  }
  void child.exited
    .then(async () => {
      await removePrivateFileIfMatchesAsync({
        root: kernel.paths.appData,
        path,
        content: JSON.stringify({ pid: child.pid, birth }),
      })
    })
    .catch(() => undefined)
}

const getRecordNames = (dir: string): string[] => {
  try {
    return readdirSync(dir).filter((name) => /^\d+\.json$/.test(name))
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
    throw error
  }
}

export const reapProviderProcesses = async (kernel: Kernel): Promise<void> => {
  const dir = directory(kernel)
  // Read the records before the first await: a provider this sidecar tracks after startup is never an orphan.
  const names = getRecordNames(dir)
  await ensurePrivateDirectoryAsync({ root: kernel.paths.appData, path: dir })
  for (const name of names) {
    const path = join(dir, name)
    const bytes = readPrivateFile({ root: kernel.paths.appData, path, maxBytes: 8_192 })
    if (!bytes) continue
    const content = bytes.toString()
    const record = JSON.parse(content) as { pid: number; birth: string }
    if (!Number.isSafeInteger(record.pid) || record.pid <= 1 || record.pid !== Number(name.slice(0, -5))) continue
    const current = await identity(record.pid)
    if (current?.alive && current.birth === record.birth && Number(current.birth.split(/\s+/)[0]) === record.pid) {
      // Recovery does not adopt a native turn: fence it and stop its entire group.
      if (process.platform === "win32") await terminateWindowsProvider(record.pid, record.birth)
      else
        try {
          process.kill(-record.pid, "SIGKILL")
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error
        }
    }
    await removePrivateFileIfMatchesAsync({ root: kernel.paths.appData, path, content })
  }
}

export const stopProviderChildren = async (children: Set<ChildProcess>): Promise<void> => {
  const pending = [...children].filter((child) => child.target !== "remote")
  for (const child of pending) child.kill("SIGTERM")
  const timer = setTimeout(() => {
    for (const child of pending) child.kill("SIGKILL")
  }, 5_000)
  try {
    await Promise.all(
      pending.map(async (child) => {
        let exited = false
        const observed = child.exited.then(() => {
          exited = true
        })
        // Bun can miss an exit notification under load. A zombie cannot write any more
        // output, and must not leave shutdown waiting on the missed notification.
        while (!exited && (await isAlive(child.pid))) await Promise.race([observed, Bun.sleep(100)])
        children.delete(child)
      }),
    )
  } finally {
    clearTimeout(timer)
  }
}
