import type { Database } from "bun:sqlite"
import type { Id, Kernel, TelegramIntegration, TelegramIntegrationConfig } from "@touri/contracts"

/**
 * Non-secret configuration and bridge state live in the settings key-value table, one row per bot,
 * so the feature needs no migration. The bot token is a secret and lives in the keychain.
 */
export type TelegramState = {
  /** Next getUpdates offset; persisted so a restart neither replays nor drops messages. */
  offset: number
  /** Telegram chat ID to touri thread ID. */
  chats: Record<string, Id>
  lastRejected: TelegramIntegration["lastRejected"]
  routineRunIds: Array<Id>
}

export const DEFAULT_CONFIG: TelegramIntegrationConfig = {
  enabled: false,
  allowedUserIds: [],
  homeChatId: null,
  forwardRoutines: false,
}
const DEFAULT_STATE: TelegramState = { offset: 0, chats: {}, lastRejected: null, routineRunIds: [] }

const configKey = (botId: Id) => `telegram:${botId}`
const stateKey = (botId: Id) => `telegram-state:${botId}`
export const tokenAccount = (botId: Id) => `touri.telegram.${botId}`

export const TELEGRAM_ID = /^-?\d{1,20}$/

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

export const normalizeConfig = (value: unknown): TelegramIntegrationConfig => {
  const input = record(value)
  const ids = Array.isArray(input.allowedUserIds) ? input.allowedUserIds : []
  return {
    enabled: input.enabled === true,
    allowedUserIds: [
      ...new Set(ids.map((id) => String(id).trim()).filter((id) => TELEGRAM_ID.test(id) && !id.startsWith("-"))),
    ],
    homeChatId:
      typeof input.homeChatId === "string" && TELEGRAM_ID.test(input.homeChatId.trim())
        ? input.homeChatId.trim()
        : null,
    forwardRoutines: input.forwardRoutines === true,
  }
}

export const createTelegramStore = (kernel: Kernel) => {
  const db = kernel.db as Database
  const read = (key: string): unknown => {
    const row = db.query("SELECT value_json FROM settings WHERE key = ?").get(key) as { value_json: string } | null
    if (!row) return null
    try {
      return JSON.parse(row.value_json)
    } catch {
      return null
    }
  }
  const write = (key: string, value: unknown): void => {
    db.query(
      "INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
    ).run(key, JSON.stringify(value), Date.now())
  }
  const config = (botId: Id): TelegramIntegrationConfig =>
    read(configKey(botId)) === null ? { ...DEFAULT_CONFIG } : normalizeConfig(read(configKey(botId)))
  const state = (botId: Id): TelegramState => {
    const value = record(read(stateKey(botId)))
    const chats = record(value.chats)
    const rejected = record(value.lastRejected)
    return {
      routineRunIds: Array.isArray(value.routineRunIds)
        ? value.routineRunIds.filter((id): id is string => typeof id === "string").slice(-200)
        : [],
      offset: Number.isSafeInteger(value.offset) ? (value.offset as number) : DEFAULT_STATE.offset,
      chats: Object.fromEntries(
        Object.entries(chats).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      ),
      lastRejected:
        typeof rejected.userId === "string" && typeof rejected.name === "string" && typeof rejected.at === "number"
          ? { userId: rejected.userId, name: rejected.name, at: rejected.at }
          : null,
    }
  }
  const configuredBots = (): Array<Id> =>
    (db.query("SELECT key FROM settings WHERE key LIKE 'telegram:%'").all() as Array<{ key: string }>).map((row) =>
      row.key.slice("telegram:".length),
    )
  return {
    config,
    saveConfig: (botId: Id, value: TelegramIntegrationConfig) => write(configKey(botId), value),
    state,
    saveState: (botId: Id, value: TelegramState) => write(stateKey(botId), value),
    configuredBots,
    resetState: (botId: Id) => db.query("DELETE FROM settings WHERE key = ?").run(stateKey(botId)),
    remove: (botId: Id) => {
      db.query("DELETE FROM settings WHERE key IN (?, ?)").run(configKey(botId), stateKey(botId))
    },
  }
}

export type TelegramStore = ReturnType<typeof createTelegramStore>
