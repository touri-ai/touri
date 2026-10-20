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
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  avatar_seed TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('member','admin')),
  created_at INTEGER NOT NULL,
  removed_at INTEGER
);
CREATE TABLE IF NOT EXISTS person_channels (
  person_id TEXT NOT NULL REFERENCES people(id),
  channel_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (person_id, channel_id)
);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('member','admin')),
  channel_ids_json TEXT NOT NULL,
  created_by_person_id TEXT NOT NULL REFERENCES people(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS email_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  config_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`

export const ownerPersonId = "owner"

const authTables = ["pairing_codes", "devices", "people", "person_channels", "invites", "email_config"]

const hasAuthSchema = (database: Database): boolean =>
  authTables.every((name) =>
    Boolean(database.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)),
  )

const migrateAuthDatabase = (database: Database): void => {
  const hasPersonColumn = (): boolean =>
    (database.query("PRAGMA table_info(devices)").all() as Array<{ name: string }>).some(
      ({ name }) => name === "person_id",
    )
  if (hasPersonColumn()) return
  database
    .transaction(() => {
      if (hasPersonColumn()) return
      database.exec("ALTER TABLE devices ADD COLUMN person_id TEXT REFERENCES people(id)")
      database
        .query("INSERT OR IGNORE INTO people(id,name,email,avatar_seed,role,created_at) VALUES(?,?,?,?,?,?)")
        .run(ownerPersonId, "Owner", null, ownerPersonId, "admin", Date.now())
      database.query("UPDATE devices SET person_id = ? WHERE person_id IS NULL").run(ownerPersonId)
      database.exec(`
      CREATE INDEX IF NOT EXISTS devices_person_id ON devices(person_id, revoked_at);
      CREATE INDEX IF NOT EXISTS people_active_created ON people(removed_at, created_at, id);
      CREATE UNIQUE INDEX IF NOT EXISTS people_email_active ON people(email) WHERE email IS NOT NULL AND removed_at IS NULL;
      CREATE INDEX IF NOT EXISTS person_channels_channel_id ON person_channels(channel_id, person_id);
      CREATE INDEX IF NOT EXISTS invites_email_created ON invites(email, created_at DESC);
      CREATE INDEX IF NOT EXISTS invites_created_at ON invites(created_at DESC, id);
      CREATE TRIGGER IF NOT EXISTS devices_require_person_insert
      BEFORE INSERT ON devices WHEN NEW.person_id IS NULL
      BEGIN SELECT RAISE(ABORT, 'device requires a person'); END;
      CREATE TRIGGER IF NOT EXISTS devices_require_person_update
      BEFORE UPDATE OF person_id ON devices WHEN NEW.person_id IS NULL
      BEGIN SELECT RAISE(ABORT, 'device requires a person'); END;
    `)
    })
    .immediate()
}

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
      for (const statement of ["PRAGMA journal_mode = WAL", "PRAGMA synchronous = FULL", "PRAGMA foreign_keys = ON"]) {
        const remainingMs = Math.max(1, Math.ceil(deadline - performance.now()))
        database.exec(`PRAGMA busy_timeout = ${remainingMs}`)
        database.exec(statement)
      }
      if (!hasAuthSchema(database)) {
        database.exec(`PRAGMA busy_timeout = ${Math.max(1, Math.ceil(deadline - performance.now()))}`)
        database.exec(schema)
      }
      migrateAuthDatabase(database)
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
