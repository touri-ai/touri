import { expect, test } from "bun:test"
import type { Message } from "@touri/contracts"
import { getHistoryAttachmentMessageIds } from "../../src/store/history-attachment-candidates"

const getParts = (): Message["parts"] => [
  { type: "file", attachmentId: "synthetic-file", name: "synthetic.txt", mime: "text/plain" },
]

test("historical attachment inspection yields while it still has candidates to inspect", async () => {
  let interleaved = false
  const inspectedAfterYield = new Set<string>()
  const messages = Array.from({ length: 96 }, (_, index) => ({
    id: `message-${index}`,
    threadId: "thread",
    get parts() {
      if (interleaved) inspectedAfterYield.add(`message-${index}`)
      return getParts()
    },
  }))
  setImmediate(() => {
    interleaved = true
  })

  const ids = await getHistoryAttachmentMessageIds("thread", messages, new AbortController().signal)

  expect(ids).toEqual(messages.map(({ id }) => id))
  expect(inspectedAfterYield.size).toBeGreaterThan(0)
  expect(inspectedAfterYield.size).toBeLessThan(messages.length)
})

test("candidate inspection respects thread scope and excludes messages without attachments", async () => {
  const messages = [
    { id: "file", threadId: "thread", parts: getParts() },
    { id: "empty", threadId: "thread", parts: [] },
    { id: "foreign", threadId: "other", parts: getParts() },
  ]

  const ids = await getHistoryAttachmentMessageIds("thread", messages, new AbortController().signal)

  expect(ids).toEqual(["file"])
})

test("cancellation interrupts inspection before the next candidate batch", async () => {
  const controller = new AbortController()
  const messages = Array.from({ length: 96 }, (_, index) => ({
    id: `message-${index}`,
    threadId: "thread",
    parts: getParts(),
  }))
  setImmediate(() => controller.abort(new Error("Synthetic cancellation")))

  await expect(getHistoryAttachmentMessageIds("thread", messages, controller.signal)).rejects.toThrow(
    "Synthetic cancellation",
  )
})

test("cancellation during inspection stops before reading another candidate", async () => {
  const controller = new AbortController()
  const inspected = new Set<string>()
  const messages = Array.from({ length: 96 }, (_, index) => ({
    id: `message-${index}`,
    threadId: "thread",
    get parts() {
      inspected.add(`message-${index}`)
      controller.abort(new Error("Synthetic cancellation"))
      return getParts()
    },
  }))

  const result = getHistoryAttachmentMessageIds("thread", messages, controller.signal)

  await expect(result).rejects.toThrow("Synthetic cancellation")
  expect(Array.from(inspected)).toEqual(["message-0"])
})
