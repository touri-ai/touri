import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { UiEventEnvelope } from "@touri/contracts"
import { openDatabase } from "../../src/kernel/db"
import { createEventBus } from "../../src/kernel/event-bus"
import { profileProviders } from "../../src/kernel/provider-profiles"
import { TRANSCRIPT_CAPTURE_LIMIT } from "../../src/kernel/transcript-events"
import { purgeReplayRows } from "../../src/kernel/transcript-storage"

const cleanups = new Set<() => void | Promise<void>>()
afterEach(async () => {
  for (const cleanup of Array.from(cleanups).reverse()) await cleanup()
  cleanups.clear()
})

test("a committed live backlog yields after a fixed batch for two full-state subscribers", async () => {
  const fixture = await getFixture()
  const first = getClient()
  const second = getClient()
  fixture.bus.add(first.socket)
  fixture.bus.add(second.socket)
  fixture.database.transaction(() => publishEvents(fixture.bus, 129))()

  await Promise.resolve()
  const firstBatch = first.getSequences()
  const secondBatch = second.getSequences()
  Array.from({ length: 5 }, () => fixture.runNext())

  expect(firstBatch).toHaveLength(32)
  expect(secondBatch).toEqual(firstBatch)
  expect(first.getSequences()).toEqual(Array.from({ length: 129 }, (_, index) => index + 1))
  expect(second.getSequences()).toEqual(first.getSequences())
})

test("a client joining during a queued backlog does not receive its catch-up twice", async () => {
  const fixture = await getFixture()
  publishEvents(fixture.bus, 1)
  fixture.database.transaction(() => publishEvents(fixture.bus, 100))()
  const client = getClient()

  fixture.bus.add(client.socket, 1)
  await Promise.resolve()
  Array.from({ length: 5 }, () => fixture.runNext())
  publishEvents(fixture.bus, 1)

  expect(client.getSequences()).toEqual(Array.from({ length: 101 }, (_, index) => index + 2))
})

test("a small reentrant notification cascade completes within the caller's delivery batch", async () => {
  const fixture = await getFixture()
  let completed = false
  fixture.bus.subscribe(({ event }) => {
    if (event.type !== "import.progress") return
    if (event.importId === "followup") {
      completed = true
      return
    }

    fixture.bus.publish({ type: "import.progress", importId: "followup", phase: "done", done: 1, total: 1 })
  })

  fixture.bus.publish({ type: "import.progress", importId: "initial", phase: "done", done: 1, total: 1 })

  expect(completed).toBe(true)
})

test("stopping from a subscriber prevents later database access in the same batch", async () => {
  const fixture = await getFixture()
  const queries = spyOn(fixture.database, "query")
  cleanups.add(() => {
    queries.mockRestore()
  })
  fixture.bus.subscribe(() => {
    fixture.bus.stop()
    queries.mockImplementation(() => {
      throw new Error("Fixture database closed")
    })
  })

  const publish = () =>
    fixture.bus.publish({ type: "import.progress", importId: "stop", phase: "done", done: 1, total: 1 })

  expect(publish).not.toThrow()
})

test("stop cancels pending delivery without dropping committed events", async () => {
  const fixture = await getFixture()
  const client = getClient()
  fixture.bus.add(client.socket)
  fixture.database.transaction(() => publishEvents(fixture.bus, 100))()

  fixture.bus.stop()
  fixture.runNext()

  expect(client.getSequences()).toEqual([])
  expect(fixture.database.query("SELECT count(*) AS n FROM ui_event_log").get()).toEqual({ n: 100 })
})

test("retention advancing between batches preserves notifications in the retained tail", async () => {
  const fixture = await getFixture()
  let completed = false
  fixture.bus.subscribe(({ event }) => {
    if (event.type === "import.progress" && event.importId === "retained-marker") completed = true
  })
  fixture.database.transaction(() => {
    publishEvents(fixture.bus, 100)
    purgeReplayRows(fixture.database, [{ seq: 100 }])
    fixture.bus.publish({
      type: "import.progress",
      importId: "retained-marker",
      phase: "done",
      done: 1,
      total: 1,
    })
  })()

  await Promise.resolve()
  fixture.runNext()

  expect(completed).toBe(true)
})

test("publishing a control notification captures a bounded transcript batch and resumes without another publisher", async () => {
  const fixture = await getFixture()
  fixture.database.exec(`WITH RECURSIVE entries(value) AS (
    SELECT 1 UNION ALL SELECT value + 1 FROM entries WHERE value < 129
  ) INSERT INTO transcript_entries(thread_id, seq, generation, event_json, at)
    SELECT 'synthetic-thread', value, 1,
      json_object('type', 'import.progress', 'importId', 'synthetic', 'phase', 'done', 'done', value, 'total', 129), 1
    FROM entries`)

  fixture.bus.publish({ type: "transcript.resync" })
  const initial = fixture.database.query("SELECT count(*) AS n FROM ui_event_log").get() as { n: number }
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const count = fixture.database.query("SELECT count(*) AS n FROM ui_event_log").get() as { n: number }
    if (count.n === 130) break
    await Bun.sleep(5)
  }

  expect(initial.n).toBeGreaterThan(1)
  expect(initial.n).toBeLessThanOrEqual(TRANSCRIPT_CAPTURE_LIMIT + 1)
  expect(fixture.database.query("SELECT count(*) AS n FROM ui_event_log").get()).toEqual({ n: 130 })
  expect(
    fixture.database.query("SELECT value FROM schema_meta WHERE key = 'transcript_event_checkpoint'").get(),
  ).toEqual({ value: "129" })
})

test("a delayed transcript capture cannot recreate replay for a bot whose purge already started", async () => {
  const fixture = await getFixture()
  fixture.database
    .query(`INSERT INTO bots(id, name, provider, home_dir, created_at, updated_at)
    VALUES ('deleted-bot', 'Synthetic', ?, '/synthetic/bot', 1, 1)`)
    .run(profileProviders[0])
  fixture.database.exec(`INSERT INTO threads(id, bot_id, title, created_at, updated_at)
    VALUES ('deleted-thread', 'deleted-bot', 'Synthetic', 1, 1);
    INSERT INTO bot_deletions(bot_id, delete_volumes, phase, created_at, updated_at)
    VALUES ('deleted-bot', 0, 'messages', 1, 1);
    INSERT INTO transcript_entries(thread_id, seq, generation, event_json, at)
    VALUES ('deleted-thread', 1, 1, '{"type":"message.delta","threadId":"deleted-thread","delta":"private-synthetic"}', 1)`)

  fixture.bus.publish({ type: "transcript.resync" })

  expect(
    fixture.database.query("SELECT seq FROM ui_event_log WHERE event_json LIKE '%private-synthetic%'").all(),
  ).toEqual([])
  expect(
    fixture.database.query("SELECT value FROM schema_meta WHERE key = 'transcript_event_checkpoint'").get(),
  ).toEqual({ value: "1" })
})

const getFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-bounded-delivery-"))
  const database = openDatabase({ filename: join(root, "synthetic.db") })
  let next = () => {}
  const schedule = (action: () => void): (() => void) => {
    next = () => {
      next = () => {}
      action()
    }

    return () => {
      next = () => {}
    }
  }
  const bus = createEventBus(database, undefined, { now: () => 0, schedule })
  cleanups.add(async () => {
    bus.stop()
    database.close()
    await rm(root, { recursive: true, force: true })
  })

  return { bus, database, runNext: () => next() }
}

const getClient = () => {
  let sequences: number[] = []

  return {
    socket: {
      readyState: 1 as const,
      sendText: (payload: string) => {
        const frame = JSON.parse(payload) as UiEventEnvelope
        if ("event" in frame) sequences = sequences.concat(frame.seq)

        return payload.length
      },
    },
    getSequences: () => sequences,
  }
}

const publishEvents = (bus: ReturnType<typeof createEventBus>, count: number): void => {
  Array.from({ length: count }, (_, index) =>
    bus.publish({ type: "import.progress", importId: "synthetic", phase: "done", done: index, total: count }),
  )
}
