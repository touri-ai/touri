import { expect, test } from "bun:test"
import { getChromeSandboxDenied, isChromeSandboxDenied, startChromeSandboxDiagnostic } from "../../src/browser/sandbox"

test.each([
  "No usable sandbox!",
  "Failed to move to new namespace: Operation not permitted",
  "Failed to unshare: Operation not permitted",
  "Running as root without --no-sandbox is not supported",
])("recognizes a Chrome sandbox failure: %s", (diagnostic) => {
  expect(isChromeSandboxDenied(diagnostic)).toBe(true)
})

test("does not misdiagnose unrelated crashes as namespace failures", () => {
  expect(isChromeSandboxDenied("Renderer process crashed")).toBe(false)
  expect(isChromeSandboxDenied("out of memory")).toBe(false)
})

test("diagnosis spans chunks, drains a full pipe and bounds retained output", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(new TextEncoder().encode("Failed to move to new name"))
      controller.enqueue(new TextEncoder().encode("space: Operation not permitted"))
      controller.enqueue(new Uint8Array(100_000))
      controller.close()
    },
  })

  const denied = await getChromeSandboxDenied(stream)

  expect(denied).toBe(true)
  expect(stream.locked).toBe(false)
})

test("a descendant holding stderr cannot keep a failed launch waiting indefinitely", async () => {
  const canceled = Promise.withResolvers<void>()
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => controller.enqueue(new TextEncoder().encode("No usable sandbox!")),
    cancel: () => canceled.resolve(),
  })
  const getDiagnosis = startChromeSandboxDiagnostic(stream)

  const denied = await getDiagnosis()
  await canceled.promise

  expect(denied).toBe(true)
  expect(stream.locked).toBe(false)
})
