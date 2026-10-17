import type { Kernel } from "@touri/contracts"
import { buildChildEnv } from "../kernel/shell-env"
import { applyProviderPrivacy } from "../runtime/privacy"
import { withinDeadline } from "./network"

export type CommandResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean }
export type DoctorCommand = (command: string, args: Array<string>, signal: AbortSignal) => Promise<CommandResult>

const readBounded = async (stream: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<string> => {
  const reader = stream.getReader()
  const cancel = () => void reader.cancel().catch(() => undefined)
  signal.addEventListener("abort", cancel, { once: true })
  if (signal.aborted) cancel()
  const decoder = new TextDecoder()
  let output = ""
  let remaining = 16_384
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      const part = chunk.value.subarray(0, remaining)
      output += decoder.decode(part, { stream: true })
      remaining -= part.length
    }
    return output + decoder.decode()
  } finally {
    signal.removeEventListener("abort", cancel)
    try {
      reader.releaseLock()
    } catch {
      // Bun can release a subprocess pipe's reader during process teardown.
    }
  }
}

export const createDoctorCommand =
  (kernel: Pick<Kernel, "spawnTree" | "paths">, environment: Record<string, string>, timeoutMs = 4000): DoctorCommand =>
  async (command, args, signal) => {
    signal.throwIfAborted()
    if (
      process.env.TOURI_DOCTOR_SKIP_PROVIDER_PROBES === "1" &&
      /(?:^|[\\/])(claude|codex|opencode)(?:\.exe)?$/.test(command)
    )
      return { code: 127, stdout: "", stderr: "Provider probes disabled", timedOut: false }
    const child = kernel.spawnTree({
      cmd: command,
      args,
      cwd: kernel.paths.appData,
      env: applyProviderPrivacy(buildChildEnv({ base: environment })),
    })
    if (!child.success) return { code: 127, stdout: "", stderr: "", timedOut: false }
    const stdin = child.stdin.getWriter()
    void stdin
      .close()
      .catch(() => undefined)
      .finally(() => stdin.releaseLock())
    const cleanup = new AbortController()
    try {
      return await withinDeadline(
        async (probeSignal) => {
          const cancel = () => child.kill("SIGKILL")
          probeSignal.addEventListener("abort", cancel, { once: true })
          if (probeSignal.aborted) cancel()
          try {
            const [stdout, stderr, exit] = await Promise.all([
              readBounded(child.stdout, probeSignal),
              readBounded(child.stderr, probeSignal),
              child.exited,
            ])
            probeSignal.throwIfAborted()
            return { code: exit.code, stdout, stderr, timedOut: false }
          } finally {
            probeSignal.removeEventListener("abort", cancel)
          }
        },
        AbortSignal.any([signal, cleanup.signal]),
        timeoutMs,
      )
    } catch (error) {
      child.kill("SIGKILL")
      signal.throwIfAborted()
      return {
        code: null,
        stdout: "",
        stderr: "",
        timedOut: error instanceof DOMException && error.name === "TimeoutError",
      }
    } finally {
      cleanup.abort()
    }
  }
