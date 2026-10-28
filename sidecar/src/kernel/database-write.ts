import type { Database } from "bun:sqlite"

const commitCallbacks = new WeakMap<Database, Set<() => void>>()

/** Register a handoff only for an owned transaction; rollback discards it. */
export const onDatabaseCommit = (database: Database, callback: () => void): boolean => {
  const callbacks = commitCallbacks.get(database)
  if (!callbacks) return false

  callbacks.add(callback)
  return true
}

const isBusy = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  typeof error.code === "string" &&
  (error.code.startsWith("SQLITE_BUSY") || error.code.startsWith("SQLITE_LOCKED"))

/** Acquire the writer slot before reading, and yield between bounded lock attempts. */
export const writeDatabaseAsync = async <Value>(database: Database, write: () => Value): Promise<Value> => {
  const transaction = database.transaction(write)
  const attempt = (): { result: Value; callbacks: Set<() => void> } => {
    const parent = commitCallbacks.get(database)
    const ownsCommit = !database.inTransaction
    const callbacks = new Set<() => void>()
    commitCallbacks.set(database, callbacks)
    try {
      const result = transaction.immediate()
      if (parent)
        callbacks.forEach((callback) => {
          parent.add(callback)
        })
      return { result, callbacks: ownsCommit ? callbacks : new Set<() => void>() }
    } finally {
      if (parent) commitCallbacks.set(database, parent)
      else commitCallbacks.delete(database)
    }
  }
  return retryDatabaseWriteAsync(database, attempt, (committed) => {
    // A delivery error cannot retry a transaction that already committed.
    committed.callbacks.forEach((callback) => {
      callback()
    })
    return committed.result
  })
}

/** Retry only replay-safe writes; callers own transaction boundaries and commit delivery. */
export function retryDatabaseWriteAsync<Value>(database: Database, write: () => Value): Promise<Value>
export function retryDatabaseWriteAsync<Value, Result>(
  database: Database,
  write: () => Value,
  afterWrite: (value: Value) => Result,
): Promise<Result>
export async function retryDatabaseWriteAsync<Value, Result>(
  database: Database,
  write: () => Value,
  afterWrite?: (value: Value) => Result,
): Promise<Value | Result> {
  const deadline = performance.now() + 5_000
  const busyTimeout = (database.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout
  const attempt = (): Value => {
    // Let the async retry yield instead of waiting inside SQLite on this thread.
    database.exec("PRAGMA busy_timeout = 0")
    try {
      return write()
    } finally {
      database.exec(`PRAGMA busy_timeout = ${busyTimeout}`)
    }
  }
  for (;;) {
    let result: Value
    try {
      result = attempt()
    } catch (error) {
      if (!isBusy(error) || performance.now() >= deadline) throw error
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
      continue
    }
    return afterWrite ? afterWrite(result) : result
  }
}
