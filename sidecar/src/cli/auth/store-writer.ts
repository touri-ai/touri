import { timingSafeEqual } from "node:crypto"
import { openAuthDatabase } from "./database"

import type { WriteCommand, WriterMessage, WriterRequest } from "./store-protocol"

let database: ReturnType<typeof openAuthDatabase> | undefined

const isActiveAdmin = (db: NonNullable<typeof database>, personId: string): boolean =>
  Boolean(db.query("SELECT 1 FROM people WHERE id = ? AND role = 'admin' AND removed_at IS NULL").get(personId))

const execute = (command: WriteCommand): unknown => {
  const db = database
  if (!db) throw new Error("The authentication writer is not ready")
  if (command.type === "create-pairing") {
    db.query("DELETE FROM pairing_codes WHERE expires_at < ? OR used_at IS NOT NULL").run(command.at)
    db.query("INSERT INTO pairing_codes (code_hash, created_at, expires_at) VALUES (?, ?, ?)").run(
      command.codeHash,
      command.at,
      command.expiresAt,
    )
    return true
  }
  if (command.type === "claim-pairing") {
    const claim = db.transaction(() => {
      const result = db
        .query("UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?")
        .run(command.at, command.codeHash, command.at)
      if (result.changes !== 1) return false
      db.query(
        "INSERT INTO devices (id, name, token_hash, created_at, last_seen_at, person_id) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        command.device.id,
        command.device.name,
        command.device.tokenHash,
        command.at,
        command.at,
        command.device.personId,
      )
      return true
    })
    return claim.immediate()
  }
  if (command.type === "create-invite") {
    if (!isActiveAdmin(db, command.invite.createdByPersonId)) return false
    const claim = db.transaction(() => {
      if (db.query("SELECT 1 FROM people WHERE email = ? AND removed_at IS NULL LIMIT 1").get(command.invite.email))
        return false
      db.query("UPDATE invites SET revoked_at = ? WHERE email = ? AND used_at IS NULL AND revoked_at IS NULL").run(
        command.at,
        command.invite.email,
      )
      db.query(
        "INSERT INTO invites(id,token_hash,name,email,role,channel_ids_json,created_by_person_id,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
      ).run(
        command.invite.id,
        command.invite.tokenHash,
        command.invite.name,
        command.invite.email,
        command.invite.role,
        command.invite.channelIdsJson,
        command.invite.createdByPersonId,
        command.at,
        command.expiresAt,
      )
      return true
    })
    return claim.immediate()
  }
  if (command.type === "resend-invite") {
    if (!isActiveAdmin(db, command.actorPersonId)) return false
    const result = db
      .query(
        "UPDATE invites SET token_hash = ?, created_at = ?, expires_at = ?, created_by_person_id = ?, revoked_at = NULL WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL",
      )
      .run(command.tokenHash, command.at, command.expiresAt, command.actorPersonId, command.id)
    return result.changes === 1
  }
  if (command.type === "revoke-invite") {
    if (!isActiveAdmin(db, command.actorPersonId)) return false
    const result = db
      .query("UPDATE invites SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL")
      .run(command.at, command.id)
    return result.changes === 1
  }
  if (command.type === "claim-invite") {
    const claim = db.transaction(() => {
      const invite = db
        .query(
          "SELECT * FROM invites WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?",
        )
        .get(command.tokenHash, command.at) as {
        token_hash: string
        name: string
        email: string
        role: "member" | "admin"
        channel_ids_json: string
      } | null
      const savedHash = invite?.token_hash ?? "0".repeat(64)
      const providedHash = command.tokenHash.length === 64 ? command.tokenHash : "0".repeat(64)
      const matches = timingSafeEqual(Buffer.from(savedHash), Buffer.from(providedHash))
      if (!invite || !matches || invite.email !== command.email) return false
      const used = db
        .query(
          "UPDATE invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?",
        )
        .run(command.at, command.tokenHash, command.at)
      if (used.changes !== 1) return false
      db.query("INSERT INTO people(id,name,email,avatar_seed,role,created_at) VALUES(?,?,?,?,?,?)").run(
        command.person.id,
        invite.name,
        invite.email,
        command.person.avatarSeed,
        invite.role,
        command.at,
      )
      db.query("INSERT INTO devices(id,name,token_hash,created_at,last_seen_at,person_id) VALUES(?,?,?,?,?,?)").run(
        command.device.id,
        command.device.name,
        command.device.tokenHash,
        command.at,
        command.at,
        command.person.id,
      )
      const channelIds = JSON.parse(invite.channel_ids_json) as Array<string>
      channelIds.forEach((channelId) => {
        db.query("INSERT INTO person_channels(person_id,channel_id,created_at) VALUES(?,?,?)").run(
          command.person.id,
          channelId,
          command.at,
        )
      })
      return true
    })
    return claim.immediate()
  }
  if (command.type === "remove-person") {
    if (!isActiveAdmin(db, command.actorPersonId) || command.id === "owner") return false
    const remove = db.transaction(() => {
      const person = db.query("SELECT role FROM people WHERE id = ? AND removed_at IS NULL").get(command.id) as {
        role: "member" | "admin"
      } | null
      if (!person) return false
      if (person.role === "admin") {
        const activeAdmins = db
          .query("SELECT COUNT(*) AS total FROM people WHERE role = 'admin' AND removed_at IS NULL")
          .get() as { total: number }
        if (activeAdmins.total <= 1) return false
      }
      db.query("UPDATE people SET removed_at = ? WHERE id = ? AND removed_at IS NULL").run(command.at, command.id)
      db.query("UPDATE devices SET revoked_at = ? WHERE person_id = ? AND revoked_at IS NULL").run(
        command.at,
        command.id,
      )
      db.query("DELETE FROM person_channels WHERE person_id = ?").run(command.id)
      db.query(`UPDATE invites SET revoked_at = ? WHERE email = (SELECT email FROM people WHERE id = ?)
        OR (created_by_person_id = ? AND used_at IS NULL AND revoked_at IS NULL)`).run(
        command.at,
        command.id,
        command.id,
      )
      return true
    })
    return remove.immediate()
  }
  if (command.type === "save-email-config") {
    if (!isActiveAdmin(db, command.actorPersonId)) return false
    db.query(
      "INSERT INTO email_config(id,config_json,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json,updated_at=excluded.updated_at",
    ).run(command.configJson, command.at)
    return true
  }
  if (command.type === "last-seen") {
    db.query("UPDATE devices SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL").run(command.at, command.id)
    return true
  }
  if (command.type === "rotate-token") {
    const result = db
      .query("UPDATE devices SET token_hash = ? WHERE id = ? AND token_hash = ? AND revoked_at IS NULL")
      .run(command.tokenHash, command.id, command.previousHash)
    return result.changes === 1
  }
  const result = db
    .query("UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .run(command.at, command.id)
  return result.changes === 1
}

self.onmessage = ({ data }: MessageEvent<WriterRequest>): void => {
  if (data.type === "start") {
    try {
      database = openAuthDatabase(data.filename)
      self.postMessage({ type: "ready" } satisfies WriterMessage)
    } catch (error) {
      self.postMessage({ type: "startup-error", error: toWorkerError(error) } satisfies WriterMessage)
    }
    return
  }
  if (data.type === "stop") {
    database?.close()
    database = undefined
    self.postMessage({ type: "stopped" } satisfies WriterMessage)
    self.close()
    return
  }

  try {
    self.postMessage({ requestId: data.requestId, result: execute(data) } satisfies WriterMessage)
  } catch (error) {
    self.postMessage({ requestId: data.requestId, error: toWorkerError(error) } satisfies WriterMessage)
  }
}

const toWorkerError = (error: unknown): { name: string; message: string; code?: string } => {
  if (!(error instanceof Error)) return { name: "Error", message: String(error) }
  const code = (error as Error & { code?: unknown }).code
  return {
    name: error.name,
    message: error.message,
    ...(typeof code === "string" ? { code } : {}),
  }
}
