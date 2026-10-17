import { win32 } from "node:path"
import type { Kernel } from "@touri/contracts"
import { runPs } from "../kernel/ps"
import { buildChildEnv } from "../kernel/shell-env"
import { spawnTree } from "../kernel/spawn"
import { macosProviderLoginPty } from "./macos/provider-login"

export type ProviderLoginPty =
  | { supported: true; command: string; args: string[]; env?: Record<string, string> }
  | { supported: false; message: string }
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
/** Stdio stays a byte stream; the adapter supplies the provider's actual console. */
export const providerLoginPty = (
  platform: string,
  command: string,
  args: string[],
  helper = process.env.TOURI_DESKTOP_HELPER,
): ProviderLoginPty => {
  if (platform === "darwin") return macosProviderLoginPty(command, args)
  if (platform === "linux")
    return {
      supported: true,
      command: "script",
      args: ["--quiet", "--return", "--flush", "--command", [command, ...args].map(quote).join(" "), "/dev/null"],
    }
  if (platform === "win32" && helper && win32.isAbsolute(helper))
    return { supported: true, command: helper, args: ["--provider-login-pty", "--", command, ...args] }
  return {
    supported: false,
    message:
      "The desktop ConPTY helper is unavailable. Start the installed desktop app, or log in in your terminal and import credentials in provider settings.",
  }
}

export const spawnProviderLoginPty = ({
  command,
  args,
  cwd,
  env = process.env,
  platform = process.platform,
  spawn = spawnTree,
}: {
  command: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  platform?: string
  spawn?: Kernel["spawnTree"]
}): ReturnType<Kernel["spawnTree"]> => {
  const pty = providerLoginPty(platform, command, args, env.TOURI_DESKTOP_HELPER ?? "")
  return pty.supported
    ? spawn({ cmd: pty.command, args: pty.args, cwd, env: buildChildEnv({ base: env, overrides: pty.env ?? {} }) })
    : { success: false, errorCode: "SPAWN_FAILED", error: pty.message }
}

export const killProviderLoginPty = async (
  child: Extract<ReturnType<Kernel["spawnTree"]>, { success: true }>,
): Promise<void> => {
  try {
    if (process.platform === "win32") return
    // PTY helpers may put their CLI in another process group. Stop descendants before the helper.
    // A stopped helper stays their parent while the asynchronous scan runs (#121).
    try {
      process.kill(child.pid, "SIGSTOP")
    } catch {}
    const result = await runPs(["-axo", "pid=,ppid="], 1000)
    const rows = (result?.stdout ?? "")
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number))
    const descendants = new Set([child.pid])
    for (let pass = 0; pass < rows.length; pass++) {
      let added = false
      for (const [pid, parent] of rows)
        if (pid && parent && descendants.has(parent) && !descendants.has(pid)) {
          descendants.add(pid)
          added = true
        }
      if (!added) break
    }
    for (const pid of [...descendants].reverse())
      if (pid !== child.pid) {
        try {
          process.kill(pid, "SIGKILL")
        } catch {}
      }
  } catch {
  } finally {
    child.kill("SIGKILL")
  }
}
