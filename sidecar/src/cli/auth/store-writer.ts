import { openAuthDatabase } from "./database"

import type { WriteCommand, WriterMessage, WriterRequest } from "./store-protocol"

let database: ReturnType<typeof openAuthDatabase> | undefined

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
      db.query("INSERT INTO devices (id, name, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)").run(
        command.device.id,
        command.device.name,
        command.device.tokenHash,
        command.at,
        command.at,
      )
      return true
    })
    return claim()
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
