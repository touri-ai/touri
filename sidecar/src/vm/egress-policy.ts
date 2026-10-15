import type { Database } from "bun:sqlite"
import { isIP } from "node:net"
import { networkInterfaces } from "node:os"
import type { Kernel, Provider } from "@touri/contracts"
import { BOT_DNS } from "./image"
import network from "./image/network-policy.py" with { type: "text" }
import type { VmProvider } from "./types"

/**
 * `restrictPublic` limits public egress to `publicHosts` (a domain also allows its subdomains; IPs are
 * allowed as written) plus the hosts the bot's provider CLI needs. Off by default.
 */
export type EgressPolicy = {
  allowLan: boolean
  resolvers: string[]
  privateDomains: string[]
  restrictPublic: boolean
  publicHosts: string[]
}
export const defaultEgressPolicy = (): EgressPolicy => ({
  allowLan: false,
  resolvers: [...BOT_DNS],
  privateDomains: [],
  restrictPublic: false,
  publicHosts: [],
})
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
const PROVIDER_HOSTS: Record<Provider, string[]> = {
  codex: ["openai.com", "chatgpt.com"],
  claude: ["anthropic.com", "claude.ai", "claude.com"],
  opencode: ["opencode.ai", "models.dev"],
}
const OPENCODE_MODEL_HOSTS: Record<string, string[]> = {
  anthropic: ["anthropic.com"],
  openai: ["openai.com"],
  openrouter: ["openrouter.ai"],
  google: ["googleapis.com"],
  deepseek: ["deepseek.com"],
  groq: ["groq.com"],
  mistral: ["mistral.ai"],
  xai: ["x.ai"],
}
/** Hosts the bot's provider CLI must reach for login and model calls; always allowed with the allow-list. */
export const providerHosts = ({ provider, model }: { provider: Provider; model?: string | null }): string[] => [
  ...new Set([
    ...PROVIDER_HOSTS[provider],
    ...(provider === "opencode" ? (OPENCODE_MODEL_HOSTS[model?.split("/")[0] ?? ""] ?? []) : []),
  ]),
]
export const policyKey = (botId: string, active = false) => `vm-network:${active ? "active:" : ""}${botId}`
export const readEgressPolicy = (kernel: Kernel, botId: string, active = false): EgressPolicy => {
  const row = (kernel.db as Database)
    .query("SELECT value_json FROM settings WHERE key = ?")
    .get(policyKey(botId, active)) as { value_json: string } | null
  return row ? validateEgressPolicy(JSON.parse(row.value_json)) : defaultEgressPolicy()
}
const validPublicHost = (host: unknown): host is string =>
  typeof host === "string" && (isIP(host) !== 0 || HOSTNAME.test(host.toLowerCase()))
export const validateEgressPolicy = (value: unknown): EgressPolicy => {
  const p = value as Partial<EgressPolicy> | null
  const restrictPublic = p?.restrictPublic ?? false
  const publicHosts = p?.publicHosts ?? []
  if (
    !p ||
    typeof p.allowLan !== "boolean" ||
    !Array.isArray(p.resolvers) ||
    p.resolvers.length > 4 ||
    p.resolvers.some((ip) => typeof ip !== "string" || !isIP(ip)) ||
    !Array.isArray(p.privateDomains) ||
    p.privateDomains.length > 64 ||
    p.privateDomains.some((domain) => typeof domain !== "string" || !/^[a-z0-9][a-z0-9.-]{0,252}$/i.test(domain)) ||
    typeof restrictPublic !== "boolean" ||
    !Array.isArray(publicHosts) ||
    publicHosts.length > 64 ||
    !publicHosts.every(validPublicHost)
  )
    throw new Error("Política de rede inválida")
  return {
    allowLan: p.allowLan,
    resolvers: [...new Set(p.resolvers)],
    privateDomains: [...new Set(p.privateDomains.map((domain) => domain.toLowerCase()))],
    restrictPublic,
    publicHosts: [...new Set(publicHosts.map((host) => host.toLowerCase()))],
  }
}
export const saveEgressPolicy = (kernel: Kernel, botId: string, policy: EgressPolicy, active = false) => {
  ;(kernel.db as Database)
    .query(
      "INSERT INTO settings(key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at",
    )
    .run(policyKey(botId, active), JSON.stringify(policy), Date.now())
}
const tightenPublicHosts = (active: EgressPolicy, requested: EgressPolicy): string[] => {
  if (!active.restrictPublic) return requested.publicHosts
  if (!requested.restrictPublic) return active.publicHosts
  return active.publicHosts.filter((host) => requested.publicHosts.includes(host))
}
export const tightenEgressPolicy = (active: EgressPolicy, requested: EgressPolicy): EgressPolicy => ({
  allowLan: active.allowLan && requested.allowLan,
  resolvers: active.resolvers.filter((ip) => requested.resolvers.includes(ip)),
  privateDomains: [...new Set([...active.privateDomains, ...requested.privateDomains])],
  restrictPublic: active.restrictPublic || requested.restrictPublic,
  publicHosts: tightenPublicHosts(active, requested),
})
// The allow-list runs this sidecar's policy script, so machines on an older image enforce it too. It is
// written to a root-only path first, so the replacement DNS forwarder runs the same reviewed code.
export const INSTALL_POLICY_SCRIPT = `import os,sys
path='/run/touri-network-policy.py'
fd=os.open(path+'.tmp',os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o700)
os.write(fd,sys.argv[1].encode());os.fsync(fd);os.close(fd)
os.replace(path+'.tmp',path)
os.execv(sys.executable,[sys.executable,path,'apply',sys.argv[2]])`
const policyCommand = (policy: EgressPolicy, payload: string): string[] =>
  policy.restrictPublic
    ? ["-c", INSTALL_POLICY_SCRIPT, network, payload]
    : ["/usr/local/lib/touri/network-policy.py", "apply", payload]
export const installEgressPolicy = async (
  provider: VmProvider,
  id: string,
  policy: EgressPolicy,
  signal?: AbortSignal,
  requiredHosts: string[] = [],
) => {
  try {
    const payload = JSON.stringify({
      ...policy,
      publicHosts: [...new Set([...policy.publicHosts, ...requiredHosts])],
      hostAddresses: Object.values(networkInterfaces()).flatMap((interfaces) =>
        (interfaces ?? []).map((item) => item.address.split("%")[0]),
      ),
    })
    const result = await provider.exec({
      id,
      user: "0",
      command: "python3",
      args: policyCommand(policy, payload),
      ...(signal ? { signal } : {}),
    })
    if (!result.success || result.code !== 0) throw new Error("policy install failed")
  } catch {
    await provider.stop({ id })
    throw new Error("Não foi possível aplicar a proteção de rede. A máquina foi parada.")
  }
}
