import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFileIoLane, fileIoQueueLimit } from "../../src/kernel/file-io-client"

const cleanups = new Set<() => Promise<unknown>>()
afterEach(async () => {
  await Array.from(cleanups).reduceRight(async (previous, cleanup) => {
    await previous
    await cleanup()
  }, Promise.resolve())
  cleanups.clear()
})

test("log batches preserve every accepted line and count overload without growing the mailbox", async () => {
  const root = await getRoot()
  const lane = getLane({ batch: true })
  const path = join(root, "log")
  const writes = Array.from({ length: fileIoQueueLimit + 20 }, (_, index) =>
    lane.run({ operation: "append", args: { root, path, content: `${index}\n` } }).catch(() => undefined),
  )

  const queued = lane.getStats()
  await lane.flush()
  await Promise.all(writes)

  expect(queued.pending).toBe(fileIoQueueLimit)
  expect(queued.dropped).toBe(20)
  expect(await readFile(path, "utf8")).toBe(
    Array.from({ length: fileIoQueueLimit }, (_, index) => `${index}\n`).join(""),
  )
  expect(lane.getStats()).toEqual({ pending: 0, bytes: 0, dropped: 20 })
})

test("the payload limit rejects excess bytes and frees capacity after a durable write", async () => {
  const root = await getRoot()
  const lane = getLane({ maxBytes: 4 })
  const first = lane.run({ operation: "write", args: { root, path: join(root, "first"), content: "1234" } })

  await expect(
    lane.run({ operation: "write", args: { root, path: join(root, "extra"), content: "5" } }),
  ).rejects.toThrow("capacity")
  await first
  await lane.run({ operation: "write", args: { root, path: join(root, "next"), content: "ok" } })

  expect(lane.getStats()).toEqual({ pending: 0, bytes: 0, dropped: 1 })
})

test("close drains the final log batch before terminating and refuses later writes", async () => {
  const root = await getRoot()
  const lane = getLane({ batch: true })
  const path = join(root, "shutdown.log")
  const appended = lane.run({ operation: "append", args: { root, path, content: "shutdown complete\n" } })

  await lane.close()
  await appended

  expect(await readFile(path, "utf8")).toBe("shutdown complete\n")
  await expect(lane.run({ operation: "append", args: { root, path, content: "late" } })).rejects.toThrow("closed")
})

test("close terminates an unresponsive worker and settles accepted writes at its deadline", async () => {
  const root = await getRoot()
  const source = "self.onmessage = () => {}; setInterval(() => {}, 1000)"
  const url = URL.createObjectURL(new Blob([source], { type: "application/javascript" }))
  cleanups.add(async () => URL.revokeObjectURL(url))
  const lane = getLane({ createWorker: () => new Worker(url) })
  const write = lane.run({ operation: "write", args: { root, path: join(root, "stalled"), content: "synthetic" } })
  const failed = write.catch((error: Error) => error.message)

  const started = performance.now()
  await expect(lane.close(25)).rejects.toThrow("shutdown timed out")

  expect(await failed).toContain("shutdown timed out")
  expect(performance.now() - started).toBeLessThan(1000)
  expect(lane.getStats().pending).toBe(0)
})

const getRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "touri-file-io-"))
  cleanups.add(() => rm(root, { recursive: true, force: true }))
  return root
}

const getLane = (options: Parameters<typeof createFileIoLane>[0] = {}) => {
  const lane = createFileIoLane(options)
  cleanups.add(() => lane.close())
  return lane
}
