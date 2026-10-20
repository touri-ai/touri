import { createHash, randomBytes } from "node:crypto"
import { dirname } from "node:path"
import { prepareDatabaseFile } from "../../kernel/files"
import { expiryAt } from "../../kernel/policy"
import { createAuthWriter } from "./auth-writer"
import { openAuthReader, ownerPersonId } from "./database"

export { isDatabaseBusy, openAuthDatabase } from "./database"

export const pairingCodeTtlMs = 5 * 60 * 1000
export const lastSeenGranularityMs = 60 * 1000
/** A device token expires after this long without use; active devices renew implicitly. */
export const deviceTokenTtlMs = 30 * 24 * 60 * 60_000
export const inviteTtlMs = 24 * 60 * 60_000
const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const codeGroups = 3
const codeGroupLength = 4

export type Device = {
  id: string
  name: string
  personId: string
  createdAt: number
  lastSeenAt: number | null
  revokedAt: number | null
}

export type PersonRole = "member" | "admin"
export type Person = {
  id: string
  name: string
  email: string | null
  avatarSeed: string
  role: PersonRole
  createdAt: number
  removedAt: number | null
}
export type Invite = {
  id: string
  name: string
  email: string
  role: PersonRole
  channelIds: Array<string>
  createdByPersonId: string
  createdAt: number
  expiresAt: number
  usedAt: number | null
  revokedAt: number | null
}

export type CreatePairingCodeSuccess = { success: true; code: string; expiresAt: number }
export type ClaimPairingCodeSuccess = { success: true; device: Device; token: string }
export type AuthError = { success: false; errorCode: "INVALID_CODE" | "NOT_FOUND"; error: string }
export type CreatePairingCodeResult = CreatePairingCodeSuccess
export type ClaimPairingCodeResult = ClaimPairingCodeSuccess | AuthError
export type RevokeDeviceResult = { success: true; device: Device } | AuthError
export type CreateInviteResult = { success: true; invite: Invite; token: string } | AuthError
export type ClaimInviteResult = { success: true; device: Device; person: Person; token: string } | AuthError

export type AuthStore = {
  createPairingCode: () => Promise<CreatePairingCodeResult>
  claimPairingCode: (args: { code: string; deviceName: string }) => Promise<ClaimPairingCodeResult>
  verifyDeviceToken: (token: string) => Device | null
  rotateDeviceToken: (token: string) => Promise<{ token: string; device: Device } | null>
  listDevices: () => Array<Device>
  revokeDevice: (idOrPrefix: string) => Promise<RevokeDeviceResult>
  getPerson: (id: string) => Person | null
  getPersonForDevice: (deviceId: string) => Person | null
  listPeople: () => Array<Person>
  getPersonChannelIds: (personId: string) => Array<string>
  createInvite: (args: {
    actorPersonId: string
    name: string
    email: string
    role: PersonRole
    channelIds: Array<string>
  }) => Promise<CreateInviteResult>
  listInvites: () => Array<Invite>
  resendInvite: (args: { id: string; actorPersonId: string }) => Promise<CreateInviteResult>
  revokeInvite: (args: { id: string; actorPersonId: string }) => Promise<AuthError | { success: true }>
  claimInvite: (args: { token: string; email: string; deviceName: string }) => Promise<ClaimInviteResult>
  removePerson: (args: { id: string; actorPersonId: string }) => Promise<AuthError | { success: true }>
  getEmailConfig: () => unknown | null
  saveEmailConfig: (args: { actorPersonId: string; config: unknown }) => Promise<boolean>
  pendingCodeCount: () => number
  close: () => Promise<void>
}

type DeviceRow = {
  id: string
  name: string
  person_id: string
  created_at: number
  last_seen_at: number | null
  revoked_at: number | null
}

type PersonRow = {
  id: string
  name: string
  email: string | null
  avatar_seed: string
  role: PersonRole
  created_at: number
  removed_at: number | null
}

type InviteRow = {
  id: string
  name: string
  email: string
  role: PersonRole
  channel_ids_json: string
  created_by_person_id: string
  created_at: number
  expires_at: number
  used_at: number | null
  revoked_at: number | null
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex")
const newToken = (at: number, personId = ownerPersonId): string => {
  const random = randomBytes(32).toString("base64url")
  if (personId === ownerPersonId) return `${random}.${at}`
  // Older servers have no person authorization and must reject these devices on rollback.
  return `person.v1.${random}.${at}`
}

const getTokenIssuedAt = (token: string, createdAt: number): number => {
  if (token.startsWith("person.")) {
    const versioned = /^person\.v1\.[A-Za-z0-9_-]{43}\.(\d+)$/u.exec(token)
    return versioned ? Number(versioned[1]) : Number.NaN
  }
  return token.includes(".") ? Number(token.split(".")[1]) : createdAt
}

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
  personId: row.person_id,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
  revokedAt: row.revoked_at,
})

const toPerson = (row: PersonRow): Person => ({
  id: row.id,
  name: row.name,
  email: row.email,
  avatarSeed: row.avatar_seed,
  role: row.role,
  createdAt: row.created_at,
  removedAt: row.removed_at,
})

const toInvite = (row: InviteRow): Invite => ({
  id: row.id,
  name: row.name,
  email: row.email,
  role: row.role,
  channelIds: JSON.parse(row.channel_ids_json) as Array<string>,
  createdByPersonId: row.created_by_person_id,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  usedAt: row.used_at,
  revokedAt: row.revoked_at,
})

export const normalizeEmail = (email: string): string => email.trim().toLocaleLowerCase("en-US")
export const isValidEmail = (email: string): boolean =>
  email.length <= 254 &&
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(
    email,
  )

const invalidCode = (): AuthError => ({
  success: false,
  errorCode: "INVALID_CODE",
  error: "Invalid, expired or already used invitation",
})

const tokenMatches = (candidate: string): boolean => /^[A-Za-z0-9_-]{43}$/u.test(candidate)

/** Opens the auth database with durable writes isolated from the server event loop. */
export const openAuthStore = async ({
  filename,
  now = Date.now,
  createWriterWorker,
}: {
  filename: string
  now?: () => number
  createWriterWorker?: () => Worker
}): Promise<AuthStore> => {
  const databasePath = prepareDatabaseFile({ root: dirname(filename), path: filename })
  const writer = await createAuthWriter(databasePath, createWriterWorker)
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
      device: { id, name, tokenHash: sha256(token), personId: ownerPersonId },
    })
    if (!claimed)
      return { success: false, errorCode: "INVALID_CODE", error: "Invalid, expired or already used pairing code" }
    return {
      success: true,
      device: { id, name, personId: ownerPersonId, createdAt: at, lastSeenAt: at, revokedAt: null },
      token,
    }
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
      .query(
        "SELECT d.id, d.name, d.person_id, d.created_at, d.last_seen_at, d.revoked_at FROM devices d JOIN people p ON p.id = d.person_id WHERE d.token_hash = ? AND p.removed_at IS NULL",
      )
      .get(sha256(token)) as DeviceRow | null
    if (!row || row.revoked_at !== null) return null
    const at = now()
    const issuedAt = getTokenIssuedAt(token, row.created_at)
    const lastActiveAt = Math.max(issuedAt, row.last_seen_at ?? 0, lastSeenScheduled.get(row.id) ?? 0)
    if (!Number.isSafeInteger(issuedAt) || issuedAt > at || at >= lastActiveAt + deviceTokenTtlMs) return null
    if (row.last_seen_at === null || at - row.last_seen_at > lastSeenGranularityMs) scheduleLastSeen(row.id, at)
    return toDevice(row)
  }

  const rotateDeviceToken = async (previous: string): Promise<{ token: string; device: Device } | null> => {
    const device = verifyDeviceToken(previous)
    if (!device) return null
    const token = newToken(now(), device.personId)
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
        .query("SELECT id, name, person_id, created_at, last_seen_at, revoked_at FROM devices ORDER BY created_at ASC")
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

  const getPerson = (id: string): Person | null => {
    const row = database.query("SELECT * FROM people WHERE id = ? AND removed_at IS NULL").get(id) as PersonRow | null
    return row ? toPerson(row) : null
  }

  const getPersonForDevice = (deviceId: string): Person | null => {
    const row = database
      .query(
        "SELECT p.* FROM people p JOIN devices d ON d.person_id = p.id WHERE d.id = ? AND d.revoked_at IS NULL AND p.removed_at IS NULL",
      )
      .get(deviceId) as PersonRow | null
    return row ? toPerson(row) : null
  }

  const listPeople = (): Array<Person> =>
    (
      database
        .query("SELECT * FROM people WHERE removed_at IS NULL ORDER BY created_at,id LIMIT 500")
        .all() as PersonRow[]
    ).map(toPerson)

  const getPersonChannelIds = (personId: string): Array<string> =>
    (
      database
        .query("SELECT channel_id FROM person_channels WHERE person_id = ? ORDER BY channel_id LIMIT 500")
        .all(personId) as Array<{ channel_id: string }>
    ).map(({ channel_id }) => channel_id)

  const createInvite = async ({
    actorPersonId,
    name,
    email,
    role,
    channelIds,
  }: {
    actorPersonId: string
    name: string
    email: string
    role: PersonRole
    channelIds: Array<string>
  }): Promise<CreateInviteResult> => {
    const normalizedEmail = normalizeEmail(email)
    const normalizedName = name.trim()
    if (
      normalizedName.length === 0 ||
      normalizedName.length > 80 ||
      !isValidEmail(normalizedEmail) ||
      (role !== "member" && role !== "admin") ||
      channelIds.length > 50 ||
      new Set(channelIds).size !== channelIds.length ||
      channelIds.some((id) => !id || id.length > 128)
    )
      return { success: false, errorCode: "INVALID_CODE", error: "Invalid invitation details" }
    const id = randomBytes(12).toString("hex")
    const token = randomBytes(32).toString("base64url")
    const at = now()
    const expiresAt = expiryAt({ now: at, ttlMs: inviteTtlMs })
    const created = await writer.write({
      type: "create-invite",
      invite: {
        id,
        tokenHash: sha256(token),
        name: normalizedName,
        email: normalizedEmail,
        role,
        channelIdsJson: JSON.stringify(channelIds),
        createdByPersonId: actorPersonId,
      },
      at,
      expiresAt,
    })
    if (!created) return { success: false, errorCode: "NOT_FOUND", error: "Only an active admin can invite people" }
    const invite = database.query("SELECT * FROM invites WHERE id = ?").get(id) as InviteRow | null
    if (!invite) return { success: false, errorCode: "NOT_FOUND", error: "Invitation could not be saved" }
    return { success: true, invite: toInvite(invite), token }
  }

  const listInvites = (): Array<Invite> =>
    (database.query("SELECT * FROM invites ORDER BY created_at DESC,id LIMIT 500").all() as InviteRow[]).map(toInvite)

  const resendInvite = async ({
    id,
    actorPersonId,
  }: {
    id: string
    actorPersonId: string
  }): Promise<CreateInviteResult> => {
    const token = randomBytes(32).toString("base64url")
    const at = now()
    const expiresAt = expiryAt({ now: at, ttlMs: inviteTtlMs })
    const changed = await writer.write({
      type: "resend-invite",
      id,
      actorPersonId,
      tokenHash: sha256(token),
      at,
      expiresAt,
    })
    if (!changed) return { success: false, errorCode: "NOT_FOUND", error: "Invitation not found or no longer active" }
    const invite = database.query("SELECT * FROM invites WHERE id = ?").get(id) as InviteRow | null
    if (!invite) return { success: false, errorCode: "NOT_FOUND", error: "Invitation not found" }
    return { success: true, invite: toInvite(invite), token }
  }

  const revokeInvite = async ({
    id,
    actorPersonId,
  }: {
    id: string
    actorPersonId: string
  }): Promise<AuthError | { success: true }> => {
    const changed = await writer.write({ type: "revoke-invite", id, actorPersonId, at: now() })
    return changed ? { success: true } : { success: false, errorCode: "NOT_FOUND", error: "Invitation not found" }
  }

  const claimInvite = async ({
    token,
    email,
    deviceName,
  }: {
    token: string
    email: string
    deviceName: string
  }): Promise<ClaimInviteResult> => {
    const normalizedEmail = normalizeEmail(email)
    if (!tokenMatches(token) || !isValidEmail(normalizedEmail)) return invalidCode()
    const at = now()
    const person = { id: randomBytes(12).toString("hex"), avatarSeed: randomBytes(8).toString("hex") }
    const device = {
      id: randomBytes(6).toString("hex"),
      name: deviceName.trim().slice(0, 80) || "Browser",
      tokenHash: "",
    }
    const authToken = newToken(at, person.id)
    const claimed = await writer.write({
      type: "claim-invite",
      tokenHash: sha256(token),
      email: normalizedEmail,
      at,
      person,
      device: { ...device, tokenHash: sha256(authToken) },
    })
    if (!claimed) return invalidCode()
    const savedPerson = getPerson(person.id)
    if (!savedPerson) return invalidCode()
    return {
      success: true,
      person: savedPerson,
      device: { id: device.id, name: device.name, personId: person.id, createdAt: at, lastSeenAt: at, revokedAt: null },
      token: authToken,
    }
  }

  const removePerson = async ({
    id,
    actorPersonId,
  }: {
    id: string
    actorPersonId: string
  }): Promise<AuthError | { success: true }> => {
    const changed = await writer.write({ type: "remove-person", id, actorPersonId, at: now() })
    return changed
      ? { success: true }
      : { success: false, errorCode: "NOT_FOUND", error: "Person not found or cannot be removed" }
  }

  const getEmailConfig = (): unknown | null => {
    const row = database.query("SELECT config_json FROM email_config WHERE id = 1").get() as {
      config_json: string
    } | null
    if (!row) return null
    try {
      return JSON.parse(row.config_json) as unknown
    } catch {
      return null
    }
  }

  const saveEmailConfig = async ({
    actorPersonId,
    config,
  }: {
    actorPersonId: string
    config: unknown
  }): Promise<boolean> =>
    Boolean(
      await writer.write({
        type: "save-email-config",
        actorPersonId,
        configJson: JSON.stringify(config),
        at: now(),
      }),
    )

  return {
    createPairingCode,
    claimPairingCode,
    verifyDeviceToken,
    rotateDeviceToken,
    listDevices,
    revokeDevice,
    getPerson,
    getPersonForDevice,
    listPeople,
    getPersonChannelIds,
    createInvite,
    listInvites,
    resendInvite,
    revokeInvite,
    claimInvite,
    removePerson,
    getEmailConfig,
    saveEmailConfig,
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
