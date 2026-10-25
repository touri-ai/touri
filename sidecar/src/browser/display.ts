import type { Kernel } from "@touri/contracts"
import { discardStream } from "../kernel/streams"

type DisplayProcess = Extract<ReturnType<Kernel["spawnTree"]>, { success: true }>

/** Xvfb chooses its own free display; this launcher owns and stops only that child. */
export const startBrowserDisplay = async (
  kernel: Kernel,
  env: Record<string, string>,
): Promise<{ env: Record<string, string>; stop: () => Promise<void> } | null> => {
  const spawned = kernel.spawnTree({
    cmd: "Xvfb",
    args: ["-displayfd", "1", "-screen", "0", "3840x2160x24", "-nolisten", "tcp", "-noreset"],
    cwd: kernel.paths.browserDir,
    env,
  })
  if (!spawned.success) return null
  void discardStream(spawned.stderr)
  const stop = () => stopDisplay(spawned)
  const reader = spawned.stdout.getReader()
  const timer = setTimeout(() => spawned.kill("SIGTERM"), 5000)
  try {
    const result = await Promise.race([reader.read(), spawned.exited.then(() => null)])
    const display = result?.value ? new TextDecoder().decode(result.value).trim() : ""
    if (!/^\d{1,5}$/u.test(display)) {
      await stop()
      return null
    }
    void reader.cancel().catch(() => undefined)
    return { env: Object.assign({}, env, { DISPLAY: `:${display}` }), stop }
  } catch {
    await stop()
    return null
  } finally {
    clearTimeout(timer)
  }
}

const stopDisplay = async (spawned: DisplayProcess): Promise<void> => {
  spawned.kill("SIGTERM")
  const timer = setTimeout(() => spawned.kill("SIGKILL"), 2000)
  try {
    await spawned.exited
  } finally {
    clearTimeout(timer)
  }
}
