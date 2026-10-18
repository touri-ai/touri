import { afterEach, expect, test } from "bun:test"
import type { Subprocess } from "bun"
import { relayHeadlessStderr } from "../../src/cli/serveStderr"

// The child isolates descriptor changes from the test runner; teardown also covers failed assertions.
let child: Subprocess | undefined
afterEach(() => {
  child?.kill()
  child = undefined
})

test("headless serve warns once, drops repeated scheduling denials, and preserves other stderr", async () => {
  const output = createOutput()
  const stream = getStream([
    "Failed to apply scheduling attributes to th",
    "read 101: Operation not permitted\n",
    "Failed to apply scheduling attributes to thread 102: Operation not permitted\n",
    "Failed to apply scheduling attributes to thread 103: Permission denied\n",
    "server diagnostic after scheduling denial\n",
  ])

  await relayHeadlessStderr(stream, output.write)

  const stderr = output.getText()
  expect(stderr).toBe(
    "Optional scheduling adjustment was denied; continuing with the existing thread policy.\n" +
      "Failed to apply scheduling attributes to thread 103: Permission denied\n" +
      "server diagnostic after scheduling denial\n",
  )
  expect(stderr).not.toContain("thread 101")
  expect(stderr).not.toContain("thread 102")
})

test("headless serve relays stderr unchanged when scheduling succeeds", async () => {
  const output = createOutput()

  await relayHeadlessStderr(getStream(["server ready\n", "next line\n"]), output.write)

  expect(output.getText()).toBe("server ready\nnext line\n")
})

test("an oversized line ending in a scheduling diagnostic passes through unchanged", async () => {
  const prefix = "x".repeat(8_193)
  const suffix = "Failed to apply scheduling attributes to thread 101: Operation not permitted\n"
  const output = createOutput()

  await relayHeadlessStderr(getStream([prefix, suffix]), output.write)

  expect(output.getText()).toBe(prefix + suffix)
})

test("split UTF-8, CRLF, and an unterminated diagnostic retain their meaning", async () => {
  const diagnostic = "Failed to apply scheduling attributes to thread 101: Operation not permitted"
  const bytes = new TextEncoder().encode(`ação\n${diagnostic}\r\n${diagnostic}`)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      bytes.forEach((byte) => {
        controller.enqueue(Uint8Array.of(byte))
      })
      controller.close()
    },
  })
  const output = createOutput()

  await relayHeadlessStderr(stream, output.write)

  expect(output.getText()).toBe(
    "ação\nOptional scheduling adjustment was denied; continuing with the existing thread policy.\n",
  )
})

test.skipIf(process.platform !== "linux")(
  "native stderr is compacted without relaunching or blocking the server",
  async () => {
    const moduleUrl = new URL("../../src/cli/nativeStderr.ts", import.meta.url).href
    const diagnostic = "Failed to apply scheduling attributes to thread 101: Operation not permitted\n"
    const largeLine = `${"ação".repeat(32_768)}\n`
    const source = `
    import { writeSync } from "node:fs"
    import { startHeadlessStderr } from ${JSON.stringify(moduleUrl)}
    const stop = await startHeadlessStderr()
    writeSync(2, ${JSON.stringify(diagnostic.repeat(2))})
    writeSync(2, "ação".repeat(32768) + "\\n")
    writeSync(2, "different permission error: Operation not permitted\\n")
    await stop()
    await stop()
    writeSync(2, "stderr restored\\n")
    console.log(process.pid)
  `

    const processUnderTest = Bun.spawn([process.execPath, "--eval", source], { stdout: "pipe", stderr: "pipe" })
    child = processUnderTest
    const [stdout, stderr, code] = await Promise.all([
      new Response(processUnderTest.stdout).text(),
      new Response(processUnderTest.stderr).text(),
      processUnderTest.exited,
    ])

    expect(code).toBe(0)
    expect(stdout.trim()).toBe(String(processUnderTest.pid))
    expect(stderr).toBe(
      "Optional scheduling adjustment was denied; continuing with the existing thread policy.\n" +
        largeLine +
        "different permission error: Operation not permitted\nstderr restored\n",
    )
  },
  15_000,
)

const getStream = (chunks: Array<string>): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      chunks.forEach((chunk) => {
        controller.enqueue(new TextEncoder().encode(chunk))
      })
      controller.close()
    },
  })

const createOutput = () => {
  // Recording state belongs only to this synthetic stderr sink.
  let text = ""
  return {
    write: (chunk: string): void => {
      text += chunk
    },
    getText: (): string => text,
  }
}
