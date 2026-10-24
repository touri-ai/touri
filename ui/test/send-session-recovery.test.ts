import { afterEach, expect, test, vi } from "vitest"
import type { ApiRequest } from "../src/api/client"
import { createSendJournal } from "../src/api/sendJournal"
import { ApiError } from "../src/errors"

// These external resources need explicit teardown even when an assertion fails.
const journals = new Set<ReturnType<typeof createSendJournal>>()
afterEach(() => {
  journals.forEach((journal) => {
    journal.stop()
  })
  journals.clear()
  vi.useRealTimers()
})

test("session revocation retains the pending send across recreation and retries its original identity after pairing", async () => {
  vi.useFakeTimers()
  const input = getInput()
  const rejected = vi.fn<ApiRequest>(async () => {
    throw new ApiError(401, "", "UNAUTHORIZED")
  })
  const journal = getJournal(rejected)

  await journal.enqueue(input)
  await vi.advanceTimersByTimeAsync(5000)

  expect(rejected).toHaveBeenCalledOnce()
  expect(journal.messages()[0]).toMatchObject({ text: input.text, delivery: { status: "sent" } })
  journal.stop()
  const pending = journal.messages()[0]
  if (!pending) throw new Error("Missing synthetic pending message")
  const message = Object.assign({}, pending, {
    delivery: Object.assign({}, pending.delivery, { status: "acked" as const }),
  })
  const recovered = vi.fn<ApiRequest>(async () => ({ message, run: null }) as never)
  const restored = getJournal(recovered)

  expect(restored.messages()).toEqual(journal.messages())
  restored.reconnect()
  await vi.advanceTimersByTimeAsync(0)

  expect(recovered).toHaveBeenCalledExactlyOnceWith("POST /threads/:id/messages", input, { id: input.threadId })
  expect(restored.messages()).toEqual([])
})

test("a resource permission rejection remains a failed message and is never automatically resent", async () => {
  vi.useFakeTimers()
  const input = getInput()
  const request = vi.fn<ApiRequest>(async () => {
    throw new ApiError(403, "", "FORBIDDEN")
  })
  const journal = getJournal(request)

  await journal.enqueue(input)
  await vi.advanceTimersByTimeAsync(0)
  journal.reconnect()
  await vi.advanceTimersByTimeAsync(5000)

  expect(request).toHaveBeenCalledOnce()
  expect(journal.messages()[0]).toMatchObject({ text: input.text, delivery: { status: "failed" } })
})

const getJournal = (request: ApiRequest) => {
  const journal = createSendJournal({ request, emit: vi.fn(), storage: localStorage, now: () => 1 })
  journals.add(journal)
  return journal
}

const getInput = () => ({
  threadId: "synthetic-thread",
  parentId: null,
  text: "Mensagem de teste que deve permanecer salva.",
  attachmentIds: [],
  clientNonce: "synthetic-nonce",
  deadline: 60_000,
})
