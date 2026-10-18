import { Database, SQLiteError, constants as sqliteFlags } from "bun:sqlite"
import { createHash, randomBytes } from "node:crypto"
import { dirname } from "node:path"
import { prepareDatabaseFile } from "../../kernel/files"
import { expiryAt } from "../../kernel/policy"

export const pairingCodeTtlMs = 5 * 60 * 1000
export const lastSeenGranularityMs = 60 * 1000
/** A device token expires after this long without use; active devices renew implicitly. */
export const deviceTokenTtlMs = 30 * 24 * 60 * 60_000
const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const codeGroups = 3
const codeGroupLength = 4
const busyTimeoutMs = 5000

export type Device = {
  id: string
  name: string
  createdAt: number
  lastSeenAt: number | null
  revokedAt: number | null
}

export type CreatePairingCodeSuccess = { success: true; code: string; expiresAt: number }
export type ClaimPairingCodeSuccess = { success: true; device: Device; token: string }
export type AuthError = { success: false; errorCode: "INVALID_CODE" | "NOT_FOUND"; error: string }
export type CreatePairingCodeResult = CreatePairingCodeSuccess
export type ClaimPairingCodeResult = ClaimPairingCodeSuccess | AuthError
export type RevokeDeviceResult = { success: true; device: Device } | AuthError

export type AuthStore = {
  createPairingCode: () => CreatePairingCodeResult
  claimPairingCode: (args: { code: string; deviceName: string }) => ClaimPairingCodeResult
  verifyDeviceToken: (token: string) => Device | null
  rotateDeviceToken: (token: string) => { token: string; device: Device } | null
  listDevices: () => Array<Device>
  revokeDevice: (idOrPrefix: string) => RevokeDeviceResult
  pendingCodeCount: () => number
  close: () => void
}

type DeviceRow = {
  id: string
  name: string
  created_at: number
  last_seen_at: number | null
  revoked_at: number | null
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex")
const newToken = (at: number): string => `${randomBytes(32).toString("base64url")}.${at}`

/** Uppercases and strips separators so `abcd-efgh-jkmn` and `ABCDEFGHJKMN` are the same code. */
export const normalizeCode = (raw: string): string => raw.toUpperCase().replace(/[^A-Z0-9]/g, "")

const formatCode = (compact: string): string =>
  Array.from({ length: codeGroups }, (_, index) =>
    compact.slice(index * codeGroupLength, (index + 1) * codeGroupLength),
  ).join("-")

const generateCode = (): string => {
  const bytes = randomBytes(codeGroups * codeGroupLength)
  const compact = Array.from(bytes, (byte) => codeAlphabet[byte % codeAlphabet.length]).join("")
  return formatCode(compact)
}

const toDevice = (row: DeviceRow): Device => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
  revokedAt: row.revoked_at,
})

const schema = `
CREATE TABLE IF NOT EXISTS pairing_codes (
  code_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER
);
`

export const isDatabaseBusy = (error: unknown): boolean =>
  error instanceof SQLiteError && (error.code === "SQLITE_BUSY" || error.code?.startsWith("SQLITE_BUSY_") === true)

export const openAuthDatabase = (filename: string): Database => {
  const deadline = performance.now() + busyTimeoutMs
  while (true) {
    let database: Database | undefined
    try {
      database = new Database(
        filename,
        sqliteFlags.SQLITE_OPEN_READWRITE | sqliteFlags.SQLITE_OPEN_CREATE | sqliteFlags.SQLITE_OPEN_NOFOLLOW,
      )
      for (const statement of ["PRAGMA journal_mode = WAL", "PRAGMA synchronous = FULL", schema]) {
        const remainingMs = Math.max(1, Math.ceil(deadline - performance.now()))
        database.exec(`PRAGMA busy_timeout = ${remainingMs}`)
        database.exec(statement)
      }
      database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`)
      return database
    } catch (error) {
      database?.close()
      const remainingMs = deadline - performance.now()
      if (!isDatabaseBusy(error) || remainingMs <= 0) throw error
      // Recovery and lock upgrades can bypass SQLite's busy handler.
      Bun.sleepSync(Math.min(50, remainingMs))
    }
  }
}

/** Opens (and creates) the auth database shared by the server and the CLI. */
export const openAuthStore = ({ filename, now = Date.now }: { filename: string; now?: () => number }): AuthStore => {
  const databasePath = prepareDatabaseFile({ root: dirname(filename), path: filename })
  const database = openAuthDatabase(databasePath)

  const createPairingCode = (): CreatePairingCodeResult => {
    const at = now()
    database.query("DELETE FROM pairing_codes WHERE expires_at < ? OR used_at IS NOT NULL").run(at)
    const code = generateCode()
    const expiresAt = expiryAt({ now: at, ttlMs: pairingCodeTtlMs })
    database
      .query("INSERT INTO pairing_codes (code_hash, created_at, expires_at) VALUES (?, ?, ?)")
      .run(sha256(normalizeCode(code)), at, expiresAt)
    return { success: true, code, expiresAt }
  }

  const claimPairingCode = ({ code, deviceName }: { code: string; deviceName: string }): ClaimPairingCodeResult => {
    const at = now()
    const normalized = normalizeCode(code)
    const claimed = database
      .query("UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?")
      .run(at, sha256(normalized), at)
    if (normalized.length !== codeGroups * codeGroupLength || claimed.changes !== 1)
      return { success: false, errorCode: "INVALID_CODE", error: "Invalid, expired or already used pairing code" }
    const token = newToken(at)
    const id = randomBytes(6).toString("hex")
    const name = deviceName.trim().slice(0, 80) || "Unnamed device"
    database
      .query("INSERT INTO devices (id, name, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, name, sha256(token), at, at)
    return { success: true, device: { id, name, createdAt: at, lastSeenAt: at, revokedAt: null }, token }
  }

  const verifyDeviceToken = (token: string): Device | null => {
    if (token.length === 0 || token.length > 256) return null
    const row = database
      .query("SELECT id, name, created_at, last_seen_at, revoked_at FROM devices WHERE token_hash = ?")
      .get(sha256(token)) as DeviceRow | null
    if (!row || row.revoked_at !== null) return null
    const at = now()
    const issuedAt = token.includes(".") ? Number(token.split(".")[1]) : row.created_at
    const lastActiveAt = Math.max(issuedAt, row.last_seen_at ?? 0)
    if (!Number.isSafeInteger(issuedAt) || issuedAt > at || at >= lastActiveAt + deviceTokenTtlMs) return null
    if (row.last_seen_at === null || at - row.last_seen_at > lastSeenGranularityMs)
      database.query("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(at, row.id)
    return toDevice(row)
  }

  const rotateDeviceToken: AuthStore["rotateDeviceToken"] = (previous) => {
    const device = verifyDeviceToken(previous)
    if (!device) return null
    const token = newToken(now())
    const changed = database
      .query("UPDATE devices SET token_hash = ? WHERE id = ? AND token_hash = ? AND revoked_at IS NULL")
      .run(sha256(token), device.id, sha256(previous))
    return changed.changes === 1 ? { token, device } : null
  }

  const listDevices = (): Array<Device> =>
    (
      database
        .query("SELECT id, name, created_at, last_seen_at, revoked_at FROM devices ORDER BY created_at ASC")
        .all() as Array<DeviceRow>
    ).map(toDevice)

  const revokeDevice = (idOrPrefix: string): RevokeDeviceResult => {
    const matches = listDevices().filter((device) => device.id.startsWith(idOrPrefix) && device.revokedAt === null)
    const [device] = matches
    if (!device || matches.length !== 1)
      return { success: false, errorCode: "NOT_FOUND", error: "No single active device matches that id" }
    const at = now()
    database.query("UPDATE devices SET revoked_at = ? WHERE id = ?").run(at, device.id)
    return { success: true, device: { ...device, revokedAt: at } }
  }

  const pendingCodeCount = (): number => {
    const row = database
      .query("SELECT COUNT(*) AS total FROM pairing_codes WHERE used_at IS NULL AND expires_at > ?")
      .get(now()) as { total: number }
    return row.total
  }

  return {
    createPairingCode,
    claimPairingCode,
    verifyDeviceToken,
    rotateDeviceToken,
    listDevices,
    revokeDevice,
    pendingCodeCount,
    close: () => database.close(),
  }
}
