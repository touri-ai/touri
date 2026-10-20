import type { Database, Statement } from "bun:sqlite"
import type { Kernel } from "@touri/contracts"
import type { PerformanceStage, PerformanceStageRunner } from "./performance"

export type SlowStatement = {
  stage: string
  sql: string
  calls: number
  totalMs: number
  maxMs: number
}

export type SqliteStatementTotals = {
  calls: number
  totalMs: number
}

export type SlowStatementTracker = {
  now: () => number
  runWithStage: <Value>(sql: string, action: () => Value) => Value
  recordDuration: (sql: string, durationMs: number) => void
  snapshot: () => Array<SlowStatement>
  snapshotTotals: () => SqliteStatementTotals
  reset: () => void
}

const DEFAULT_THRESHOLD_MS = 250
const MAX_NORMALIZED_SQL_LENGTH = 512
const TIMED_STATEMENT_METHODS = new Set<PropertyKey>(["run", "get", "all", "values", "raw"])
const TRANSACTION_MODES = ["default", "deferred", "immediate", "exclusive"] as const
const SQL_WRITE_TARGET =
  /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+(?:"|`|\[)?([a-z_][a-z0-9_]*)/i
const SQL_REDACTION_TOKENS =
  /--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:''|[^'])*'|'(?:''|[^'])*$|"(?:""|[^"])*"|"(?:""|[^"])*$|`(?:``|[^`])*`|`(?:``|[^`])*$|\[(?:\]\]|[^\]])*\]|\[(?:\]\]|[^\]])*$/g

export const createSlowStatementTracker = ({
  log,
  getStage,
  runStage,
  now = performance.now.bind(performance),
  thresholdMs = DEFAULT_THRESHOLD_MS,
}: {
  log: Kernel["log"]
  getStage: () => string | undefined
  runStage?: PerformanceStageRunner
  now?: () => number
  thresholdMs?: number
}): SlowStatementTracker => {
  let timings: Array<SlowStatement> = []
  let totalCalls = 0
  let totalMs = 0

  const runWithStage = <Value>(sql: string, action: () => Value): Value => {
    const current = getStage()
    // A transaction includes implicit BEGIN/COMMIT work. Its statements still
    // need their own labels; explicit caller stages keep their existing context.
    if (!runStage || (current && current !== "sqlite_transaction")) return action()

    return runStage(getSqliteStage(sql), action)
  }

  const recordDuration = (sql: string, durationMs: number): void => {
    totalCalls += 1
    totalMs += durationMs
    if (durationMs < thresholdMs) return

    const statement = normalizeSql(sql)
    const stage = getStage() ?? getSqliteStage(sql)
    const timing = { stage, sql: statement, durationMs }
    logSlowStatement({ log, timing })
    timings = recordSlowStatement(timings, timing)
  }

  return {
    now,
    runWithStage,
    recordDuration,
    snapshot: () => timings.map((timing) => ({ ...timing })),
    snapshotTotals: () => ({ calls: totalCalls, totalMs: getMilliseconds(totalMs) }),
    reset: () => {
      timings = []
      totalCalls = 0
      totalMs = 0
    },
  }
}

export const instrumentMainConnection = <Connection extends Database>(
  database: Connection,
  tracker: SlowStatementTracker,
): Connection => {
  // Bun caches prepared statements by SQL; keep each wrapped statement's identity.
  const statementProxies = new WeakMap<Statement, Statement>()
  const connection = Object.create(Object.getPrototypeOf(database)) as Connection

  getDatabaseMembers(database).forEach(({ property, descriptor }) => {
    const value = Reflect.get(database, property, database) as unknown
    if (typeof value === "function") {
      Object.defineProperty(connection, property, {
        configurable: true,
        enumerable: descriptor.enumerable ?? false,
        writable: true,
        value: instrumentDatabaseMethod({ database, connection, property, value, tracker, statementProxies }),
      })
      return
    }

    Object.defineProperty(connection, property, {
      configurable: true,
      enumerable: descriptor.enumerable ?? false,
      get: () => Reflect.get(database, property, database) as unknown,
      set: (next) => Reflect.set(database, property, next, database),
    })
  })

  return connection
}

const getSqliteStage = (sql: string): PerformanceStage => {
  if (sql === "TRANSACTION") return "sqlite_transaction"

  // Only inspect a bounded prefix and emit fixed labels, never table names or
  // values supplied by a caller. CTEs, comments and other SQL use the safe fallback.
  const table = sql.slice(0, MAX_NORMALIZED_SQL_LENGTH).match(SQL_WRITE_TARGET)?.[1]?.toLowerCase()
  if (table === "settings") return "sqlite_settings_write"
  if (table === "runs" || table === "routine_runs" || table === "provider_sessions") return "sqlite_run_write"
  if (table === "messages" || table === "messages_fts") return "sqlite_message_write"
  if (table === "notifications" || table === "notification_log") return "sqlite_notification_write"
  if (table === "recovery_tasks" || table === "work_journal" || table === "work_roots") return "sqlite_recovery_write"

  return "sqlite_main"
}

const measureStatement = <Value>(sql: string, tracker: SlowStatementTracker, action: () => Value): Value =>
  tracker.runWithStage(sql, () => {
    const startedAt = tracker.now()
    try {
      return action()
    } finally {
      tracker.recordDuration(sql, tracker.now() - startedAt)
    }
  })

const getDatabaseMembers = (database: Database): Array<{ property: PropertyKey; descriptor: PropertyDescriptor }> => {
  const ownMembers = getOwnMembers(database)
  const inheritedMembers = getPrototypeMembers(Object.getPrototypeOf(database))

  return [...ownMembers, ...inheritedMembers].filter(
    (member, index, members) => members.findIndex((existing) => existing.property === member.property) === index,
  )
}

const getOwnMembers = (target: object): Array<{ property: PropertyKey; descriptor: PropertyDescriptor }> =>
  Reflect.ownKeys(target).flatMap((property) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, property)
    return descriptor ? [{ property, descriptor }] : []
  })

const getPrototypeMembers = (
  prototype: object | null,
): Array<{ property: PropertyKey; descriptor: PropertyDescriptor }> => {
  if (!prototype || prototype === Object.prototype) return []

  const ownMembers = getOwnMembers(prototype).filter(({ property }) => property !== "constructor")

  return [...ownMembers, ...getPrototypeMembers(Object.getPrototypeOf(prototype))]
}

const instrumentDatabaseMethod = ({
  database,
  connection,
  property,
  value,
  tracker,
  statementProxies,
}: {
  database: Database
  connection: Database
  property: PropertyKey
  value: unknown
  tracker: SlowStatementTracker
  statementProxies: WeakMap<Statement, Statement>
}): unknown => {
  const method = value as (...args: Array<unknown>) => unknown
  if (property === "query" || property === "prepare")
    return (...args: Array<unknown>) => {
      const sql = args[0] as string
      return measureStatement(sql, tracker, () => {
        const statement = Reflect.apply(method, database, args) as Statement
        return instrumentStatement(statement, sql, tracker, statementProxies)
      })
    }
  if (property === "run" || property === "exec")
    return (...args: Array<unknown>) => {
      const sql = args[0] as string
      return measureStatement(sql, tracker, () => Reflect.apply(method, database, args))
    }
  if (property === "transaction")
    return (action: (...args: Array<unknown>) => unknown) => {
      const transaction = Reflect.apply(method, database, [action])
      return instrumentTransaction(transaction, connection, tracker)
    }

  return method.bind(database)
}

const instrumentStatement = (
  statement: Statement,
  sql: string,
  tracker: SlowStatementTracker,
  statementProxies: WeakMap<Statement, Statement>,
): Statement => {
  const existing = statementProxies.get(statement)
  if (existing) return existing

  const statementMethods = [
    ...Array.from(
      TIMED_STATEMENT_METHODS,
      (property) => [property, createTimedStatementMethod(statement, property, sql, tracker)] as const,
    ),
    ["iterate", createIteratorMethod(statement, "iterate", sql, tracker)] as const,
    [Symbol.iterator, createIteratorMethod(statement, Symbol.iterator, sql, tracker)] as const,
    ["as", createAsMethod(statement, sql, tracker, statementProxies)] as const,
  ] as const
  const wrappedMethods = new Map<PropertyKey, unknown>(statementMethods.filter(([, method]) => method !== undefined))
  const boundMethods = new Map<PropertyKey, (...args: Array<unknown>) => unknown>()
  const proxy = new Proxy(statement, {
    get: (target, property) => {
      if (wrappedMethods.has(property)) return wrappedMethods.get(property)

      const value = Reflect.get(target, property, target) as unknown
      if (typeof value === "function") {
        const bound = boundMethods.get(property)
        if (bound) return bound

        const binding = value.bind(target) as (...args: Array<unknown>) => unknown
        boundMethods.set(property, binding)
        return binding
      }

      return value
    },
  })

  statementProxies.set(statement, proxy)
  return proxy
}

const createTimedStatementMethod = (
  statement: Statement,
  property: PropertyKey,
  sql: string,
  tracker: SlowStatementTracker,
): unknown => {
  const method = Reflect.get(statement, property, statement) as unknown
  if (typeof method !== "function") return undefined

  return (...args: Array<unknown>) => measureStatement(sql, tracker, () => Reflect.apply(method, statement, args))
}

const createIteratorMethod = (
  statement: Statement,
  property: PropertyKey,
  sql: string,
  tracker: SlowStatementTracker,
): unknown => {
  const method = Reflect.get(statement, property, statement) as unknown
  if (typeof method !== "function") return undefined

  return (...args: Array<unknown>) =>
    measureStatement(sql, tracker, () =>
      instrumentIterator(Reflect.apply(method, statement, args) as IterableIterator<unknown>, sql, tracker),
    )
}

const createAsMethod = (
  statement: Statement,
  sql: string,
  tracker: SlowStatementTracker,
  statementProxies: WeakMap<Statement, Statement>,
): unknown => {
  const method = Reflect.get(statement, "as", statement) as unknown
  if (typeof method !== "function") return undefined

  return (...args: Array<unknown>) =>
    instrumentStatement(Reflect.apply(method, statement, args) as Statement, sql, tracker, statementProxies)
}

const instrumentTransaction = (transaction: unknown, connection: Database, tracker: SlowStatementTracker): unknown => {
  if (typeof transaction !== "function") return transaction

  const wrappedModes = TRANSACTION_MODES.flatMap((property) => {
    const method = Reflect.get(transaction, property, transaction) as unknown
    if (typeof method !== "function") return []
    const descriptor = Object.getOwnPropertyDescriptor(transaction, property)

    const wrappedMethod = (...args: Array<unknown>) =>
      measureStatement("TRANSACTION", tracker, () => Reflect.apply(method, transaction, args))
    const wrappedDescriptor = {
      configurable: descriptor?.configurable ?? true,
      enumerable: descriptor?.enumerable ?? true,
      writable: descriptor && "writable" in descriptor ? descriptor.writable : true,
      value: wrappedMethod,
    }

    return [[property, wrappedDescriptor] as const]
  })

  const wrappedTransaction = (...args: Array<unknown>) =>
    measureStatement("TRANSACTION", tracker, () => Reflect.apply(transaction, transaction, args))

  // Bun's transaction functions also expose the connection they run on.
  Object.defineProperties(wrappedTransaction, {
    ...Object.fromEntries(wrappedModes),
    database: { configurable: true, enumerable: true, writable: false, value: connection },
  })

  return wrappedTransaction
}

const instrumentIterator = (
  iterator: IterableIterator<unknown>,
  sql: string,
  tracker: SlowStatementTracker,
): IterableIterator<unknown> => {
  let finished = false
  let totalMs = 0

  const finish = (): void => {
    if (finished) return
    finished = true
    tracker.recordDuration(sql, totalMs)
  }

  const next = (...args: Array<unknown>): IteratorResult<unknown> =>
    tracker.runWithStage(sql, () => {
      const callStartedAt = tracker.now()
      try {
        const result = Reflect.apply(iterator.next, iterator, args) as IteratorResult<unknown>
        totalMs += tracker.now() - callStartedAt
        if (result.done) finish()
        return result
      } catch (error) {
        totalMs += tracker.now() - callStartedAt
        finish()
        throw error
      }
    })

  const iteratorThrow = iterator.throw
  const wrappedThrow =
    typeof iteratorThrow === "function"
      ? {
          throw: (error?: unknown) =>
            tracker.runWithStage(sql, () => {
              const callStartedAt = tracker.now()
              try {
                const result = Reflect.apply(iteratorThrow, iterator, [error]) as IteratorResult<unknown>
                totalMs += tracker.now() - callStartedAt
                if (result.done) finish()
                return result
              } catch (caught) {
                totalMs += tracker.now() - callStartedAt
                finish()
                throw caught
              }
            }),
        }
      : {}

  const wrappedIterator = {
    next,
    return: (value?: unknown) =>
      tracker.runWithStage(sql, () => {
        finish()
        return iterator.return ? Reflect.apply(iterator.return, iterator, [value]) : { done: true, value }
      }),
    ...wrappedThrow,
    [Symbol.iterator]() {
      return this
    },
  }

  const disposeSymbol = Reflect.get(Symbol, "dispose") as symbol | undefined
  if (!disposeSymbol) return wrappedIterator

  const dispose = Reflect.get(iterator, disposeSymbol) as unknown
  if (typeof dispose !== "function") return wrappedIterator

  return {
    ...wrappedIterator,
    [disposeSymbol]: () =>
      tracker.runWithStage(sql, () => {
        const callStartedAt = tracker.now()
        try {
          return Reflect.apply(dispose, iterator, [])
        } finally {
          totalMs += tracker.now() - callStartedAt
          finish()
        }
      }),
  }
}

const logSlowStatement = ({
  log,
  timing,
}: {
  log: Kernel["log"]
  timing: { stage: string; sql: string; durationMs: number }
}): void => {
  try {
    log({
      level: "warn",
      module: "performance",
      msg: "SQLite statement lento",
      data: { stage: timing.stage, sql: timing.sql, durationMs: getMilliseconds(timing.durationMs) },
    })
  } catch {
    // Diagnostics must not interrupt a database operation when logging is unavailable.
  }
}

const recordSlowStatement = (
  timings: Array<SlowStatement>,
  timing: { stage: string; sql: string; durationMs: number },
): Array<SlowStatement> => {
  const existing = timings.find((item) => item.stage === timing.stage && item.sql === timing.sql)
  if (existing)
    return timings.map((item) =>
      item === existing
        ? {
            ...item,
            calls: item.calls + 1,
            totalMs: getMilliseconds(item.totalMs + timing.durationMs),
            maxMs: Math.max(item.maxMs, getMilliseconds(timing.durationMs)),
          }
        : item,
    )

  return [
    ...timings,
    {
      stage: timing.stage,
      sql: timing.sql,
      calls: 1,
      totalMs: getMilliseconds(timing.durationMs),
      maxMs: getMilliseconds(timing.durationMs),
    },
  ].slice(-32)
}

const normalizeSql = (sql: string): string =>
  sql
    .replace(SQL_REDACTION_TOKENS, (token) => (token.startsWith("--") || token.startsWith("/*") ? " " : "?"))
    .replace(/\b(?:0x[\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b/gi, "?")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NORMALIZED_SQL_LENGTH)

const getMilliseconds = (value: number): number => Math.round(value * 1_000) / 1_000
