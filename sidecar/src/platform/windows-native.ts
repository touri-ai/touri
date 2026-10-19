import { join } from "node:path"
import type { AppPaths } from "@touri/contracts"
import { TouriError } from "../kernel/errors"
import { withDeadline } from "../kernel/policy"
import { buildChildEnv } from "../kernel/shell-env"
import { runHelperBlocking } from "./helper-worker"

export const desktopHelper = (): string => {
  const helper = process.env.TOURI_DESKTOP_HELPER
  if (!helper) throw new Error("Windows runtime requires the installed desktop helper (TOURI_DESKTOP_HELPER)")
  return helper
}

const nativeProcessOperation = async (args: string[]): Promise<unknown> => {
  const child = Bun.spawn({
    cmd: [desktopHelper(), ...args],
    stdout: "pipe",
    stderr: "ignore",
    env: buildChildEnv(),
  })
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000)
  try {
    const [text, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
    const response = JSON.parse(text) as { ok?: boolean; value?: unknown }
    if (exitCode !== 0 || response.ok !== true) throw new TouriError("TOURI-E2001")
    return response.value
  } catch {
    throw new TouriError("TOURI-E2001")
  } finally {
    clearTimeout(timer)
  }
}

export const windowsProviderIdentity = async (pid: number): Promise<{ birth: string; alive: boolean } | null> => {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new TouriError("TOURI-E2000")
  const value = await nativeProcessOperation(["--process-identity", String(pid)])
  if (value === null) return null
  const result = value as { birth?: unknown; alive?: unknown }
  if (typeof result?.birth !== "string" || !result.birth.startsWith(`${pid} `) || typeof result.alive !== "boolean")
    throw new TouriError("TOURI-E2001")
  return { birth: result.birth, alive: result.alive }
}

export const terminateWindowsProvider = async (pid: number, birth: string): Promise<void> => {
  if (!Number.isSafeInteger(pid) || pid <= 1 || !birth.startsWith(`${pid} `)) throw new TouriError("TOURI-E2000")
  if (typeof (await nativeProcessOperation(["--terminate-process", String(pid), birth])) !== "boolean")
    throw new TouriError("TOURI-E2001")
}

export const nativeFileOperation = <T>(
  op: string,
  input: { root: string; path: string; content?: string; to?: string; target?: string; max_bytes?: number },
): T => {
  const child = runHelperBlocking({
    command: [desktopHelper(), "--native-fs"],
    input: JSON.stringify({ op, ...input }),
    env: buildChildEnv(),
    maxResponseBytes: op.startsWith("read")
      ? Math.min(64 * 1024 * 1024, Math.ceil(((input.max_bytes ?? 32 * 1024 * 1024) * 4) / 3) + 16_384)
      : 1024 * 1024,
  })
  let response: { ok?: boolean; value?: T; code?: string }
  try {
    response = JSON.parse(child.stdout)
  } catch {
    throw new TouriError("TOURI-E2001")
  }
  if (!response.ok)
    throw new TouriError(
      response.code === "TOURI-E2000" ? "TOURI-E2000" : response.code === "TOURI-E2002" ? "TOURI-E2002" : "TOURI-E2001",
    )
  return response.value as T
}

export const acquireWindowsRuntimeLock = async (
  paths: AppPaths,
  timeoutMs = 10_000,
): Promise<{ release: () => void }> => {
  const started = Date.now()
  while (true) {
    const child = Bun.spawn({
      cmd: [desktopHelper(), "--native-lock"],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: buildChildEnv(),
    })
    child.stdin.write(
      `${JSON.stringify({ op: "lock", root: paths.appData, path: join(paths.runDir, "runtime.lock") })}\n`,
    )
    child.stdin.flush()
    const reader = child.stdout.getReader()
    let ready = false
    try {
      ready = await withDeadline({
        timeoutMs: Math.min(timeoutMs, 3000),
        operation: async () => {
          let text = ""
          while (!text.includes("\n") && text.length < 4096) {
            const chunk = await reader.read()
            if (chunk.done) break
            text += new TextDecoder().decode(chunk.value)
          }
          return text.trim() === "locked"
        },
      })
    } catch {
      /* An exited or wedged helper cannot grant a lease. */
    } finally {
      reader.releaseLock()
    }
    if (ready) {
      let released = false
      void child.exited.then(() => {
        if (!released) {
          if (process.listenerCount("SIGTERM")) process.emit("SIGTERM")
          else process.exit(1)
        }
      })
      return {
        release: () => {
          released = true
          child.stdin.end()
        },
      }
    }
    child.kill()
    await child.exited
    if (Date.now() - started >= timeoutMs)
      throw new Error("Another runtime owns this data directory, or the native Windows lock is unavailable")
    await Bun.sleep(50)
  }
}

export const watchWindowsParent = (shutdown: () => void, parentPid: number): (() => void) => {
  if (!Number.isSafeInteger(parentPid) || parentPid <= 1) {
    shutdown()
    return () => {}
  }
  const child = Bun.spawn({
    cmd: [desktopHelper(), "--watch-parent", String(parentPid)],
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
    env: buildChildEnv(),
  })
  let stopped = false
  const keepAlive = setInterval(() => {
    void child.pid
  }, 1000)
  keepAlive.unref()
  void child.exited.then(() => {
    clearInterval(keepAlive)
    if (!stopped) shutdown()
  })
  return () => {
    stopped = true
    clearInterval(keepAlive)
    child.stdin.end()
    child.kill()
  }
}
