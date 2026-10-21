import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { UiEvent, UiEventEnvelope } from "@touri/contracts"
import { openDatabase } from "../../src/kernel/db"
import { createEventBus } from "../../src/kernel/event-bus"

test("r2: closing or stale websocket cannot interrupt broadcasts or sidecar requests", () => {
  const bus = createEventBus()
  let deadCalls = 0
  const healthy: Array<string> = []
  bus.add({
    readyState: 1 as const,
    sendText: () => {
      deadCalls++
      throw new Error("socket closed during reload")
    },
  })
  bus.add({
    readyState: 3,
    sendText: () => {
      throw new Error("must not send on closed socket")
    },
  })
  bus.add({
    readyState: 1 as const,
    sendText: (payload: string) => {
      healthy.push(payload)
      return payload.length
    },
  })
  for (let index = 0; index < 2; index++)
    expect(() =>
      bus.publish({ type: "import.progress", importId: "r2", phase: "done", done: 1, total: 1 }),
    ).not.toThrow()
  expect(deadCalls).toBe(1)
  expect(healthy).toHaveLength(2)
})

const cleanups = new Set<() => void>()
afterEach(() => {
  cleanups.forEach((cleanup) => {
    cleanup()
  })
  cleanups.clear()
})
const canView = (event: UiEvent): boolean => event.type !== "import.progress" || event.importId === "public"
const getSocket = (frames: string[]) => ({
  readyState: 1 as const,
  sendText: (payload: string) => {
    frames.push(payload)
    return payload.length
  },
})
const publishSequence = (bus: ReturnType<typeof createEventBus>) => {
  bus.publish({ type: "import.progress", importId: "public", phase: "one", done: 1, total: 3 })
  bus.publish({ type: "import.progress", importId: "private-marker", phase: "private-content", done: 2, total: 3 })
  bus.publish({ type: "import.progress", importId: "public", phase: "three", done: 3, total: 3 })
}

test("filtered live events preserve a continuous cursor without private content", () => {
  const bus = createEventBus()
  cleanups.add(() => bus.stop())
  const frames: string[] = []
  bus.add(getSocket(frames), 0, canView)

  publishSequence(bus)
  const received = frames.map((frame) => JSON.parse(frame) as UiEventEnvelope)

  expect(received.map((frame) => frame.seq)).toEqual([1, 2, 3])
  expect(received[1]?.event).toEqual({ type: "transcript.superseded" })
  expect(frames.join("")).not.toContain("private-marker")
  expect(frames.join("")).not.toContain("private-content")
})

test("filtered replay preserves the same cursor contract as live delivery", () => {
  const root = mkdtempSync(join(tmpdir(), "touri-event-cursor-"))
  const database = openDatabase({ filename: join(root, "test.db") })
  const writer = createEventBus(database)
  const reader = createEventBus(database)
  cleanups.add(() => {
    writer.stop()
    reader.stop()
    database.close()
    rmSync(root, { recursive: true, force: true })
  })
  writer.publish({ type: "import.progress", importId: "public", phase: "seed", done: 0, total: 3 })
  publishSequence(writer)
  const frames: string[] = []

  reader.add(getSocket(frames), 1, canView)
  const received = frames.map((frame) => JSON.parse(frame) as UiEventEnvelope)

  expect(received.map((frame) => frame.seq)).toEqual([2, 3, 4])
  expect(received[1]?.event).toEqual({ type: "transcript.superseded" })
  expect(frames.join("")).not.toContain("private-marker")
  expect(frames.join("")).not.toContain("private-content")
})
