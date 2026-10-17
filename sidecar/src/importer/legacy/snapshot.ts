import { CString, dlopen, JSCallback, type Pointer } from "bun:ffi"
import { sqliteLibrary } from "../../platform/posix"
import { lstatSync } from "./fs"

export const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024
const openNative = () =>
  dlopen(sqliteLibrary, {
    sqlite3_open_v2: { args: ["cstring", "ptr", "i32", "ptr"], returns: "i32" },
    sqlite3_close_v2: { args: ["ptr"], returns: "i32" },
    sqlite3_set_authorizer: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
    sqlite3_prepare_v2: { args: ["ptr", "cstring", "i32", "ptr", "ptr"], returns: "i32" },
    sqlite3_step: { args: ["ptr"], returns: "i32" },
    sqlite3_finalize: { args: ["ptr"], returns: "i32" },
    sqlite3_column_count: { args: ["ptr"], returns: "i32" },
    sqlite3_column_name: { args: ["ptr", "i32"], returns: "cstring" },
    sqlite3_column_type: { args: ["ptr", "i32"], returns: "i32" },
    sqlite3_column_double: { args: ["ptr", "i32"], returns: "f64" },
    sqlite3_column_text: { args: ["ptr", "i32"], returns: "ptr" },
    sqlite3_column_bytes: { args: ["ptr", "i32"], returns: "i32" },
    sqlite3_errmsg: { args: ["ptr"], returns: "cstring" },
  }).symbols
let cachedNative: ReturnType<typeof openNative> | undefined
const sqlite = () => (cachedNative ??= openNative())

/** Bun 1.2 has no authorizer API. Use an independent readonly SQLite handle,
 * never Bun's numeric handle index. Only direct reads of the two source tables
 * are authorized; views, virtual tables, functions, ATTACH and every write fail. */
export const openLegacySnapshot = (path: string) => {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SNAPSHOT_BYTES)
    throw new Error("Snapshot must be a bounded regular SQLite file")
  const pointer = new BigUint64Array(1)
  const code = sqlite().sqlite3_open_v2(Buffer.from(`${path}\0`), pointer, 1, null)
  const db = Number(pointer[0]) as Pointer
  if (code !== 0) {
    if (db) sqlite().sqlite3_close_v2(db)
    throw new Error("Unable to open source snapshot read-only")
  }
  const authorizer = new JSCallback(
    (_context, action, table, _column, database, view) => {
      if (view || (database && new CString(database).toString() !== "main")) return 1
      if (action === 21) return 0 // SQLITE_SELECT
      if (action === 20 && table && ["messages", "thread_state"].includes(new CString(table).toString())) return 0
      return 1 // SQLITE_DENY, including ATTACH and VACUUM INTO's implicit ATTACH
    },
    { args: ["ptr", "i32", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
  )
  if (sqlite().sqlite3_set_authorizer(db, authorizer.ptr, null) !== 0) {
    sqlite().sqlite3_close_v2(db)
    authorizer.close()
    throw new Error("Unable to protect source snapshot")
  }
  let closed = false
  return {
    query: (sql: string) => ({
      all: (): Array<Record<string, unknown>> => {
        if (closed) throw new Error("Snapshot is closed")
        const statement = new BigUint64Array(1)
        const prepared = sqlite().sqlite3_prepare_v2(db, Buffer.from(`${sql}\0`), -1, statement, null)
        const handle = Number(statement[0]) as Pointer
        try {
          if (prepared !== 0) throw new Error(String(sqlite().sqlite3_errmsg(db)))
          const rows: Array<Record<string, unknown>> = []
          let bytes = 0
          while (true) {
            const status = sqlite().sqlite3_step(handle)
            if (status === 101) break // SQLITE_DONE
            if (status !== 100) throw new Error(String(sqlite().sqlite3_errmsg(db)))
            const row: Record<string, unknown> = {}
            for (let column = 0; column < sqlite().sqlite3_column_count(handle); column++) {
              const name = String(sqlite().sqlite3_column_name(handle, column))
              const type = sqlite().sqlite3_column_type(handle, column)
              const size = sqlite().sqlite3_column_bytes(handle, column)
              bytes += size
              if (bytes > MAX_SNAPSHOT_BYTES || rows.length >= 1_000_000)
                throw new Error("Snapshot rows exceed import limit")
              row[name] =
                type === 5
                  ? null
                  : type === 1 || type === 2
                    ? sqlite().sqlite3_column_double(handle, column)
                    : size === 0
                      ? ""
                      : new CString(sqlite().sqlite3_column_text(handle, column), 0, size).toString()
            }
            rows.push(row)
          }
          return rows
        } finally {
          if (handle) sqlite().sqlite3_finalize(handle)
        }
      },
    }),
    close: () => {
      if (closed) return
      closed = true
      sqlite().sqlite3_close_v2(db)
      authorizer.close()
    },
  }
}

export type LegacySnapshot = ReturnType<typeof openLegacySnapshot>
