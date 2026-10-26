import type { DiscoveredServer, OnboardingStatus } from "@touri/contracts"
import { type RunCommand, runCommand } from "../cli/tailscale"

type Tailnet = { BackendState?: string; Self?: Peer; Peer?: Record<string, Peer> }
type Peer = { DNSName?: string; Online?: boolean }

export const getServerCandidates = async ({
  localUrl,
  signal,
  run = runCommand,
}: {
  localUrl: string | null
  signal: AbortSignal
  run?: RunCommand
}): Promise<{ servers: Array<DiscoveredServer>; tailscale: OnboardingStatus["tailscale"] }> => {
  const local: Array<DiscoveredServer> = localUrl ? [{ name: "", url: localUrl, source: "local" }] : []
  const result = await run("tailscale", ["status", "--json"], signal)
  if (result.code === 127) return { servers: local, tailscale: "missing" }
  if (result.code !== 0) return { servers: local, tailscale: "unavailable" }
  const tailnet = getTailnet(result.stdout)
  if (!tailnet) return { servers: local, tailscale: "unavailable" }
  if (tailnet.BackendState !== "Running") return { servers: local, tailscale: "signed-out" }

  const peers = [tailnet.Self, ...Object.values(tailnet.Peer ?? {}).slice(0, 128)]
  const servers = peers
    .filter((peer): peer is Peer => Boolean(peer && peer.Online !== false))
    .map((peer) => getTailnetServer(peer.DNSName))
    .filter((server): server is DiscoveredServer => server !== null)
    .filter((server, index, all) => all.findIndex((candidate) => candidate.url === server.url) === index)
    .slice(0, 32)

  return { servers: [...local, ...servers], tailscale: "ready" }
}

export const probeServer = async (
  url: string,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<boolean> => {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(1_200)])
  try {
    const response = await request(`${url}/pair`, {
      signal: deadline,
      redirect: "error",
      credentials: "omit",
      headers: { Accept: "text/html" },
    })
    if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) {
      await response.body?.cancel()
      return false
    }
    const html = await getPairingPage(response, deadline)
    return html.includes("<title>Entrar no touri</title>") && html.includes('id="pair-form"')
  } catch {
    return false
  }
}

const getPairingPage = async (response: Response, signal: AbortSignal): Promise<string> => {
  const reader = response.body?.getReader()
  if (!reader) return ""
  const cancel = () => {
    void reader.cancel()
  }
  signal.addEventListener("abort", cancel, { once: true })
  const decoder = new TextDecoder()
  let bytes = 0
  let html = ""
  try {
    while (!signal.aborted) {
      const next = await reader.read()
      if (next.done) return html
      bytes += next.value.byteLength
      if (bytes > 16_384) return ""
      html += decoder.decode(next.value, { stream: true })
    }
    return ""
  } finally {
    signal.removeEventListener("abort", cancel)
    await reader.cancel()
  }
}

const getTailnetServer = (name?: string): DiscoveredServer | null => {
  if (typeof name !== "string") return null
  const dns = name.replace(/\.$/, "").toLowerCase()
  if (!dns || dns.length > 253 || !/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(dns)) return null

  return { name: dns, url: `https://${dns}:8445`, source: "tailnet" }
}

const getTailnet = (stdout: string): Tailnet | null => {
  if (stdout.length > 1_048_576) return null
  try {
    const result: unknown = JSON.parse(stdout)
    if (!result || typeof result !== "object" || Array.isArray(result)) return null
    return result as Tailnet
  } catch {
    return null
  }
}
