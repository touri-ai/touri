import { withToolPath } from "../kernel/shell-env"
import { tailscaleHttpsPort } from "./args"

export type CommandOutput = { code: number; stdout: string; stderr: string }
export type RunCommand = (cmd: string, args: Array<string>, signal?: AbortSignal) => Promise<CommandOutput>

export type TailscaleExposeSuccess = { success: true; url: string; alreadyConfigured: boolean }
export type TailscaleExposeError = { success: false; error: string }
export type TailscaleExposeResult = TailscaleExposeSuccess | TailscaleExposeError

export const runCommand: RunCommand = async (cmd, args, signal) => {
  const deadline = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(5_000)])
  try {
    const child = Bun.spawn([cmd, ...args], { env: withToolPath(), stdout: "pipe", stderr: "pipe", stdin: "ignore" })
    const stop = () => child.kill("SIGKILL")
    deadline.addEventListener("abort", stop, { once: true })
    if (deadline.aborted) stop()
    try {
      const [stdout, stderr, code] = await Promise.all([
        getBoundedOutput(child.stdout, stop),
        getBoundedOutput(child.stderr, stop),
        child.exited,
      ])
      return { code: deadline.aborted ? 124 : code, stdout, stderr }
    } finally {
      deadline.removeEventListener("abort", stop)
    }
  } catch {
    return { code: 127, stdout: "", stderr: "Command unavailable" }
  }
}

const getBoundedOutput = async (stream: ReadableStream<Uint8Array>, stop: () => void): Promise<string> => {
  const reader = stream.getReader()
  const chunks: Array<Uint8Array> = []
  let bytes = 0
  // The output buffer is local and capped before parsing external command output.
  while (true) {
    const next = await reader.read()
    if (next.done) return new TextDecoder().decode(Buffer.concat(chunks))
    bytes += next.value.byteLength
    if (bytes > 1_048_576) {
      stop()
      await reader.cancel()
      return ""
    }
    chunks.push(next.value)
  }
}

type ServeConfig = {
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>
  TCP?: Record<string, { HTTPS?: boolean; HTTP?: boolean; TCPForward?: string }>
  Foreground?: Record<string, ServeConfig>
}

/** Existing TCP and foreground handlers also reserve their port. */
export const proxyTargetsForPort = ({ config, port }: { config: ServeConfig; port: number }): Array<string> => {
  const web = Object.entries(config.Web ?? {})
    .filter(([hostPort]) => hostPort.endsWith(`:${port}`))
    .flatMap(([, server]) => {
      const handlers = Object.values(server.Handlers ?? {})
      if (handlers.length === 0) return ["(non-proxy handler)"]
      return handlers.map((handler) => handler.Proxy ?? "(non-proxy handler)")
    })
  const tcp = config.TCP?.[String(port)]
  const reserved = tcp && (tcp.TCPForward || web.length === 0) ? ["(TCP handler)"] : []
  const foreground = Object.values(config.Foreground ?? {}).flatMap((child) =>
    proxyTargetsForPort({ config: child, port }),
  )
  return [...web, ...reserved, ...foreground]
}

export const parseDnsName = (statusJson: string): string | null => {
  try {
    const parsed = JSON.parse(statusJson) as { Self?: { DNSName?: string } }
    const name = parsed.Self?.DNSName?.replace(/\.$/, "")
    return name && name.length > 0 ? name : null
  } catch {
    return null
  }
}

const getServeConfig = (stdout: string): ServeConfig | null => {
  try {
    const value: unknown = JSON.parse(stdout)
    if (!isServeConfig(value)) return null
    return value
  } catch {
    return null
  }
}

/**
 * Publishes the local server on the tailnet over HTTPS (never Funnel). It only adds the handler
 * for its own port and refuses to touch a port that already proxies somewhere else.
 */
export const exposeOnTailscale = async ({
  localPort,
  run = runCommand,
  httpsPort = tailscaleHttpsPort,
  previousLocalPort,
}: {
  localPort: number
  run?: RunCommand
  httpsPort?: number
  previousLocalPort?: number | undefined
}): Promise<TailscaleExposeResult> => {
  const target = `http://127.0.0.1:${localPort}`
  const status = await run("tailscale", ["status", "--json"])
  if (status.code !== 0)
    return { success: false, error: `tailscale status failed: ${status.stderr.trim() || "not running"}` }
  const dns = parseDnsName(status.stdout)
  if (!dns) return { success: false, error: "tailscale did not report a DNS name for this machine" }
  const current = await run("tailscale", ["serve", "status", "--json"])
  const config = getServeConfig(current.stdout)
  if (current.code !== 0 || !config) return { success: false, error: "tailscale serve configuration unavailable" }
  const existing = proxyTargetsForPort({ config, port: httpsPort })
  const previousTarget = previousLocalPort ? `http://127.0.0.1:${previousLocalPort}` : null
  const foreign = existing.filter((proxy) => proxy !== target && proxy !== previousTarget)
  if (foreign.length > 0)
    return {
      success: false,
      error: `tailscale :${httpsPort} already serves ${foreign.join(", ")}; refusing to change it`,
    }
  const url = `https://${dns}:${httpsPort}/`
  if (existing.length > 0 && existing.every((proxy) => proxy === target))
    return { success: true, url, alreadyConfigured: true }
  const applied = await run("tailscale", ["serve", "--bg", `--https=${httpsPort}`, target])
  if (applied.code !== 0)
    return { success: false, error: `tailscale serve failed: ${(applied.stderr || applied.stdout).trim()}` }
  return { success: true, url, alreadyConfigured: false }
}

/** Only remove the handler that still points at this runtime. */
export const stopTailscaleAccess = async (localPort: number, run: RunCommand = runCommand): Promise<boolean> => {
  const current = await run("tailscale", ["serve", "status", "--json"])
  if (current.code !== 0) return false
  const config = getServeConfig(current.stdout)
  if (!config) return false
  const targets = proxyTargetsForPort({ config, port: tailscaleHttpsPort })
  if (targets.length === 0) return true
  if (targets.some((target) => target !== `http://127.0.0.1:${localPort}`)) return false

  const stopped = await run("tailscale", ["serve", `--https=${tailscaleHttpsPort}`, "off"])
  return stopped.code === 0
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value))

const isServeConfig = (value: unknown, depth = 0): value is ServeConfig => {
  if (!isRecord(value) || depth > 1) return false
  const web = value.Web ?? {}
  const tcp = value.TCP ?? {}
  const foreground = value.Foreground ?? {}
  if (!isRecord(web) || !isRecord(tcp) || !isRecord(foreground)) return false
  if (Object.keys(web).length > 1024 || Object.keys(tcp).length > 1024 || Object.keys(foreground).length > 128)
    return false
  const hasValidWeb = Object.values(web).every(
    (server) =>
      isRecord(server) &&
      isRecord(server.Handlers ?? {}) &&
      Object.values(server.Handlers ?? {}).every(
        (handler) => isRecord(handler) && (handler.Proxy === undefined || typeof handler.Proxy === "string"),
      ),
  )
  return (
    hasValidWeb &&
    Object.values(tcp).every(isRecord) &&
    Object.values(foreground).every((child) => isServeConfig(child, depth + 1))
  )
}
