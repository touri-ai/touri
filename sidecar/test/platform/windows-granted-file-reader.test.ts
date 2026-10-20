import { expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readWindowsGrantedFile } from "../../src/platform/read-windows-granted-file"

const getOptions = (mode = "ok", maximum = 1024) => ({
  target: { path: join(tmpdir(), "fixture.txt"), dev: "1", ino: "2", maxBytes: maximum },
  signal: new AbortController().signal,
  command: [process.execPath, join(import.meta.dir, "../fixtures/granted-file-helper.ts"), mode],
})

test("granted bytes use a binary pipe beyond the bridge frame limit without blocking timers", async () => {
  const options = getOptions("ok", 15 * 1024 * 1024)

  const read = readWindowsGrantedFile(options)
  const first = await Promise.race([read.then(() => "read"), Bun.sleep(10).then(() => "timer")])
  const bytes = await read

  expect(first).toBe("timer")
  expect(bytes.byteLength).toBe(options.target.maxBytes)
  expect(bytes[0]).toBe(65)
})

test.each(["failure", "oversized"])("a %s helper cannot supply attachment bytes", async (mode) => {
  const options = getOptions(mode)

  const read = readWindowsGrantedFile(options)

  await expect(read).rejects.toThrow()
})

test("an aborted read kills the helper and settles", async () => {
  const controller = new AbortController()
  const options = { ...getOptions("stall"), signal: controller.signal }

  const read = readWindowsGrantedFile(options)
  controller.abort()

  await expect(read).rejects.toThrow()
})

test("a stalled helper is killed at the deadline", async () => {
  const options = { ...getOptions("stall"), timeoutMs: 50 }

  const read = readWindowsGrantedFile(options)

  await expect(read).rejects.toThrow()
})
