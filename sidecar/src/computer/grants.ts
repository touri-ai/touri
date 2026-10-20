import type { Database } from "bun:sqlite"
import type { Id, Kernel, Result } from "@touri/contracts"
import { expiryAt } from "../kernel/policy"

export type ComputerGrant = {
  id: Id
  botId: Id
  threadId: Id | null
  grantedAt: number
  expiresAt: number
  revokedAt: number | null
  revokedBy: "user" | "kill-switch" | "expiry" | null
}

type RawGrant = {
  id: string
  bot_id: string
  thread_id: string | null
  granted_at: number
  expires_at: number
  revoked_at: number | null
  revoked_by: "user" | "kill-switch" | "expiry" | null
}

export type GrantStore = {
  create: (args: { botId: Id; threadId: Id; minutes: number }) => Result<{ grant: ComputerGrant }, "INVALID_GRANT">
  active: (args: { botId: Id; threadId: Id; at?: number }) => ComputerGrant | null
  revokeAll: (args: { revokedBy: "user" | "kill-switch" | "expiry" }) => number
  revoke: (args: { grantId: Id; revokedBy: "user" | "kill-switch" | "expiry" }) => boolean
  expire: (args?: { at?: number }) => number
  countActive: (args?: { at?: number }) => number
}

const asGrant = (row: RawGrant): ComputerGrant => ({
  id: row.id,
  botId: row.bot_id,
  threadId: row.thread_id,
  grantedAt: row.granted_at,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
  revokedBy: row.revoked_by,
})

const isValidMinutes = (minutes: number): boolean => Number.isInteger(minutes) && minutes >= 5 && minutes <= 120

export const createGrantStore = ({ kernel, now = Date.now }: { kernel: Kernel; now?: () => number }): GrantStore => {
  const database = kernel.db as Database

  const active = ({ botId, threadId, at = now() }: { botId: Id; threadId: Id; at?: number }): ComputerGrant | null => {
    const row = database
      .query(
        `SELECT id, bot_id, thread_id, granted_at, expires_at, revoked_at, revoked_by
           FROM computer_grants
          WHERE bot_id = ? AND thread_id = ? AND revoked_at IS NULL AND expires_at > ?
          ORDER BY granted_at DESC
          LIMIT 1`,
      )
      .get(botId, threadId, at) as RawGrant | null
    return row ? asGrant(row) : null
  }

  const create = ({ botId, threadId, minutes }: { botId: Id; threadId: Id; minutes: number }) => {
    if (!isValidMinutes(minutes))
      return {
        success: false as const,
        errorCode: "INVALID_GRANT" as const,
        error: "Computer grants must last between 5 and 120 minutes",
      }

    const grantedAt = now()
    const existing = active({ botId, threadId, at: grantedAt })
    if (existing) {
      const expiresAt = Math.max(existing.expiresAt, expiryAt({ now: grantedAt, ttlMs: minutes * 60_000 }))
      database.query("UPDATE computer_grants SET expires_at = ? WHERE id = ?").run(expiresAt, existing.id)
      return {
        success: true as const,
        grant: { ...existing, expiresAt },
      }
    }

    const id = kernel.newId()
    const expiresAt = expiryAt({ now: grantedAt, ttlMs: minutes * 60_000 })
    database
      .query(
        `INSERT INTO computer_grants (id, bot_id, thread_id, granted_at, expires_at, revoked_at, revoked_by)
         VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(id, botId, threadId, grantedAt, expiresAt)
    return {
      success: true as const,
      grant: { id, botId, threadId, grantedAt, expiresAt, revokedAt: null, revokedBy: null },
    }
  }

  const revokeAll = ({ revokedBy }: { revokedBy: "user" | "kill-switch" | "expiry" }): number => {
    const result = database
      .query("UPDATE computer_grants SET revoked_at = ?, revoked_by = ? WHERE revoked_at IS NULL")
      .run(now(), revokedBy)
    return result.changes
  }

  const revoke = ({ grantId, revokedBy }: { grantId: Id; revokedBy: "user" | "kill-switch" | "expiry" }): boolean => {
    const result = database
      .query("UPDATE computer_grants SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL")
      .run(now(), revokedBy, grantId)
    return result.changes > 0
  }

  const expire = ({ at = now() }: { at?: number } = {}): number => {
    const pending = database
      .query("SELECT 1 FROM computer_grants WHERE revoked_at IS NULL AND expires_at <= ? LIMIT 1")
      .get(at)
    if (!pending) return 0

    const busyTimeout = (database.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout
    database.exec("PRAGMA busy_timeout = 0")
    try {
      return database
        .query(`UPDATE computer_grants SET revoked_at = ?, revoked_by = 'expiry'
        WHERE id IN (SELECT id FROM computer_grants WHERE revoked_at IS NULL AND expires_at <= ?
          ORDER BY expires_at LIMIT 50)`)
        .run(at, at).changes
    } catch (error) {
      // Timestamp checks in active() deny expired grants while bookkeeping retries.
      if (isSqliteBusy(error)) return 0
      throw error
    } finally {
      database.exec(`PRAGMA busy_timeout = ${busyTimeout}`)
    }
  }

  const countActive = ({ at = now() }: { at?: number } = {}): number => {
    const row = database
      .query("SELECT COUNT(*) AS count FROM computer_grants WHERE revoked_at IS NULL AND expires_at > ?")
      .get(at) as { count: number }
    return row.count
  }

  return { create, active, revokeAll, revoke, expire, countActive }
}

const isSqliteBusy = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string" &&
  (error.code.startsWith("SQLITE_BUSY") || error.code.startsWith("SQLITE_LOCKED"))
