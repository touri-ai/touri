import type { Database, SQLQueryBindings } from "bun:sqlite"

type QueryPlanRow = { id: number; parent: number; notused: number; detail: string }

export const getQueryPlan = (
  database: Database,
  sql: string,
  bindings: ReadonlyArray<SQLQueryBindings> = [],
): Array<QueryPlanRow> => {
  const statement = database.prepare(`EXPLAIN QUERY PLAN ${sql}`)
  try {
    return statement.all(...bindings) as Array<QueryPlanRow>
  } finally {
    // EXPLAIN can retain a read transaction after all(), hiding subsequent worker commits.
    statement.finalize()
  }
}
