import { afterEach, expect, test } from "bun:test"
import { createBrowserScreencast } from "../../src/browser/screencast"
import type { CdpClient, CdpEvent, JsonObject } from "../../src/browser/types"

const cleanups = new Set<() => void>()
afterEach(() => {
  cleanups.forEach((stop) => {
    stop()
  })
  cleanups.clear()
})

const getFixture = async () => {
  const listeners = new Set<(event: CdpEvent) => void>()
  const calls: Array<{ method: string; params: JsonObject }> = []
  const client: CdpClient = {
    call: async <T>(method: string, params: JsonObject = {}) => {
      calls.push({ method, params })
      return {} as T
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close: async () => {},
    isClosed: () => false,
  }
  const source = await createBrowserScreencast({ client, sessionId: "owned", width: 800, height: 500 })
  cleanups.add(source.stop)
  const emit = (id: number, sessionId = "owned", data = "ZmFrZQ==") => {
    listeners.forEach((listener) => {
      listener({ method: "Page.screencastFrame", sessionId, params: { sessionId: id, data } })
    })
  }

  return { source, calls, emit, listeners }
}

test("consumes pushed frames, acknowledges demand and keeps only the latest image", async () => {
  const { source, calls, emit } = await getFixture()
  emit(1)
  emit(2)
  expect(calls.map((call) => call.method)).toEqual(["Page.startScreencast"])

  const frame = await source.read(new AbortController().signal)

  expect(frame).toEqual({ image: "data:image/jpeg;base64,ZmFrZQ==", width: 800, height: 500 })
  expect(
    calls.filter((call) => call.method === "Page.screencastFrameAck").map((call) => call.params.sessionId),
  ).toEqual([1, 2])
  expect(calls.some((call) => call.method === "Page.captureScreenshot")).toBe(false)
})

test("cancellation wakes a pending read without exposing another CDP session", async () => {
  const { source, emit } = await getFixture()
  const controller = new AbortController()
  const pending = source.read(controller.signal)

  emit(1, "another-tab")
  controller.abort()

  expect(await pending).toBeNull()
})

test("stop discards private images and detaches listeners", async () => {
  const { source, emit, listeners, calls } = await getFixture()
  emit(1)

  source.stop()

  expect(await source.read(new AbortController().signal)).toBeNull()
  expect(listeners.size).toBe(0)
  expect(calls.at(-1)?.method).toBe("Page.stopScreencast")
})

test("oversized images stop capture and request a bounded screenshot fallback", async () => {
  const { source, emit, listeners, calls } = await getFixture()

  emit(1, "owned", "x".repeat(450_001))

  expect(source.isStopped()).toBe(true)
  expect(await source.read(new AbortController().signal)).toBeNull()
  expect(source.needsScreenshot()).toBe(true)
  expect(listeners.size).toBe(0)
  expect(calls.at(-1)?.method).toBe("Page.stopScreencast")
})
