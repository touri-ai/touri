import { afterEach, expect, test, vi } from "vitest"
import { ApiError, isServiceUnavailable } from "../src/errors"
import { getHistoryFailure, getWithRetry, isRetryableHistoryError, isUnreachable } from "../src/historyFailure"

afterEach(() => {
  vi.useRealTimers()
})

test("a draining server is a restart, not a broken conversation", () => {
  const error = new ApiError(503, '{"errorCode":"RUNTIME_DRAINING"}', "RUNTIME_DRAINING")

  const failure = getHistoryFailure(error, true)

  expect(isServiceUnavailable(error)).toBe(true)
  expect(failure).toMatchObject({ kind: "restarting", code: "TOURI-E1009" })
  expect(isRetryableHistoryError(error)).toBe(true)
})

test("a deleted conversation is named and never retried", () => {
  const error = new ApiError(404, "Thread not found", "NOT_FOUND")

  const failure = getHistoryFailure(error, true)

  expect(failure).toMatchObject({ kind: "deleted", code: "TOURI-E1002" })
  expect(isRetryableHistoryError(error)).toBe(false)
})

test("an offline device reports the connection before any server cause", () => {
  const error = new ApiError(0, "", undefined, "TOURI-E1009")

  expect(getHistoryFailure(error, false).kind).toBe("offline")
  expect(getHistoryFailure(new ApiError(500, "boom", "INTERNAL"), true)).toMatchObject({
    kind: "server",
    code: "TOURI-E1000",
  })
})

test("a transient read failure is retried once after a backoff", async () => {
  vi.useFakeTimers()
  const read = vi
    .fn<() => Promise<string>>()
    .mockRejectedValueOnce(new ApiError(503, "", "RUNTIME_DRAINING"))
    .mockResolvedValueOnce("history")

  const result = getWithRetry(read, { signal: new AbortController().signal, delayMs: 1000 })
  await vi.advanceTimersByTimeAsync(999)
  const callsBeforeBackoff = read.mock.calls.length
  await vi.advanceTimersByTimeAsync(1)

  expect(callsBeforeBackoff).toBe(1)
  await expect(result).resolves.toBe("history")
  expect(read).toHaveBeenCalledTimes(2)
})

test("a second failure is reported instead of retrying again", async () => {
  vi.useFakeTimers()
  const read = vi.fn<() => Promise<string>>().mockRejectedValue(new ApiError(502, "Bad gateway"))

  const result = getWithRetry(read, { signal: new AbortController().signal, delayMs: 10 })
  const settled = expect(result).rejects.toMatchObject({ status: 502 })
  await vi.advanceTimersByTimeAsync(10)

  await settled
  expect(read).toHaveBeenCalledTimes(2)
})

test("canceling a conversation read during backoff stops the retry", async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const read = vi.fn<() => Promise<string>>().mockRejectedValue(new ApiError(503, "", "RUNTIME_DRAINING"))
  const result = getWithRetry(read, { signal: controller.signal, delayMs: 1000 })
  const settled = expect(result).rejects.toMatchObject({ name: "AbortError" })
  await vi.advanceTimersByTimeAsync(100)

  controller.abort()
  await vi.advanceTimersByTimeAsync(1000)

  await settled
  expect(read).toHaveBeenCalledTimes(1)
})

test("only a request that never reached the server counts as unreachable", () => {
  const stopped = new ApiError(0, "", undefined, "TOURI-E1009")
  const gateway = new ApiError(502, "Bad gateway")

  expect(isUnreachable(stopped)).toBe(true)
  expect(isUnreachable(new ApiError(503, "", "SERVER_CONNECTION_FAILED"))).toBe(true)
  expect(isUnreachable(gateway)).toBe(false)
})
