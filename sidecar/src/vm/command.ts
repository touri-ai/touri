import { withToolPath } from "../kernel/shell-env"
import type { VmProviderErrorCode } from "./types"

export type VmCommandOutput = {
  code: number
  stdout: string
  stderr: string
}

export type VmCommandRunner = (
  args: Array<string>,
  options?: { signal?: AbortSignal; timeoutMs?: number },
) => Promise<VmCommandOutput>

const boundedOutput = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let output = ""
  let remaining = 1_048_576
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (remaining > 0) {
        const part = next.value.subarray(0, remaining)
        output += decoder.decode(part, { stream: true })
        remaining -= part.length
      }
    }
    return output + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

export const createVmCommandRunner =
  ({ binary, timeoutMs = 45_000 }: { binary: string; timeoutMs?: number }): VmCommandRunner =>
  async (args, { signal, timeoutMs: commandTimeoutMs = timeoutMs } = {}) => {
    try {
      signal?.throwIfAborted()
      const child = Bun.spawn({ cmd: [binary, ...args], env: withToolPath(), stdout: "pipe", stderr: "pipe" })
      const cancel = () => child.kill("SIGKILL")
      signal?.addEventListener("abort", cancel, { once: true })
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill("SIGKILL")
      }, commandTimeoutMs)
      try {
        const [stdout, stderr, code] = await Promise.all([
          boundedOutput(child.stdout),
          boundedOutput(child.stderr),
          child.exited,
        ])
        signal?.throwIfAborted()
        return { code, stdout, stderr: timedOut ? `container command timed out after ${commandTimeoutMs}ms` : stderr }
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener("abort", cancel)
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      return {
        code: 127,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      }
    }
  }

export const commandError = ({
  output,
  action,
}: {
  output: VmCommandOutput
  action: string
}): {
  success: false
  errorCode: VmProviderErrorCode
  error: string
} => {
  const detail = output.stderr.trim().replace(/\s+/g, " ").slice(0, 1000)
  const serviceDown =
    /XPC|container system (?:service|start)|service (?:is )?(?:not running|not active|unavailable)|failed to list containers/i.test(
      detail,
    )
  const missing = output.code === 127 || /enoent|not found|no such file/i.test(detail)
  return {
    success: false,
    errorCode:
      serviceDown || (!missing && (action === "container list" || action === "container system status"))
        ? "MACHINE_SERVICE_UNAVAILABLE"
        : missing
          ? "TOOL_MISSING"
          : "COMMAND_FAILED",
    error: detail.length > 0 ? `${action} failed: ${detail}` : `${action} failed with exit code ${output.code}`,
  }
}
