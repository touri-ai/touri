import { afterEach, expect, test } from "bun:test"
import { fsyncSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { atomicDownload } from "../../src/vm/atomic-download"
import { createAtomicDownloadWriter } from "../../src/vm/atomic-download-core"

const workerUrls = new Set<string>()
afterEach(() => {
  workerUrls.forEach((url) => {
    URL.revokeObjectURL(url)
  })
  workerUrls.clear()
})

for (const failure of [0, 1, 2, 3])
  test(`B05 atomic download publishes only complete synced data; sync failure ${failure}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "touri-snapshot-"))
    try {
      const path = join(root, "snapshot")
      writeFileSync(path, "original")
      let calls = 0
      const writer = createAtomicDownloadWriter(path, {
        sync: (fd) => {
          calls++
          if (calls === failure) throw new Error("injected")
          fsyncSync(fd)
        },
      })
      writer.write(Buffer.from("complete"))
      if (failure) expect(() => writer.finish()).toThrow()
      else writer.finish()
      expect(readFileSync(path, "utf8")).toBe(failure ? "original" : "complete")
      expect(readdirSync(root)).toEqual(["snapshot"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
test("B05 snapshot download rejects linked destination and leaves its target intact", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-snapshot-link-"))
  try {
    writeFileSync(join(root, "original"), "original")
    symlinkSync(join(root, "original"), join(root, "snapshot"))
    await expect(atomicDownload(new Response("new"), join(root, "snapshot"))).rejects.toThrow()
    expect(readFileSync(join(root, "original"), "utf8")).toBe("original")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("B05 snapshot bytes are streamed through the worker before publication", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-snapshot-worker-"))
  try {
    const path = join(root, "snapshot")
    await atomicDownload(new Response("complete"), path)
    expect(readFileSync(path, "utf8")).toBe("complete")
    expect(readdirSync(root)).toEqual(["snapshot"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("snapshot writer startup has a deadline and cancels the source", async () => {
  const source = getPendingResponse()
  const createWorker = getWorkerFactory("self.onmessage = () => {}; setInterval(() => {}, 1000)")

  await expect(atomicDownload(source.response, "snapshot", { createWorker, startupTimeoutMs: 25 })).rejects.toThrow(
    "startup timed out",
  )

  expect(source.isCancelled()).toBe(true)
})

test.each([
  "self.close()",
  'self.onmessage = () => self.close(); self.postMessage({ type: "ready" })',
  `self.onmessage = ({ data }) => {
    if (data.type === "start") self.postMessage({ requestId: data.requestId });
    if (data.type === "chunk") self.close();
  }; self.postMessage({ type: "ready" })`,
])("snapshot writer close settles startup or pending writes: %s", async (workerSource) => {
  const source = getPendingResponse()
  const createWorker = getWorkerFactory(workerSource)

  await expect(atomicDownload(source.response, "snapshot", { createWorker })).rejects.toThrow("stopped unexpectedly")

  expect(source.isCancelled()).toBe(true)
})

test("snapshot writer close cancels a source stalled between chunks", async () => {
  const source = getPendingResponse()
  const createWorker = getWorkerFactory(`self.onmessage = ({ data }) => {
    self.postMessage({ requestId: data.requestId });
    if (data.type === "chunk") setTimeout(() => self.close(), 25);
  }; self.postMessage({ type: "ready" })`)

  await expect(atomicDownload(source.response, "snapshot", { createWorker })).rejects.toThrow("stopped unexpectedly")

  expect(source.isCancelled()).toBe(true)
})

const getWorkerFactory = (source: string): (() => Worker) => {
  const url = URL.createObjectURL(new Blob([source], { type: "application/javascript" }))
  workerUrls.add(url)
  return () => new Worker(url)
}

const getPendingResponse = () => {
  // This flag belongs only to the fixture's source stream.
  let cancelled = false
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start: (controller) => controller.enqueue(new Uint8Array([1, 2, 3])),
      cancel: () => {
        cancelled = true
      },
    }),
  )
  return { response, isCancelled: () => cancelled }
}
