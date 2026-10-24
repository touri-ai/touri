import { constants, Database } from "bun:sqlite"
import { join } from "node:path"
import { getHistoryQuery } from "../../../sidecar/src/store/history-query"

const directory = process.argv[2]
const threadId = process.argv[3]
if (!directory || !threadId) throw new Error("Missing synthetic query fixture")

// This one-shot, read-only probe runs with the synthetic server stopped and only 27 fixture messages.
const database = new Database(
  join(directory, "touri.db"),
  constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_NOFOLLOW,
)
const query = getHistoryQuery(threadId, null, true)
const plan = database.query(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.bindings)
const samples = Array.from({ length: 3 }, () => {
  const cpuStart = process.cpuUsage()
  const start = performance.now()
  const rows = database.query(query.sql).all(...query.bindings)
  const wallMs = performance.now() - start
  const cpu = process.cpuUsage(cpuStart)

  return { rows: rows.length, wallMs, cpuMs: (cpu.user + cpu.system) / 1000 }
})
database.close()
process.stdout.write(JSON.stringify({ plan, samples }))
