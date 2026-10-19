import { Database, constants as sqliteFlags } from "bun:sqlite"
import { dirname } from "node:path"
import { prepareDatabaseFile } from "./files"
import { prepareHistoryBackfill } from "./history-backfill"
import { legacySourceRebuild } from "./legacySourceRebuild"
import migrationSql from "./migrations/0001.sql" with { type: "text" }
import notificationsSql from "./migrations/0002.sql" with { type: "text" }
import avatarsSql from "./migrations/0003.sql" with { type: "text" }
import machinesSql from "./migrations/0004.sql" with { type: "text" }
import rolesSql from "./migrations/0005.sql" with { type: "text" }
import mcpServersSql from "./migrations/0006.sql" with { type: "text" }
import transcriptSql from "./migrations/0007.sql" with { type: "text" }
import groupsSql from "./migrations/0008.sql" with { type: "text" }
import cloudSql from "./migrations/0009.sql" with { type: "text" }
import recoverySql from "./migrations/0010.sql" with { type: "text" }
import reportsSql from "./migrations/0011.sql" with { type: "text" }
import opencodeSql from "./migrations/0012.sql" with { type: "text" }
import workRecoverySql from "./migrations/0013.sql" with { type: "text" }
import legacySourceSql from "./migrations/0014.sql" with { type: "text" }
import continuationsSql from "./migrations/0015.sql" with { type: "text" }
import botFoldersSql from "./migrations/0016.sql" with { type: "text" }
import providerProfilesSql from "./migrations/0017.sql" with { type: "text" }
import permissionContinuationsSql from "./migrations/0018.sql" with { type: "text" }
import botBrowserSql from "./migrations/0019.sql" with { type: "text" }
import responseActivitySql from "./migrations/0020.sql" with { type: "text" }
import workspaceActivitySql from "./migrations/0021.sql" with { type: "text" }
import transcriptReferencesSql from "./migrations/0022.sql" with { type: "text" }
import streamWriterSql from "./migrations/0023.sql" with { type: "text" }
import groupRoutinesSql from "./migrations/0024.sql" with { type: "text" }
import goalsSql from "./migrations/0025.sql" with { type: "text" }
import recoveryCenterSql from "./migrations/0026.sql" with { type: "text" }
import messageSearchSql from "./migrations/0027.sql" with { type: "text" }
import groupDeletionSql from "./migrations/0028.sql" with { type: "text" }
import computerGrantExpirySql from "./migrations/0029.sql" with { type: "text" }
import groupCoordinationHistorySql from "./migrations/0030.sql" with { type: "text" }
import { withSuspendedSchemaObjects } from "./schema-rebuild"
import { instrumentMainConnection, type SlowStatementTracker } from "./sqlite-performance"
import { applyUpgradeBaselines } from "./upgradeBaselines"

export const SCHEMA_VERSION = 30

const FREE_PAGE_RATIO_LIMIT = 0.2

const reclaimRebuiltPages = (database: Database): void => {
  const free = (database.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count
  const total = (database.query("PRAGMA page_count").get() as { page_count: number }).page_count
  if (total > 0 && free / total > FREE_PAGE_RATIO_LIMIT) database.exec("VACUUM")
}

export const openDatabase = ({
  filename,
  slowStatements,
}: {
  filename: string
  slowStatements?: SlowStatementTracker
}): Database => {
  const databasePath = prepareDatabaseFile({ root: dirname(filename), path: filename })
  const rawDatabase = new Database(
    databasePath,
    sqliteFlags.SQLITE_OPEN_READWRITE | sqliteFlags.SQLITE_OPEN_CREATE | sqliteFlags.SQLITE_OPEN_NOFOLLOW,
  )
  const database = slowStatements ? instrumentMainConnection(rawDatabase, slowStatements) : rawDatabase
  // Before the first table is created, new stores can opt into bounded page
  // reclamation without a full rewrite. Existing stores reuse their free pages.
  // WAL with synchronous=NORMAL (SQLite's recommended pairing) keeps commits atomic and the store
  // safe from application crashes without an fsync on every commit; only the newest transactions
  // can be lost on an OS crash or power loss. FULL made each commit wait on the disk on the main
  // thread, freezing the server for seconds whenever the disk was busy (#454).
  // A 64 MB page cache keeps the hot part of large stores in process memory; with SQLite's 2 MB
  // default every query re-read its pages from the disk on the main thread once the OS evicted
  // them, which froze the server for seconds while the disk was busy (#470).
  database.exec(
    "PRAGMA busy_timeout = 5000; PRAGMA auto_vacuum = INCREMENTAL; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA journal_size_limit = 8388608; PRAGMA synchronous = NORMAL; PRAGMA cache_size = -65536;",
  )
  database.exec(migrationSql)
  database.exec(notificationsSql)
  database.transaction(() => {
    const migrated = database.query("SELECT value FROM schema_meta WHERE key = 'avatar_identity_version'").get()
    if (!migrated) database.exec(avatarsSql)
  })()
  database.transaction(() => {
    const columns = database.query("PRAGMA table_info(bots)").all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === "machine")) database.exec(machinesSql)
  })()
  database.transaction(() => {
    const columns = database.query("PRAGMA table_info(bots)").all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === "role_line")) database.exec(rolesSql)
    database.exec(
      "INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('bot_role_version', '1'); UPDATE schema_meta SET value = '5' WHERE key = 'schema_version';",
    )
  })()
  database.exec(mcpServersSql)
  database.transaction(() => {
    const migrated = database.query("SELECT value FROM schema_meta WHERE key = 'transcript_version'").get()
    if (!migrated) {
      // 0007 is a shipped artifact. Apply its DDL verbatim, but defer its two
      // bulk data statements to the resumable worker. Do not rewrite the asset.
      const dataStart = transcriptSql.indexOf("WITH ordered AS (")
      const viewStart = transcriptSql.indexOf("CREATE VIEW transcript_message_events AS")
      const entriesStart = transcriptSql.indexOf(
        "INSERT INTO transcript_entries(thread_id, seq, generation, event_json, at)",
      )
      const triggersStart = transcriptSql.indexOf("CREATE TRIGGER messages_transcript_insert")
      database.exec(transcriptSql.slice(0, dataStart))
      database.exec(transcriptSql.slice(viewStart, entriesStart))
      database.exec(transcriptSql.slice(triggersStart))
      prepareHistoryBackfill(database)
    }
    database.exec("UPDATE schema_meta SET value = '7' WHERE key = 'schema_version'")
  })()
  database.transaction(() => {
    if (!database.query("SELECT value FROM schema_meta WHERE key = 'groups_version'").get()) database.exec(groupsSql)
    database.exec("UPDATE schema_meta SET value = '8' WHERE key = 'schema_version'")
  })()
  database.transaction(() => {
    const columns = database.query("PRAGMA table_info(bots)").all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === "cloud_target")) database.exec(cloudSql)
    database.exec("UPDATE schema_meta SET value = '9' WHERE key = 'schema_version'")
  })()
  database.transaction(() => {
    if (!database.query("SELECT value FROM schema_meta WHERE key = 'transcript_recovery_version'").get())
      database.exec(recoverySql)
    database.exec("UPDATE schema_meta SET value = '10' WHERE key = 'schema_version'")
  })()
  database.transaction(() => database.exec(reportsSql))()
  // Disabling FKs inside a transaction is ineffective. Rebuild without renaming
  // the original tables so inbound references continue to point to their names.
  database.exec("PRAGMA foreign_keys = OFF")
  let rebuilt: Array<string> = []
  try {
    database.transaction(() => {
      // Normalize historical source constraints and rows before 0012 copies bots
      // into a table whose source constraint already expects the current label.
      const result = legacySourceRebuild({ database })
      if (!result.success) throw new Error(`Legacy source migration: ${result.error}`)
      rebuilt = result.rebuilt
      const needsSessionRebuild = !database
        .query("SELECT value FROM schema_meta WHERE key = 'opencode_provider_version'")
        .get()
      if (needsSessionRebuild) {
        const objects = database
          .query(
            "SELECT name, sql FROM sqlite_schema WHERE tbl_name IN ('bots','provider_sessions') AND type IN ('index','trigger') AND sql IS NOT NULL",
          )
          .all() as Array<{ name: string; sql: string }>
        const counts = ["bots", "provider_sessions"].map((table) => ({
          table,
          count: (database.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
        }))
        withSuspendedSchemaObjects(database, () => database.exec(opencodeSql))
        for (const { table, count } of counts)
          if ((database.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n !== count)
            throw new Error("OpenCode migration: row count changed")
        for (const object of objects) {
          if (!database.query("SELECT 1 FROM sqlite_schema WHERE name = ?").get(object.name)) database.exec(object.sql)
        }
      }
      // This audit walks every FK-bearing table, including large histories. A
      // normal restart has not rebuilt anything and must not reread the store.
      if ((rebuilt.length || needsSessionRebuild) && database.query("PRAGMA foreign_key_check").all().length)
        throw new Error("Database rebuild: invalid foreign keys")
      database.exec("UPDATE schema_meta SET value = '12' WHERE key = 'schema_version'")
    })()
  } finally {
    database.exec("PRAGMA foreign_keys = ON")
  }
  if (rebuilt.length) reclaimRebuiltPages(database)
  database.transaction(() => database.exec(workRecoverySql))()
  database.transaction(() => database.exec(legacySourceSql))()
  database.transaction(() => database.exec(continuationsSql))()
  database.transaction(() => {
    const columns = database.query("PRAGMA table_info(bots)").all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === "folders_json")) database.exec(botFoldersSql)
    database.exec("UPDATE schema_meta SET value = '16' WHERE key = 'schema_version'")
  })()
  database.transaction(() => {
    const columns = database.query("PRAGMA table_info(bots)").all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === "provider_profile")) database.exec(providerProfilesSql)
    database.exec("UPDATE schema_meta SET value = '17' WHERE key = 'schema_version'")
  })()
  database.transaction(() => {
    if (!database.query("SELECT value FROM schema_meta WHERE key = 'permission_continuations_version'").get())
      database.exec(permissionContinuationsSql)
    database.exec("UPDATE schema_meta SET value = '18' WHERE key = 'schema_version'")
  })()
  database.transaction(() => {
    const columns = database.query("PRAGMA table_info(bots)").all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === "browser")) database.exec(botBrowserSql)
    database.exec("UPDATE schema_meta SET value = '19' WHERE key = 'schema_version'")
  })()
  database.transaction(() => {
    const columns = database.query("PRAGMA table_info(runs)").all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === "provider_started_at")) database.exec(responseActivitySql)
    database.exec("UPDATE schema_meta SET value = '20' WHERE key = 'schema_version'")
  })()
  applyUpgradeBaselines({ database })
  database.transaction(() => {
    if (!database.query("SELECT 1 FROM schema_meta WHERE key = 'workspace_activity_version'").get())
      database.exec(workspaceActivitySql)
    if (!database.query("SELECT 1 FROM schema_meta WHERE key = 'transcript_projection_references_version'").get())
      database.exec(transcriptReferencesSql)
    if (!database.query("SELECT 1 FROM schema_meta WHERE key = 'stream_writer_version' AND value = '2'").get())
      database.exec(streamWriterSql)
    database.exec("UPDATE schema_meta SET value = '23' WHERE key = 'schema_version'")
  })()
  database.transaction(() => {
    const columns = database.query("PRAGMA table_info(routines)").all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === "group_id")) database.exec(groupRoutinesSql)
    database.exec("UPDATE schema_meta SET value = '24' WHERE key = 'schema_version'")
  })()
  database.transaction(() => database.exec(goalsSql))()
  database.transaction(() => database.exec(recoveryCenterSql))()
  database.transaction(() => {
    if (!database.query("SELECT 1 FROM schema_meta WHERE key = 'message_search_rows_version' AND value = '4'").get())
      database.exec(messageSearchSql)
    database.exec("UPDATE schema_meta SET value = '27' WHERE key = 'schema_version'")
  })()
  database.transaction(() => database.exec(groupDeletionSql))()
  database.transaction(() => database.exec(computerGrantExpirySql))()
  database.transaction(() => {
    const migrated = database.query("SELECT 1 FROM schema_meta WHERE key = 'group_coordination_history_version'").get()
    // Earlier migrations replay on startup, so a dedicated marker prevents rescanning history every time.
    if (!migrated) database.exec(groupCoordinationHistorySql)
    database.exec("UPDATE schema_meta SET value = '30' WHERE key = 'schema_version'")
  })()
  return database
}
