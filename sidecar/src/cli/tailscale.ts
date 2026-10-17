import { withToolPath } from "../kernel/shell-env"
import { tailscaleHttpsPort } from "./args"

export type CommandOutput = { code: number; stdout: string; stderr: string }
export type RunCommand = (cmd: string, args: Array<string>) => Promise<CommandOutput>

export type TailscaleExposeSuccess = { success: true; url: string; alreadyConfigured: boolean }
export type TailscaleExposeError = { success: false; error: string }
export type TailscaleExposeResult = TailscaleExposeSuccess | TailscaleExposeError

export const runCommand: RunCommand = async (cmd, args) => {
  try {
    const child = Bun.spawn([cmd, ...args], { env: withToolPath(), stdout: "pipe", stderr: "pipe", stdin: "ignore" })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { code, stdout, stderr }
  } catch (error) {
    return { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) }
  }
}

type ServeConfig = { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> }

/** Returns the proxy target configured for `host:port`, or null when that port is free. */
export const proxyTargetsForPort = ({ config, port }: { config: ServeConfig; port: number }): Array<string> =>
  Object.entries(config.Web ?? {})
    .filter(([hostPort]) => hostPort.endsWith(`:${port}`))
    .flatMap(([, web]) => Object.values(web.Handlers ?? {}).map((handler) => handler.Proxy ?? "(non-proxy handler)"))

export const parseDnsName = (statusJson: string): string | null => {
  try {
    const parsed = JSON.parse(statusJson) as { Self?: { DNSName?: string } }
    const name = parsed.Self?.DNSName?.replace(/\.$/, "")
    return name && name.length > 0 ? name : null
  } catch {
    return null
  }
}

const parseServeConfig = (stdout: string): ServeConfig => {
  try {
    return JSON.parse(stdout || "{}") as ServeConfig
  } catch {
    return {}
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
}: {
  localPort: number
  run?: RunCommand
  httpsPort?: number
}): Promise<TailscaleExposeResult> => {
  const target = `http://127.0.0.1:${localPort}`
  const status = await run("tailscale", ["status", "--json"])
  if (status.code !== 0)
    return { success: false, error: `tailscale status failed: ${status.stderr.trim() || "not running"}` }
  const dns = parseDnsName(status.stdout)
  if (!dns) return { success: false, error: "tailscale did not report a DNS name for this machine" }
  const current = await run("tailscale", ["serve", "status", "--json"])
  const existing = proxyTargetsForPort({ config: parseServeConfig(current.stdout), port: httpsPort })
  const foreign = existing.filter((proxy) => proxy !== target)
  if (foreign.length > 0)
    return {
      success: false,
      error: `tailscale :${httpsPort} already serves ${foreign.join(", ")}; refusing to change it`,
    }
  const url = `https://${dns}:${httpsPort}/`
  if (existing.length > 0) return { success: true, url, alreadyConfigured: true }
  const applied = await run("tailscale", ["serve", "--bg", `--https=${httpsPort}`, target])
  if (applied.code !== 0)
    return { success: false, error: `tailscale serve failed: ${(applied.stderr || applied.stdout).trim()}` }
  return { success: true, url, alreadyConfigured: false }
}
