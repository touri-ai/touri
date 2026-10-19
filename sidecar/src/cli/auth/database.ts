import { Database, SQLiteError, constants as sqliteFlags } from "bun:sqlite"

const busyTimeoutMs = 5000

export const schema = `
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

export const isDatabaseBusy = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code
  return (
    (error instanceof SQLiteError &&
      (error.code === "SQLITE_BUSY" || error.code?.startsWith("SQLITE_BUSY_") === true)) ||
    (typeof code === "string" && (code === "SQLITE_BUSY" || code.startsWith("SQLITE_BUSY_")))
  )
}

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

export const openAuthReader = (filename: string): Database => {
  const database = new Database(filename, sqliteFlags.SQLITE_OPEN_READONLY | sqliteFlags.SQLITE_OPEN_NOFOLLOW)
  database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`)
  return database
}
