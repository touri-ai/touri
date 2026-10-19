import { createHash, randomBytes } from "node:crypto"
import { dirname } from "node:path"
import { prepareDatabaseFile } from "../../kernel/files"
import { expiryAt } from "../../kernel/policy"
import { openAuthReader } from "./database"

export { isDatabaseBusy, openAuthDatabase } from "./database"

export const pairingCodeTtlMs = 5 * 60 * 1000
export const lastSeenGranularityMs = 60 * 1000
/** A device token expires after this long without use; active devices renew implicitly. */
export const deviceTokenTtlMs = 30 * 24 * 60 * 60_000
const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const codeGroups = 3
const codeGroupLength = 4
const writerStartupTimeoutMs = 15_000

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
  createPairingCode: () => Promise<CreatePairingCodeResult>
  claimPairingCode: (args: { code: string; deviceName: string }) => Promise<ClaimPairingCodeResult>
  verifyDeviceToken: (token: string) => Device | null
  rotateDeviceToken: (token: string) => Promise<{ token: string; device: Device } | null>
  listDevices: () => Array<Device>
  revokeDevice: (idOrPrefix: string) => Promise<RevokeDeviceResult>
  pendingCodeCount: () => number
  close: () => Promise<void>
}

type DeviceRow = {
  id: string
  name: string
  created_at: number
  last_seen_at: number | null
  revoked_at: number | null
}

type WriteCommand =
  | { type: "create-pairing"; codeHash: string; at: number; expiresAt: number }
  | {
      type: "claim-pairing"
      codeHash: string
      at: number
      device: { id: string; name: string; tokenHash: string }
    }
  | { type: "last-seen"; id: string; at: number }
  | { type: "rotate-token"; id: string; previousHash: string; tokenHash: string }
  | { type: "revoke-device"; id: string; at: number }

type WriterMessage =
  | { type: "ready" }
  | { type: "stopped" }
  | { type: "startup-error"; error: WorkerError }
  | { type?: undefined; requestId: number; result?: unknown; error?: WorkerError }

type WorkerError = { name: string; message: string; code?: string }

type AuthWriter = {
  write: (command: WriteCommand) => Promise<unknown>
  close: () => Promise<void>
}
type RefableWorker = Worker & { ref: () => void; unref: () => void }

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

const workerError = ({ name, message, code }: WorkerError): Error =>
  Object.assign(new Error(message), { name, ...(code ? { code } : {}) })

const createAuthWriter = async (filename: string): Promise<AuthWriter> => {
  const worker = new Worker(new URL("./store-writer-entry.ts", import.meta.url), {
    smol: true,
    ref: false,
  }) as RefableWorker
  worker.ref()
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  let requestId = 0
  let readyResolve: () => void = () => {}
  let readyReject: (error: Error) => void = () => {}
  let stoppedResolve: () => void = () => {}
  let stoppedByError = false
  let closing = false
  let closePromise: Promise<void> | undefined
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })
  const stopped = new Promise<void>((resolve) => {
    stoppedResolve = resolve
  })
  const rejectPending = (error: Error): void => {
    pending.forEach(({ reject }) => {
      reject(error)
    })
    pending.clear()
  }
  worker.onmessage = ({ data }: MessageEvent<WriterMessage>): void => {
    if (data.type === "ready") {
      readyResolve()
      return
    }
    if (data.type === "startup-error") {
      readyReject(workerError(data.error))
      return
    }
    if (data.type === "stopped") {
      stoppedResolve()
      return
    }
    const result = pending.get(data.requestId)
    if (!result) return
    pending.delete(data.requestId)
    if (data.error) result.reject(workerError(data.error))
    else result.resolve(data.result)
    if (pending.size === 0 && !closing) worker.unref()
  }
  worker.onerror = (event): void => {
    event.preventDefault()
    const error = new Error("Authentication writer stopped unexpectedly")
    stoppedByError = true
    readyReject(error)
    rejectPending(error)
    stoppedResolve()
  }
  worker.postMessage({ type: "start", filename })
  const startupTimeout = setTimeout(
    () => readyReject(new Error("Authentication writer startup timed out")),
    writerStartupTimeoutMs,
  )
  startupTimeout.unref()
  try {
    await ready
    worker.unref()
  } catch (error) {
    worker.terminate()
    throw error
  } finally {
    clearTimeout(startupTimeout)
  }

  const write = (command: WriteCommand): Promise<unknown> => {
    if (stoppedByError || closing) return Promise.reject(new Error("Authentication writer is unavailable"))
    worker.ref()
    const id = ++requestId
    const result = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }))
    worker.postMessage({ ...command, requestId: id })
    return result
  }

  return {
    write,
    close: () => {
      closePromise ??= (async () => {
        closing = true
        if (stoppedByError) {
          worker.terminate()
          return
        }
        worker.ref()
        worker.postMessage({ type: "stop" })
        await stopped
        worker.terminate()
      })()
      return closePromise
    },
  }
}

/** Opens the auth database with durable writes isolated from the server event loop. */
export const openAuthStore = async ({
  filename,
  now = Date.now,
}: {
  filename: string
  now?: () => number
}): Promise<AuthStore> => {
  const databasePath = prepareDatabaseFile({ root: dirname(filename), path: filename })
  const writer = await createAuthWriter(databasePath)
  let database: ReturnType<typeof openAuthReader>
  try {
    database = openAuthReader(databasePath)
  } catch (error) {
    await writer.close()
    throw error
  }
  const lastSeenScheduled = new Map<string, number>()

  const createPairingCode = async (): Promise<CreatePairingCodeResult> => {
    const at = now()
    const code = generateCode()
    const expiresAt = expiryAt({ now: at, ttlMs: pairingCodeTtlMs })
    await writer.write({ type: "create-pairing", codeHash: sha256(normalizeCode(code)), at, expiresAt })
    return { success: true, code, expiresAt }
  }

  const claimPairingCode = async ({
    code,
    deviceName,
  }: {
    code: string
    deviceName: string
  }): Promise<ClaimPairingCodeResult> => {
    const at = now()
    const normalized = normalizeCode(code)
    if (normalized.length !== codeGroups * codeGroupLength)
      return { success: false, errorCode: "INVALID_CODE", error: "Invalid, expired or already used pairing code" }
    const token = newToken(at)
    const id = randomBytes(6).toString("hex")
    const name = deviceName.trim().slice(0, 80) || "Unnamed device"
    const claimed = await writer.write({
      type: "claim-pairing",
      codeHash: sha256(normalized),
      at,
      device: { id, name, tokenHash: sha256(token) },
    })
    if (!claimed)
      return { success: false, errorCode: "INVALID_CODE", error: "Invalid, expired or already used pairing code" }
    return { success: true, device: { id, name, createdAt: at, lastSeenAt: at, revokedAt: null }, token }
  }

  const scheduleLastSeen = (id: string, at: number): void => {
    const lastScheduledAt = lastSeenScheduled.get(id)
    if (lastScheduledAt !== undefined && at - lastScheduledAt <= lastSeenGranularityMs) return
    lastSeenScheduled.delete(id)
    lastSeenScheduled.set(id, at)
    if (lastSeenScheduled.size > 8192) {
      const [oldest] = lastSeenScheduled.keys()
      if (oldest) lastSeenScheduled.delete(oldest)
    }
    void writer.write({ type: "last-seen", id, at }).catch(() => {
      if (lastSeenScheduled.get(id) === at) lastSeenScheduled.delete(id)
    })
  }

  const verifyDeviceToken = (token: string): Device | null => {
    if (token.length === 0 || token.length > 256) return null
    const row = database
      .query("SELECT id, name, created_at, last_seen_at, revoked_at FROM devices WHERE token_hash = ?")
      .get(sha256(token)) as DeviceRow | null
    if (!row || row.revoked_at !== null) return null
    const at = now()
    const issuedAt = token.includes(".") ? Number(token.split(".")[1]) : row.created_at
    const lastActiveAt = Math.max(issuedAt, row.last_seen_at ?? 0, lastSeenScheduled.get(row.id) ?? 0)
    if (!Number.isSafeInteger(issuedAt) || issuedAt > at || at >= lastActiveAt + deviceTokenTtlMs) return null
    if (row.last_seen_at === null || at - row.last_seen_at > lastSeenGranularityMs) scheduleLastSeen(row.id, at)
    return toDevice(row)
  }

  const rotateDeviceToken = async (previous: string): Promise<{ token: string; device: Device } | null> => {
    const device = verifyDeviceToken(previous)
    if (!device) return null
    const token = newToken(now())
    const changed = await writer.write({
      type: "rotate-token",
      id: device.id,
      tokenHash: sha256(token),
      previousHash: sha256(previous),
    })
    return changed ? { token, device } : null
  }

  const listDevices = (): Array<Device> =>
    (
      database
        .query("SELECT id, name, created_at, last_seen_at, revoked_at FROM devices ORDER BY created_at ASC")
        .all() as Array<DeviceRow>
    ).map(toDevice)

  const revokeDevice = async (idOrPrefix: string): Promise<RevokeDeviceResult> => {
    const matches = listDevices().filter((device) => device.id.startsWith(idOrPrefix) && device.revokedAt === null)
    const [device] = matches
    if (!device || matches.length !== 1)
      return { success: false, errorCode: "NOT_FOUND", error: "No single active device matches that id" }
    const at = now()
    const changed = await writer.write({ type: "revoke-device", id: device.id, at })
    if (!changed) return { success: false, errorCode: "NOT_FOUND", error: "No single active device matches that id" }
    lastSeenScheduled.delete(device.id)
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
    close: async () => {
      try {
        await writer.close()
      } finally {
        database.close()
      }
    },
  }
}
