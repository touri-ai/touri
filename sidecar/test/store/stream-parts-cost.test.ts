import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { createPerformanceStageTracker } from "../../src/kernel/performance"
import { createStreamPartWriter } from "../../src/store/stream-parts"

const databases = new Set<Database>()

afterEach(() => {
  databases.forEach((database) => {
    database.close()
  })
  databases.clear()
})

test("stream part preparation avoids quadratic index reads in a completed reply", () => {
  const database = new Database(":memory:")
  database.exec("CREATE TABLE attachments (id TEXT PRIMARY KEY, path TEXT)")
  databases.add(database)
  const tracker = createPerformanceStageTracker()
  const write = createStreamPartWriter(database, "/synthetic", [])
  const count = 836
  // Count local fixture reads to detect repeated scans independently of timer noise.
  let indexReads = 0
  const patches = Array.from({ length: count }, (_, partIndex) => ({
    get partIndex() {
      indexReads += 1
      return partIndex
    },
    part: {
      type: "command" as const,
      callId: `synthetic-${partIndex}`,
      command: "sample",
      cwd: "/synthetic",
      outputTail: "ok",
      exitCode: 0,
    },
  }))

  const prepared = tracker.run("stream_part_preparation", write, patches)
  const stage = tracker.snapshot().find(({ stage }) => stage === "stream_part_preparation")

  console.info(`stream-parts-cost ${JSON.stringify({ count, indexReads, stage })}`)
  expect(prepared.parts.map(({ partIndex }) => partIndex)).toEqual(Array.from({ length: count }, (_, index) => index))
  expect(indexReads).toBeLessThan(count * 32)
})
