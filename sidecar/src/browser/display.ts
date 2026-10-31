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
    const display = await Promise.race([getDisplayNumber(reader), spawned.exited.then(() => null)])
    if (!display) {
      await stop()
      return null
    }
    return { env: Object.assign({}, env, { DISPLAY: `:${display}` }), stop }
  } catch {
    await stop()
    return null
  } finally {
    clearTimeout(timer)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

const getDisplayNumber = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string | null> => {
  let line = ""
  // The server writes the digits and newline separately; closing between them can kill it with SIGPIPE.
  while (true) {
    const chunk = await reader.read()
    if (chunk.done || chunk.value.length > 6 - line.length) return null
    line += new TextDecoder().decode(chunk.value)
    if (line.endsWith("\n")) return /^\d{1,5}\n$/u.test(line) ? line.slice(0, -1) : null
    if (!/^\d{1,5}$/u.test(line)) return null
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
