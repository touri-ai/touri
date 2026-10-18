import type { Database } from "bun:sqlite"
import type { Id, Kernel, Mem0Settings, Mem0SettingsPatch } from "@touri/contracts"

/** Non-secret settings live in the settings table, one raw key per bot; the API key lives in the keychain. */
export type Mem0Config = Omit<Mem0Settings, "hasApiKey">

export const MEM0_DEFAULTS: Mem0Config = {
  enabled: false,
  mode: "platform",
  url: "",
  scope: "user",
  autoSync: true,
  topK: 6,
  threshold: 0.3,
}

export const configKey = (botId: Id): string => `mem0:${botId}`
export const secretAccount = (botId: Id): string => `mem0/${botId}`
const OWNER_KEY = "mem0-owner-id"

const readRaw = (kernel: Kernel, key: string): unknown => {
  const row = (kernel.db as Database).query("SELECT value_json FROM settings WHERE key=?").get(key) as {
    value_json: string
  } | null
  if (!row) return null
  try {
    return JSON.parse(row.value_json)
  } catch {
    return null
  }
}

const writeRaw = (kernel: Kernel, key: string, value: unknown): void => {
  ;(kernel.db as Database)
    .query(`INSERT INTO settings(key,value_json,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
    .run(key, JSON.stringify(value), Date.now())
}

const validUrl = (value: string): boolean => {
  if (!value) return true
  try {
    const url = new URL(value)
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    )
  } catch {
    return false
  }
}

/** Keeps only known fields with valid values, so a damaged row falls back to the defaults field by field. */
const normalize = (value: unknown): Mem0Config => {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>
  const number = (key: "topK" | "threshold", min: number, max: number, integer: boolean): number => {
    const candidate = raw[key]
    return typeof candidate === "number" &&
      Number.isFinite(candidate) &&
      candidate >= min &&
      candidate <= max &&
      (!integer || Number.isInteger(candidate))
      ? candidate
      : MEM0_DEFAULTS[key]
  }
  return {
    enabled: raw.enabled === true,
    mode: raw.mode === "server" ? "server" : "platform",
    url: typeof raw.url === "string" && validUrl(raw.url) ? raw.url.replace(/\/+$/, "") : "",
    scope: raw.scope === "bot" ? "bot" : "user",
    autoSync: raw.autoSync !== false,
    topK: number("topK", 1, 20, true),
    threshold: number("threshold", 0, 1, false),
  }
}

export const readConfig = (kernel: Kernel, botId: Id): Mem0Config => normalize(readRaw(kernel, configKey(botId)))

export type PatchError = { field: string; error: string }

export const patchError = (patch: Mem0SettingsPatch): PatchError | null => {
  if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") return { field: "enabled", error: "boolean" }
  if (patch.mode !== undefined && patch.mode !== "platform" && patch.mode !== "server")
    return { field: "mode", error: "platform or server" }
  if (patch.url !== undefined && (typeof patch.url !== "string" || patch.url.length > 512 || !validUrl(patch.url)))
    return { field: "url", error: "http(s) URL without credentials" }
  if (patch.scope !== undefined && patch.scope !== "user" && patch.scope !== "bot")
    return { field: "scope", error: "user or bot" }
  if (patch.autoSync !== undefined && typeof patch.autoSync !== "boolean")
    return { field: "autoSync", error: "boolean" }
  if (
    patch.topK !== undefined &&
    (typeof patch.topK !== "number" || !Number.isInteger(patch.topK) || patch.topK < 1 || patch.topK > 20)
  )
    return { field: "topK", error: "integer 1..20" }
  if (
    patch.threshold !== undefined &&
    (typeof patch.threshold !== "number" || !(patch.threshold >= 0 && patch.threshold <= 1))
  )
    return { field: "threshold", error: "number 0..1" }
  if (
    patch.apiKey !== undefined &&
    patch.apiKey !== null &&
    (typeof patch.apiKey !== "string" || !patch.apiKey.trim() || patch.apiKey.length > 512 || /\s/.test(patch.apiKey))
  )
    return { field: "apiKey", error: "non-empty key without spaces" }
  return null
}

export const writeConfig = (kernel: Kernel, botId: Id, patch: Mem0SettingsPatch): Mem0Config => {
  const { apiKey: _secret, ...fields } = patch
  const next = normalize({ ...readConfig(kernel, botId), ...fields })
  writeRaw(kernel, configKey(botId), next)
  return next
}

/**
 * The Mem0 `user_id` for this touri install. touri has a single owner, so one generated
 * id stands for them in every bot; Mem0 never sees a name or an email.
 */
export const ownerId = (kernel: Kernel): string => {
  const saved = readRaw(kernel, OWNER_KEY)
  if (typeof saved === "string" && /^touri-[a-z0-9]{8,}$/i.test(saved)) return saved
  const created = `touri-${kernel.newId().toLowerCase()}`
  writeRaw(kernel, OWNER_KEY, created)
  return created
}
