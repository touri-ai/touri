import { Database } from "bun:sqlite"
import { afterEach, expect, mock, spyOn, test } from "bun:test"
import type { Kernel } from "@touri/contracts"
import { createPerformanceDiagnostics, createPerformanceStageTracker } from "../../src/kernel/performance"
import { createSlowStatementTracker, instrumentMainConnection } from "../../src/kernel/sqlite-performance"

const databases = new Set<Database>()
const cleanups = new Set<() => void>()

afterEach(() => {
  cleanups.forEach((cleanup) => {
    cleanup()
  })
  cleanups.clear()
  databases.forEach((database) => {
    database.close()
  })
  databases.clear()
})

test("main connection reports normalized statements at the 250 ms threshold", () => {
  const log = mock<Kernel["log"]>()
  let times = [0, 0, 0, 249]
  const database = getDatabase({ log, now: () => times.shift() ?? 249 })

  database
    .query("SELECT id AS \"privatevalue\" FROM fixture WHERE label = 'private-value' AND id = 123 -- private-comment")
    .get()

  expect(log).not.toHaveBeenCalled()

  times = [0, 0, 0, 250]
  database
    .prepare("SELECT id AS \"privatevalue\" FROM fixture WHERE label = 'private-value' AND id = 123 -- private-comment")
    .values()

  expect(log.mock.calls).toHaveLength(1)
  expect(log.mock.calls[0]?.[0]).toMatchObject({
    level: "warn",
    module: "performance",
    msg: "SQLite statement lento",
    data: {
      stage: "workspace_snapshot",
      sql: "SELECT id AS ? FROM fixture WHERE label = ? AND id = ?",
      durationMs: 250,
    },
  })
  expect(JSON.stringify(log.mock.calls)).not.toContain("private-")
})

test("bound values remain private on a slow get", () => {
  const log = mock<Kernel["log"]>()
  const times = [0, 0, 0, 300]
  const database = getDatabase({ log, now: () => times.shift() ?? 300 })

  expect(database.query("SELECT ? AS value").get("private-bound")).toEqual({ value: "private-bound" })

  expect(log).toHaveBeenCalled()
  expect(JSON.stringify(log.mock.calls)).not.toContain("private-bound")
})

test("the main connection preserves Bun's cached statement identity", () => {
  const log = mock<Kernel["log"]>()
  const database = getDatabase({ log, now: () => 0 })

  const first = database.query("SELECT id FROM fixture")
  const second = database.query("SELECT id FROM fixture")

  expect(second).toBe(first)
})

test("statement wrappers are cached on the statement", () => {
  const log = mock<Kernel["log"]>()
  const database = getDatabase({ log, now: () => 0 })
  const statement = database.query("SELECT id FROM fixture")

  expect(statement.run).toBe(statement.run)
  expect(statement.get).toBe(statement.get)
  expect(statement.all).toBe(statement.all)
  expect(statement.values).toBe(statement.values)
  expect(statement.raw).toBe(statement.raw)
  expect(statement.iterate).toBe(statement.iterate)
  expect(statement.as).toBe(statement.as)
})

test("main connection query overrides remain observable", () => {
  const log = mock<Kernel["log"]>()
  const database = getDatabase({ log, now: () => 0 })
  const query = spyOn(database, "query")

  database.query("SELECT id FROM fixture").all()

  expect(query).toHaveBeenCalledTimes(1)
})

test("slow iterators and transaction calls are reported", () => {
  const log = mock<Kernel["log"]>()
  let at = 0
  const database = getDatabase({ log, now: () => (at += 300) })
  const transaction = database.transaction(() =>
    database.query("INSERT INTO fixture (label) VALUES (?)").run("synthetic"),
  )

  expect(transaction.deferred).toBe(transaction.deferred)
  expect(transaction.immediate).toBe(transaction.immediate)
  expect(transaction.exclusive).toBe(transaction.exclusive)
  // Bun's runtime exposes these, although its type declarations omit them.
  expect(Reflect.get(transaction, "default")).toBe(Reflect.get(transaction, "default"))
  expect(Reflect.get(transaction, "database")).toBe(database)
  transaction.toString()
  expect(log).not.toHaveBeenCalled()

  transaction.immediate()
  Array.from(database.query("SELECT id FROM fixture").iterate())

  const loggedSql = log.mock.calls.map(([entry]) => entry.data?.sql)
  expect(loggedSql).toContain("TRANSACTION")
  expect(loggedSql).toContain("INSERT INTO fixture (label) VALUES (?)")
  expect(loggedSql).toContain("SELECT id FROM fixture")
})

test("slow Database.run and Database.exec calls are reported", () => {
  const log = mock<Kernel["log"]>()
  let at = 0
  const database = getDatabase({ log, now: () => (at += 300) })

  database.run("INSERT INTO fixture (label) VALUES (?)", ["synthetic"])
  database.exec("UPDATE fixture SET label = 'updated'")

  const loggedSql = log.mock.calls.map(([entry]) => entry.data?.sql)
  expect(loggedSql).toContain("INSERT INTO fixture (label) VALUES (?)")
  expect(loggedSql).toContain("UPDATE fixture SET label = ?")
})

test("a SQLite error passes through without replacement", () => {
  const log = mock<Kernel["log"]>()
  const rawDatabase = new Database(":memory:")
  databases.add(rawDatabase)
  let sqliteError: unknown
  try {
    rawDatabase.query("SELECT * FROM missing_fixture").get()
  } catch (error) {
    sqliteError = error
  }
  if (!(sqliteError instanceof Error)) throw new Error("Expected SQLite to reject the missing table")

  const query = spyOn(rawDatabase, "query").mockImplementation(() => {
    throw sqliteError
  })
  cleanups.add(() => query.mockRestore())
  const tracker = createSlowStatementTracker({ log, getStage: () => "workspace_snapshot", now: () => 0 })
  const database = instrumentMainConnection(rawDatabase, tracker)
  let thrown: unknown

  try {
    database.query("SELECT 1")
  } catch (error) {
    thrown = error
  }

  expect(thrown).toBe(sqliteError)
})

test("slow statement totals appear in the event-loop lag report", () => {
  let at = 0
  let sample = () => {}
  const log = mock<Kernel["log"]>()
  const stageTracker = createPerformanceStageTracker(() => at)
  const slowStatements = createSlowStatementTracker({ log, getStage: () => "unattributed", now: () => at })
  const diagnostics = createPerformanceDiagnostics({
    log,
    getContext: () => ({ activeRuns: 0, sseClients: 0, websocketClients: 0 }),
    now: () => at,
    stageTracker,
    slowStatements,
    sampleMs: 10,
    lagThresholdMs: 5,
    startSampling: (callback) => {
      sample = callback
      return () => {}
    },
  })
  cleanups.add(diagnostics.stop)

  slowStatements.recordDuration("SELECT id FROM fixture WHERE id = 1", 300)
  Array.from({ length: 10 }, () => slowStatements.recordDuration("SELECT id FROM fixture WHERE id = 2", 10))
  stageTracker.run("workspace_snapshot", () => {
    at += 1_000
  })
  sample()

  const report = log.mock.calls.map(([entry]) => entry).find((entry) => entry.msg === "Atraso no event loop")

  expect(report?.data?.slowStatements).toEqual([
    {
      stage: "unattributed",
      sql: "SELECT id FROM fixture WHERE id = ?",
      calls: 1,
      totalMs: 300,
      maxMs: 300,
    },
  ])
  expect(report?.data?.sqliteStatementTotals).toEqual({ calls: 11, totalMs: 400 })
})

test("the stage tracker exposes the active stage through async nesting", async () => {
  const stageTracker = createPerformanceStageTracker(() => 0)

  stageTracker.run("stream_batch", () => {
    expect(stageTracker.getCurrentStage()).toBe("stream_batch")
    stageTracker.run("workspace_snapshot", () => {
      expect(stageTracker.getCurrentStage()).toBe("workspace_snapshot")
    })
    expect(stageTracker.getCurrentStage()).toBe("stream_batch")
  })

  const stageAfterAwait = await stageTracker.run("workspace_snapshot", async () => {
    await Promise.resolve()
    return stageTracker.getCurrentStage()
  })

  expect(stageAfterAwait).toBe("workspace_snapshot")
  expect(stageTracker.getCurrentStage()).toBeUndefined()
})

const getDatabase = ({ log, now }: { log: Kernel["log"]; now: () => number }): Database => {
  const rawDatabase = new Database(":memory:")
  databases.add(rawDatabase)
  rawDatabase.exec("CREATE TABLE fixture (id INTEGER PRIMARY KEY, label TEXT)")
  const tracker = createSlowStatementTracker({ log, getStage: () => "workspace_snapshot", now })

  return instrumentMainConnection(rawDatabase, tracker)
}
