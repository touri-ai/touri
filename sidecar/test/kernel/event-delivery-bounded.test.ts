import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { UiEventEnvelope } from "@touri/contracts"
import { openDatabase } from "../../src/kernel/db"
import { createEventBus } from "../../src/kernel/event-bus"
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
