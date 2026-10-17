import type { Database } from "bun:sqlite"

type SchemaObject = { type: "trigger" | "view"; name: string; sql: string }

// Call inside the rebuild transaction so any failure also restores these objects.
export const withSuspendedSchemaObjects = (database: Database, rebuild: () => void): void => {
  // ALTER TABLE validates the entire schema while the original table is absent.
  // Suspend all triggers and views, including cross-table triggers and indirect
  // view dependencies, until every table has its original name again. Keep their
  // creation order: triggers on views must be restored after their views.
  const objects = database
    .query("SELECT type, name, sql FROM sqlite_schema WHERE type IN ('trigger','view') ORDER BY rowid")
    .all() as Array<SchemaObject>
  // Dropping a view also drops its INSTEAD OF triggers; remove triggers first.
  for (const type of ["trigger", "view"] as const)
    for (const object of objects.filter((object) => object.type === type))
      database.exec(`DROP ${type.toUpperCase()} "${object.name.replaceAll('"', '""')}"`)
  rebuild()
  for (const object of objects) database.exec(object.sql)
}
