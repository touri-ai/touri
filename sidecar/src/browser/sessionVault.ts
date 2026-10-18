import type { Database } from "bun:sqlite"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { join } from "node:path"
import type { Kernel } from "@touri/contracts"
import { getMeasuredStage } from "../kernel/background-task"
import { TouriError } from "../kernel/errors"
import { atomicWriteFile, ensurePrivateDirectory, readPrivateFile, removePrivateFile } from "../kernel/files"
import type { PerformanceStageRunner } from "../kernel/performance"
import { withDeadline } from "../kernel/policy"

export type SavedCookie = Record<string, unknown>
export type SavedSession = {
  cookies: Array<SavedCookie>
  storage: Record<string, Record<string, string>>
}

type Envelope =
  | { v: 1; enc: "aes-256-gcm"; iv: string; tag: string; data: string }
  | { v: 1; enc: "none"; data: string }

const MAX_SESSION_BYTES = 2 * 1024 * 1024
const KEY_BYTES = 32
const IV_BYTES = 12
const SAFE_BOT_ID = /^[A-Za-z0-9_-]+$/
const DELETED_SESSION_CURSOR = "storage.deleted-browser-session-key-cursor"
const DELETED_SESSION_KEY_PREFIX = "storage.deleted-browser-session-keys:"

export const emptySession = (): SavedSession => ({ cookies: [], storage: {} })

export const browserSessionKeyAccount = (botId: string): string => `browser-session-key:${botId}`

export const deletedBrowserSessionKey = (botId: string): string => `${DELETED_SESSION_KEY_PREFIX}${botId}`

export class SessionVaultError extends Error {
  constructor(readonly errorCode = "SESSION_UNREADABLE") {
    super("Não foi possível ler a sessão salva do navegador. Abra o Diagnóstico para verificar o cofre.")
  }
}

const vaultCall = async <T>(operation: () => Promise<T>): Promise<T> =>
  withDeadline({ operation, timeoutMs: 4000 }).catch((error) => {
    throw new SessionVaultError(
      error instanceof TouriError && error.code === "TOURI-E1008" ? "VAULT_TIMEOUT" : "VAULT_UNAVAILABLE",
    )
  })

const sessionsDir = (kernel: Kernel): string => join(kernel.paths.browserDir, "sessions")

const sessionPath = (kernel: Kernel, botId: string): string => join(sessionsDir(kernel), `${botId}.json`)

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const toSession = (value: unknown): SavedSession | null => {
  if (!isRecord(value) || !Array.isArray(value.cookies)) return null
  const storage = isRecord(value.storage) ? (value.storage as SavedSession["storage"]) : {}
  return { cookies: value.cookies.filter(isRecord), storage }
}

const readKey = async (kernel: Kernel, botId: string): Promise<Buffer | null> => {
  const result = await vaultCall(() => kernel.callHost("keychain.get", { account: browserSessionKeyAccount(botId) }))
  if (!result.success) throw new SessionVaultError(result.errorCode)
  if (result.value.value === null) return null
  const key = Buffer.from(result.value.value, "base64")
  if (key.byteLength !== KEY_BYTES) throw new SessionVaultError()
  return key
}

const createKey = async (kernel: Kernel, botId: string): Promise<Buffer> => {
  const created = randomBytes(KEY_BYTES)
  const stored = await vaultCall(() =>
    kernel.callHost("keychain.set", { account: browserSessionKeyAccount(botId), value: created.toString("base64") }),
  )
  if (!stored.success) throw new SessionVaultError(stored.errorCode)
  const confirmed = await readKey(kernel, botId)
  if (!confirmed?.equals(created)) throw new SessionVaultError()
  return confirmed
}

const seal = (plain: string, key: Buffer): Envelope => {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  return {
    v: 1,
    enc: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  }
}

const open = (envelope: Envelope, key: Buffer | null): string | null => {
  if (envelope.enc === "none") return Buffer.from(envelope.data, "base64").toString("utf8")
  if (!key) return null
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"))
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"))
    return Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8")
  } catch {
    return null
  }
}

const toEnvelope = (value: unknown): Envelope | null => {
  if (!isRecord(value) || value.v !== 1 || typeof value.data !== "string") return null
  if (value.enc === "none") return { v: 1, enc: "none", data: value.data }
  if (value.enc !== "aes-256-gcm" || typeof value.iv !== "string" || typeof value.tag !== "string") return null
  return { v: 1, enc: "aes-256-gcm", iv: value.iv, tag: value.tag, data: value.data }
}

/**
 * Bot-private browser session file (cookies and per-origin localStorage). The file is mode 0600 inside a 0700
 * directory and is encrypted with AES-256-GCM using a per-bot key kept in the host keychain. An unavailable
 * vault is an unknown, read-only state: never discard ciphertext, replace its key, or save without encryption.
 * Legacy enc:none files remain readable and are encrypted on the next successful save.
 */
export const hasBotSession = (kernel: Kernel, botId: string): boolean =>
  SAFE_BOT_ID.test(botId) &&
  readPrivateFile({ root: kernel.paths.appData, path: sessionPath(kernel, botId), maxBytes: 1 }) !== null

export const loadBotSession = async (kernel: Kernel, botId: string): Promise<SavedSession> => {
  if (!SAFE_BOT_ID.test(botId)) return emptySession()
  const raw = readPrivateFile({
    root: kernel.paths.appData,
    path: sessionPath(kernel, botId),
    maxBytes: MAX_SESSION_BYTES * 2,
  })
  if (!raw) return emptySession()
  const envelope = toEnvelope(parseJson(raw.toString("utf8")))
  if (!envelope) throw new SessionVaultError()
  const plain = open(envelope, envelope.enc === "none" ? null : await readKey(kernel, botId))
  const session = toSession(plain === null ? null : parseJson(plain))
  if (!session) throw new SessionVaultError()
  return session
}

export const saveBotSession = async ({
  kernel,
  botId,
  session,
  runStage,
}: {
  kernel: Kernel
  botId: string
  session: SavedSession
  runStage?: PerformanceStageRunner
}): Promise<boolean> => {
  if (!SAFE_BOT_ID.test(botId)) return false
  const measure = getMeasuredStage("browser_session_save", runStage)
  const plain = measure(() => JSON.stringify(session))
  if (plain.length > MAX_SESSION_BYTES) return false
  let key: Buffer
  try {
    // Even a save without a prior load must preserve an unreadable existing file.
    const raw = readPrivateFile({
      root: kernel.paths.appData,
      path: sessionPath(kernel, botId),
      maxBytes: MAX_SESSION_BYTES * 2,
    })
    const envelope = raw ? toEnvelope(parseJson(raw.toString("utf8"))) : null
    if (raw && !envelope) return false
    const existing = await readKey(kernel, botId)
    if (envelope?.enc === "aes-256-gcm") {
      if (!existing || !toSession(parseJson(open(envelope, existing) ?? ""))) return false
    }
    key = existing ?? (await createKey(kernel, botId))
  } catch {
    return false
  }
  ensurePrivateDirectory({ root: kernel.paths.appData, path: sessionsDir(kernel) })
  measure(() =>
    atomicWriteFile({
      root: kernel.paths.appData,
      path: sessionPath(kernel, botId),
      content: JSON.stringify(seal(plain, key)),
      mode: 0o600,
    }),
  )
  return true
}

export const removeBotSessionFile = (kernel: Kernel, botId: string): void => {
  if (!SAFE_BOT_ID.test(botId)) return
  removePrivateFile({ root: kernel.paths.appData, path: sessionPath(kernel, botId) })
}

export const removeBotSessionKey = async (kernel: Kernel, botId: string): Promise<void> => {
  if (!SAFE_BOT_ID.test(botId)) return
  const result = await kernel.callHost("keychain.delete", { account: browserSessionKeyAccount(botId) })
  if (!result.success) throw new Error("Não foi possível apagar a chave da sessão do navegador do bot.")
}

export const removeBotSession = async (kernel: Kernel, botId: string): Promise<void> => {
  removeBotSessionFile(kernel, botId)
  await removeBotSessionKey(kernel, botId)
}

export const retryDeletedBrowserSessionKeys = async (
  kernel: Pick<Kernel, "db" | "callHost" | "log" | "redact">,
  signal?: AbortSignal,
): Promise<void> => {
  if (signal?.aborted) return

  const database = kernel.db as Database
  const pending = getPendingSessionKeys(database)
  const last = pending.at(-1)
  if (!last) return

  // Commit the rotation before host I/O so even an interrupted batch cannot starve later keys.
  database
    .query(`INSERT INTO settings(key,value_json,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
    .run(DELETED_SESSION_CURSOR, JSON.stringify(last.key), Date.now())
  await Promise.all(
    pending.map(async ({ key }) => {
      const botId = key.slice(DELETED_SESSION_KEY_PREFIX.length)
      if (!SAFE_BOT_ID.test(botId) || signal?.aborted) return

      try {
        const result = await kernel.callHost("keychain.delete", { account: browserSessionKeyAccount(botId) })
        if (result.success && !signal?.aborted) database.query("DELETE FROM settings WHERE key = ?").run(key)
      } catch (error) {
        kernel.log({ level: "warn", module: "vm", msg: kernel.redact(String(error)) })
      }
    }),
  )
}

const getPendingSessionKeys = (database: Database): Array<{ key: string }> => {
  const stored = database.query("SELECT value_json FROM settings WHERE key = ?").get(DELETED_SESSION_CURSOR) as {
    value_json: string
  } | null
  const cursor = stored ? parseJson(stored.value_json) : null
  const lower =
    typeof cursor === "string" && cursor.startsWith(DELETED_SESSION_KEY_PREFIX) ? cursor : DELETED_SESSION_KEY_PREFIX
  const upper = `${DELETED_SESSION_KEY_PREFIX}\uffff`
  const pending = database
    .query("SELECT key FROM settings WHERE key > ? AND key < ? ORDER BY key LIMIT ?")
    .all(lower, upper, 10) as Array<{ key: string }>
  if (pending.length === 10 || lower === DELETED_SESSION_KEY_PREFIX) return pending

  const wrapped = database
    .query("SELECT key FROM settings WHERE key >= ? AND key <= ? ORDER BY key LIMIT ?")
    .all(DELETED_SESSION_KEY_PREFIX, lower, 10 - pending.length) as Array<{ key: string }>
  return [...pending, ...wrapped]
}

export const botSessionPath = sessionPath
