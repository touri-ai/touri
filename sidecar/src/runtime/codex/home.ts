import { existsSync, realpathSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  ensurePrivateDirectoryAsync,
  replacePrivateSymlinkAsync,
  writePrivateFileAsync,
} from "../../kernel/async-files"
import { readBoundedFile } from "../../kernel/files"
import { asRecord } from "../utils"

const providerKeys = [
  "name",
  "base_url",
  "env_key",
  "env_key_instructions",
  "experimental_bearer_token",
  "wire_api",
  "requires_openai_auth",
  "request_max_retries",
  "stream_max_retries",
  "stream_idle_timeout_ms",
  "websocket_connect_timeout_ms",
  "supports_websockets",
  "http_headers",
  "env_http_headers",
  "query_params",
]

/** Only the active endpoint's named authentication variables cross confinement. */
export const codexAuthenticationKeys = (home: string | undefined): string[] => {
  if (!home || !existsSync(join(home, "config.toml"))) return []
  const config = asRecord(
    Bun.TOML.parse(readBoundedFile({ root: home, path: join(home, "config.toml"), maxBytes: 1024 * 1024 }).toString()),
  )
  if (typeof config?.model_provider !== "string") return []
  const provider = asRecord(asRecord(config.model_providers)?.[config.model_provider])
  return [provider?.env_key, ...Object.values(asRecord(provider?.env_http_headers) ?? {})].filter(
    (value): value is string => typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value),
  )
}

const tomlValue = (value: unknown): string => {
  if (typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
    return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`
  const record = asRecord(value)
  if (record)
    return `{ ${Object.entries(record)
      .map(([key, item]) => `${JSON.stringify(key)} = ${tomlValue(item)}`)
      .join(", ")} }`
  throw new Error("Configuração de autenticação do Codex inválida. Revise config.toml no seu terminal.")
}

const hostConfig = (hostHome: string): string => {
  let config: Record<string, unknown> = {}
  if (existsSync(join(hostHome, ".codex/config.toml"))) {
    try {
      const source = realpathSync(join(hostHome, ".codex/config.toml"))
      config =
        asRecord(
          Bun.TOML.parse(
            readBoundedFile({
              root: dirname(source),
              path: source,
              maxBytes: 1024 * 1024,
            }).toString("utf8"),
          ),
        ) ?? {}
    } catch {
      throw new Error("Não foi possível ler a configuração do Codex. Revise config.toml no seu terminal.")
    }
  }
  // File storage follows the shared auth link; keyring identities depend on CODEX_HOME.
  const lines = ['cli_auth_credentials_store = "file"']
  for (const key of [
    "model",
    "model_provider",
    "preferred_auth_method",
    "forced_login_method",
    "forced_chatgpt_workspace_id",
  ])
    if (config[key] !== undefined) lines.push(`${key} = ${tomlValue(config[key])}`)
  for (const [name, value] of Object.entries(asRecord(config.model_providers) ?? {})) {
    const provider = asRecord(value)
    if (!provider) continue
    lines.push(`\n[model_providers.${JSON.stringify(name)}]`)
    for (const key of providerKeys) if (provider[key] !== undefined) lines.push(`${key} = ${tomlValue(provider[key])}`)
  }
  return `${lines.join("\n")}\n`
}

/** Keep host login refreshes shared without importing the host's sessions or executable configuration. */
export const prepareHostCodexHome = async (appData: string, botId: string, hostHome: string): Promise<string> => {
  const home = join(appData, "provider-homes/codex", botId)
  await ensurePrivateDirectoryAsync({ root: appData, path: home })
  await writePrivateFileAsync({ root: appData, path: join(home, "config.toml"), content: hostConfig(hostHome) })
  const auth = join(home, "auth.json")
  const source = join(hostHome, ".codex/auth.json")
  await replacePrivateSymlinkAsync({ root: appData, path: auth, target: source })
  return home
}
