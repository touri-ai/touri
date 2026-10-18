import { expect, test } from "bun:test"
import { relayHeadlessStderr } from "../../src/cli/serveStderr"

const getStream = (chunks: Array<string>): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      chunks.forEach((chunk) => {
        controller.enqueue(new TextEncoder().encode(chunk))
      })
      controller.close()
    },
  })

test("headless serve warns once, counts repeated scheduling denials, and preserves other stderr", async () => {
  const output: Array<string> = []
  const stream = getStream([
    "Failed to apply scheduling attributes to th",
    "read 101: Operation not permitted\n",
    "Failed to apply scheduling attributes to thread 102: Operation not permitted\n",
    "Failed to apply scheduling attributes to thread 103: Permission denied\n",
    "server diagnostic after scheduling denial\n",
  ])

  await relayHeadlessStderr(stream, (text) => {
    output.push(text)
  })

  const stderr = output.join("")
  expect(stderr).toBe(
    "Optional scheduling adjustment was denied; continuing with the existing thread policy.\n" +
      "Failed to apply scheduling attributes to thread 103: Permission denied\n" +
      "server diagnostic after scheduling denial\n" +
      "Suppressed 1 additional scheduling denials.\n",
  )
  expect(stderr).not.toContain("thread 101")
  expect(stderr).not.toContain("thread 102")
})

test("headless serve relays stderr unchanged when scheduling succeeds", async () => {
  const output: Array<string> = []

  await relayHeadlessStderr(getStream(["server ready\n", "next line\n"]), (text) => {
    output.push(text)
  })

  expect(output.join("")).toBe("server ready\nnext line\n")
})
