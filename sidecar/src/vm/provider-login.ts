import type { Database } from "bun:sqlite"
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Bot, Kernel } from "@touri/contracts"
import { openWorkspaceEntry, readBoundedFile } from "../kernel/files"
import { withDeadline } from "../kernel/policy"

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
const nonempty = (value: unknown) => typeof value === "string" && value.trim().length > 0
/** Structural/expiry validation only; provider CLI refreshes and validates with its own service. */
export const validLogin = (provider: Bot["provider"], value: string, host = false): boolean => {
  if (provider === "claude" && !host) return /^sk-ant-oat01-[\w-]+$/.test(value.trim())
  try {
    const auth = record(JSON.parse(value))
    if (!auth) return false
    if (provider === "codex") {
      const tokens = record(auth.tokens)
      return nonempty(auth.OPENAI_API_KEY) || (nonempty(tokens?.access_token) && nonempty(tokens?.refresh_token))
    }
    if (provider === "claude") {
      const oauth = record(auth.claudeAiOauth)
      return nonempty(oauth?.accessToken) && typeof oauth?.expiresAt === "number" && oauth.expiresAt > Date.now()
    }
    return Object.values(auth).some((value) => {
      const entry = record(value)
      return (
        (entry?.type === "api" && nonempty(entry.key)) ||
        (entry?.type === "oauth" &&
          nonempty(entry.access) &&
          nonempty(entry.refresh) &&
          (typeof entry.expires !== "number" || entry.expires > Date.now()))
      )
    })
  } catch {
    return false
  }
}

export const providerLoginAccount = (botId: string, provider: Bot["provider"]): string =>
  `bot/${botId}/${provider}-vm-login`
export const redactProviderLogin = (kernel: Kernel, value: string) => {
  kernel.addRedactionValue(value)
  try {
    const walk = (item: unknown) => {
      if (typeof item === "string" && item.length >= 6) kernel.addRedactionValue(item)
      else if (item && typeof item === "object") for (const child of Object.values(item)) walk(child)
    }
    walk(JSON.parse(value))
  } catch {}
}
export const providerLoginSourceKey = (bot: Pick<Bot, "id" | "provider">) => `vm-login-source:${bot.id}:${bot.provider}`
export type ProviderLoginSource = "vault" | "host-file"
/** Keep vault failures within the HTTP request's idle timeout so the route can explain how to recover. */
export const VAULT_READ_DEADLINE_MS = 5000
export const storedProviderLoginSource = (
  kernel: Kernel,
  bot: Pick<Bot, "id" | "provider">,
): ProviderLoginSource | null => {
  const row = (kernel.db as Database | undefined)
    ?.query("SELECT value_json FROM settings WHERE key = ?")
    .get(providerLoginSourceKey(bot)) as { value_json: string } | null
  if (row?.value_json === '"host-file"') return "host-file"
  return row?.value_json === '"vault"' ? "vault" : null
}
export const providerLoginSource = (kernel: Kernel, bot: Pick<Bot, "id" | "provider">): ProviderLoginSource =>
  storedProviderLoginSource(kernel, bot) ?? "vault"
const persistInitialSource = (kernel: Kernel, bot: Pick<Bot, "id" | "provider">, source: ProviderLoginSource) => {
  ;(kernel.db as Database | undefined)
    ?.query("INSERT INTO settings(key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO NOTHING")
    .run(providerLoginSourceKey(bot), JSON.stringify(source), Date.now())
  return storedProviderLoginSource(kernel, bot) ?? source
}
export type LoginTarget = { directory: string; file: string; label: string; command: string }
export const loginTarget = (provider: Bot["provider"]): LoginTarget => {
  if (provider === "opencode")
    return { directory: ".local/share/opencode", file: "auth.json", label: "OpenCode", command: "opencode auth login" }
  if (provider === "codex")
    return { directory: ".codex", file: "auth.json", label: "Codex", command: "codex login --device-auth" }
  return { directory: ".claude", file: ".credentials.json", label: "Claude", command: "claude setup-token" }
}
export type ProviderLoginFailure = "not-found" | "transport" | "invalid" | "vault-locked"
export class ProviderLoginError extends Error {
  readonly errorCode = "cli_auth"
  readonly code = "TOURI-E3001"
  readonly reason: ProviderLoginFailure
  constructor(message: string, reason: ProviderLoginFailure = "invalid") {
    super(message)
    this.reason = reason
  }
}

export const readHostLoginFile = (hostHome: string, target: LoginTarget): string => {
  if (process.platform === "win32") {
    const root = join(hostHome, target.directory)
    return readBoundedFile({ root, path: join(root, target.file), maxBytes: 20000 }).toString("utf8")
  }
  const directory = openSync(
    join(hostHome, target.directory),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  try {
    const fd = openWorkspaceEntry(directory, target.file)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > 20000) throw new ProviderLoginError("Arquivo de login inválido")
      return readFileSync(fd, "utf8")
    } finally {
      closeSync(fd)
    }
  } finally {
    closeSync(directory)
  }
}

export const hostLoginFileExists = (hostHome: string, provider: Bot["provider"]): boolean => {
  try {
    return readHostLoginFile(hostHome, loginTarget(provider)).trim().length > 0
  } catch {
    return false
  }
}

const notConnectedMessage = (target: LoginTarget): string =>
  `${target.label} ainda não está conectado neste bot. Abra Permissões do bot > Computador > Login do provedor e escolha o arquivo de login do host ou salve um login no cofre (${target.command}).`

const vaultTransportMessage = (): string => "O cofre de segredos não respondeu. Tente novamente."

export const NATIVE_VAULT_GUIDANCE =
  "O aplicativo não conseguiu acessar o cofre nativo. Desbloqueie o cofre do sistema e tente novamente."

export const SERVER_VAULT_GUIDANCE =
  "O cofre local do servidor está indisponível. Verifique as permissões da pasta de dados do servidor e reinicie o serviço do touri. O login salvo será mantido."

export const readVault = async (
  kernel: Kernel,
  bot: Pick<Bot, "id" | "provider">,
  _target: LoginTarget,
  options: { signal?: AbortSignal; timeoutMs?: number },
): Promise<string | null> => {
  const stored = await withDeadline({
    operation: () => kernel.callHost("keychain.get", { account: providerLoginAccount(bot.id, bot.provider) }),
    timeoutMs: options.timeoutMs ?? VAULT_READ_DEADLINE_MS,
    ...(options.signal ? { signal: options.signal } : {}),
  }).catch(() => {
    options.signal?.throwIfAborted()
    throw new ProviderLoginError(vaultTransportMessage(), "transport")
  })
  if (!stored.success && ["VAULT_ACCESS_REQUIRED", "VAULT_TIMEOUT", "VAULT_CANCELLED"].includes(stored.errorCode))
    throw new ProviderLoginError("Permita o acesso ao cofre para usar o login salvo.", "vault-locked")
  if (!stored.success)
    throw new ProviderLoginError("O cofre de segredos está indisponível. Tente novamente.", "transport")
  return stored.value.value || null
}

/**
 * Resolves the login source once. A bot with no recorded source keeps what it effectively used before:
 * the vault when an entry exists, otherwise the host CLI login file, otherwise the vault with a guided login.
 * The decision is persisted, so no later run falls back between sources. A vault transport failure persists nothing.
 */
export const resolveProviderLoginSource = async (
  kernel: Kernel,
  bot: Bot,
  hostHome: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ProviderLoginSource> => {
  const stored = storedProviderLoginSource(kernel, bot)
  if (stored) return stored
  const entry = await readVault(kernel, bot, loginTarget(bot.provider), options)
  if (entry) return persistInitialSource(kernel, bot, "vault")
  return persistInitialSource(kernel, bot, hostLoginFileExists(hostHome, bot.provider) ? "host-file" : "vault")
}

export const readProviderLogin = async (
  kernel: Kernel,
  bot: Bot,
  hostHome: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
) => {
  const target = loginTarget(bot.provider)
  options.signal?.throwIfAborted()
  const selection = await resolveProviderLoginSource(kernel, bot, hostHome, options)
  const validateJson = (value: string) => {
    try {
      const parsed: unknown = JSON.parse(value)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error()
    } catch {
      throw new ProviderLoginError("O arquivo de login é inválido. Conecte novamente.")
    }
    return { source: "file" as const, value, selection }
  }
  if (selection === "host-file") {
    try {
      return validateJson(readHostLoginFile(hostHome, target))
    } catch (error) {
      if (error instanceof ProviderLoginError) throw error
      throw new ProviderLoginError(
        `Arquivo de login do ${target.label} indisponível. Execute ${target.command} no host ou selecione o cofre nas permissões do bot.`,
        "not-found",
      )
    }
  }
  const value = await readVault(kernel, bot, target, options)
  if (!value) throw new ProviderLoginError(notConnectedMessage(target), "not-found")
  if (providerLoginSource(kernel, bot) !== selection)
    throw new ProviderLoginError("A fonte de login mudou. Tente novamente.")
  return bot.provider === "claude" ? { source: "token" as const, value, selection } : validateJson(value)
}
