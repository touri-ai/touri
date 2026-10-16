import type { Database } from "bun:sqlite"
import { withSuspendedSchemaObjects } from "./schema-rebuild"

const SOURCE_TABLES = ["bots", "threads", "messages", "routines"] as const
const SOURCE_CHECK = /CHECK\s*\(\s*source\s+IN\s*\(\s*'local'\s*,\s*'[^']*'\s*\)\s*\)/
const LEGACY_SOURCE_SQL = "CHECK (source IN ('local','legacy'))"
const REBUILD_SUFFIX = "_legacy_source"

type SchemaObject = { name: string; sql: string }
type ColumnInfo = { name: string }

export type LegacySourceRebuildArgs = { database: Database }
export type LegacySourceRebuildSuccess = { success: true; rebuilt: Array<string> }
export type LegacySourceRebuildError = { success: false; error: string }
export type LegacySourceRebuildResult = LegacySourceRebuildSuccess | LegacySourceRebuildError

const tableSql = (database: Database, table: string): string | null =>
  (
    database.query("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) as {
      sql: string
    } | null
  )?.sql ?? null

const needsRebuild = (database: Database, table: string): boolean => {
  const sql = tableSql(database, table)
  return sql !== null && SOURCE_CHECK.test(sql) && !sql.includes(LEGACY_SOURCE_SQL)
}

const rowCount = (database: Database, table: string): number =>
  (database.query(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n

const dependentIndexes = (database: Database, table: string): Array<SchemaObject> =>
  database
    .query("SELECT name, sql FROM sqlite_schema WHERE tbl_name = ? AND type = 'index' AND sql IS NOT NULL")
    .all(table) as Array<SchemaObject>

const rebuiltDefinition = (sql: string, table: string): string =>
  sql
    .replace(new RegExp(`^CREATE TABLE\\s+("?)${table}\\1`), `CREATE TABLE "${table}${REBUILD_SUFFIX}"`)
    .replace(SOURCE_CHECK, LEGACY_SOURCE_SQL)

const rebuildTable = (database: Database, table: string): void => {
  const sql = tableSql(database, table) ?? ""
  const indexes = dependentIndexes(database, table)
  const columns = (database.query(`PRAGMA table_info("${table}")`).all() as Array<ColumnInfo>).map(
    (column) => `"${column.name}"`,
  )
  const selected = columns.map((column) =>
    column === '"source"' ? `CASE WHEN "source" = 'local' THEN 'local' ELSE 'legacy' END` : column,
  )
  const before = rowCount(database, table)
  database.exec(rebuiltDefinition(sql, table))
  database.exec(
    `INSERT INTO "${table}${REBUILD_SUFFIX}" (rowid, ${columns.join(", ")}) SELECT rowid, ${selected.join(", ")} FROM "${table}"`,
  )
  database.exec(`DROP TABLE "${table}"`)
  database.exec(`ALTER TABLE "${table}${REBUILD_SUFFIX}" RENAME TO "${table}"`)
  for (const index of indexes) database.exec(index.sql)
  if (rowCount(database, table) !== before) throw new Error(`legacy source rebuild: row count changed for ${table}`)
}

/**
 * Rebuilds every table whose `source` CHECK constraint accepts the pre-rename importer label so that it
 * accepts `legacy` instead, converting stored labels. Must run with foreign_keys OFF and inside a
 * transaction; callers verify foreign_key_check afterwards. Preserves rows (rowids included), indexes,
 * triggers and views, and leaves inbound foreign keys pointing at the unchanged table names.
 */
export const legacySourceRebuild = ({ database }: LegacySourceRebuildArgs): LegacySourceRebuildResult => {
  try {
    const pending = SOURCE_TABLES.filter((table) => needsRebuild(database, table))
    if (!pending.length) return { success: true, rebuilt: [] }

    withSuspendedSchemaObjects(database, () => {
      for (const table of pending) rebuildTable(database, table)
    })

    return { success: true, rebuilt: [...pending] }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"

    return { success: false, error: message }
  }
}
