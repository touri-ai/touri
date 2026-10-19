import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TouriError } from "../../src/kernel/errors"
import { createFileIoLane, fileIoByteLimit, fileIoQueueLimit } from "../../src/kernel/file-io-client"

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
    lane
      .run({
        operation: "append",
        args: { root, path: index % 2 === 0 ? path : `${path}.other`, content: `${index}\n` },
      })
      .catch(() => undefined),
  )

  const queued = lane.getStats()
  await lane.flush()
  await Promise.all(writes)

  expect(queued.pending).toBe(fileIoQueueLimit)
  expect(queued.dropped).toBe(20)
  expect(await readFile(path, "utf8")).toBe(
    Array.from({ length: fileIoQueueLimit / 2 }, (_, index) => `${index * 2}\n`).join(""),
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

const largePayloadCases = [
  { bytes: fileIoByteLimit + 1024 * 1024, supportsWindows: true },
  { bytes: fileIoByteLimit * 2 + 1, supportsWindows: false },
]
largePayloadCases.forEach(({ bytes, supportsWindows }) => {
  // The existing Windows JSON envelope limit is separate from lane admission; see #591.
  test.skipIf(process.platform === "win32" && !supportsWindows)(
    `a ${bytes}-byte request payload is durably written without a transport size limit`,
    async () => {
      const root = await getRoot()
      const lane = getLane({ waitForCapacity: true })
      const path = join(root, "snapshot")
      const content = Buffer.alloc(bytes, 97)

      await lane.run({ operation: "write", args: { root, path, content } })

      expect(Buffer.compare(await readFile(path), content)).toBe(0)
      expect(lane.getStats()).toEqual({ pending: 0, bytes: 0, dropped: 0 })
    },
  )
})

test("five concurrent 15 MiB attachments wait for capacity and all drain on close", async () => {
  const root = await getRoot()
  const lane = getLane({ waitForCapacity: true })
  const content = Buffer.alloc(15 * 1024 * 1024, 98)
  const paths = Array.from({ length: 5 }, (_, index) => join(root, `attachment-${index}`))
  const writes = paths.map((path) => lane.run({ operation: "write", args: { root, path, content } }))
  const queued = lane.getStats()

  await lane.close()
  await Promise.all(writes)

  expect(queued).toEqual({ pending: 5, bytes: content.byteLength * 5, dropped: 0 })
  for (const path of paths) expect(Buffer.compare(await readFile(path), content)).toBe(0)
  expect(lane.getStats()).toEqual({ pending: 0, bytes: 0, dropped: 0 })
})

test("an oversized request waits for ordinary writes before running alone", async () => {
  const root = await getRoot()
  const lane = getLane({ maxBytes: 4, waitForCapacity: true })
  const path = join(root, "snapshot")
  const first = lane.run({ operation: "write", args: { root, path, content: "1234" } })
  const next = lane.run({ operation: "write", args: { root, path, content: "oversized" } })

  await lane.flush()
  await Promise.all([first, next])

  expect(await readFile(path, "utf8")).toBe("oversized")
  expect(lane.getStats()).toEqual({ pending: 0, bytes: 0, dropped: 0 })
})

test("capacity wait has a deadline and bounds retained request payloads", async () => {
  const root = await getRoot()
  const source = "self.onmessage = () => {}; setInterval(() => {}, 1000)"
  const url = URL.createObjectURL(new Blob([source], { type: "application/javascript" }))
  cleanups.add(async () => URL.revokeObjectURL(url))
  const lane = getLane({
    maxBytes: 4,
    waitForCapacity: true,
    capacityTimeoutMs: 25,
    createWorker: () => new Worker(url),
  })
  const task = { operation: "write" as const, args: { root, path: join(root, "stalled"), content: "1234" } }
  const first = lane.run(task).catch((error: Error) => error.message)
  const waiting = lane.run(task).catch((error: Error) => error.message)
  const excess = lane.run(task).catch((error: Error) => error.message)
  const queued = lane.getStats()

  expect(await waiting).toBe("File I/O capacity wait timed out")
  await lane.close(1).catch(() => {})

  expect(queued).toEqual({ pending: 2, bytes: 8, dropped: 1 })
  expect(await excess).toBe("File I/O capacity exceeded")
  expect(await first).toBe("File I/O shutdown timed out")
  expect(lane.getStats()).toEqual({ pending: 0, bytes: 0, dropped: 2 })
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

test("a handled file failure does not reject an unrelated flush or shutdown", async () => {
  const root = await getRoot()
  const lane = getLane()
  const rejected = lane.run({
    operation: "write",
    args: { root: join(root, "private"), path: join(root, "escape"), content: "denied" },
  })
  const failure = rejected.catch((error: Error) => error.message)

  await lane.flush()
  await lane.close()

  expect(await failure).toBeString()
  await expect(readFile(join(root, "escape"))).rejects.toMatchObject({ code: "ENOENT" })
})

test("a worker failure between scheduling and dispatch cannot strand subsequent writes", async () => {
  const root = await getRoot()
  const workers: Worker[] = []
  const lane = getLane({
    createWorker: () => {
      const worker = new Worker(new URL("../../src/kernel/file-io-worker.ts", import.meta.url))
      workers.push(worker)
      return worker
    },
  })
  await lane.run({ operation: "write", args: { root, path: join(root, "warmup"), content: "ready" } })
  const [first] = workers
  if (!first) throw new Error("Synthetic worker missing")
  const interrupted = lane.run({
    operation: "write",
    args: { root, path: join(root, "interrupted"), content: "uncertain" },
  })
  const failed = interrupted.catch((error: Error) => error.message)

  first.onerror?.(new ErrorEvent("error", { message: "Synthetic worker failure" }))
  await lane.run({ operation: "write", args: { root, path: join(root, "recovered"), content: "durable" } })

  expect(await failed).toContain("stopped unexpectedly")
  expect(workers).toHaveLength(2)
  expect(await readFile(join(root, "recovered"), "utf8")).toBe("durable")
})

test("worker-backed failure assertions remain responsive after a completed write", async () => {
  const root = await getRoot()
  const lane = getLane()
  await lane.run({ operation: "write", args: { root, path: join(root, "warmup"), content: "ready" } })

  await expect(
    lane.run({
      operation: "write",
      args: { root: join(root, "private"), path: join(root, "escape"), content: "denied" },
    }),
  ).rejects.toThrow(new TouriError("TOURI-E2000").message)
  await lane.run({ operation: "write", args: { root, path: join(root, "next"), content: "durable" } })

  expect(await readFile(join(root, "next"), "utf8")).toBe("durable")
})
