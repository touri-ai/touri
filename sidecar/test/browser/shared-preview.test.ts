import { expect, test } from "bun:test"
import { createSharedBrowserPreview } from "../../src/browser/shared-preview"

const getDeferred = <T>() => {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })

  return { promise, resolve }
}
const getFrame = () => ({
  image: "data:image/jpeg;base64,ZmFrZQ==",
  title: "Synthetic results",
  url: "https://example.test",
})
const getRequest = (signal = new AbortController().signal) => ({ botId: "leo", tabId: "tab", signal })

test("ten channel viewers share one capture and the bounded fresh frame", async () => {
  const deferred = getDeferred<ReturnType<typeof getFrame>>()
  let captures = 0
  const source = createSharedBrowserPreview({
    capture: async () => {
      captures += 1
      return deferred.promise
    },
    now: () => 1_000,
  })

  const viewers = Array.from({ length: 10 }, () => source.get(getRequest()))
  deferred.resolve(getFrame())
  const frames = await Promise.all(viewers)
  const next = await source.get(getRequest())

  expect(captures).toBe(1)
  expect(frames).toEqual(Array.from({ length: 10 }, getFrame))
  expect(next).toEqual(getFrame())
  if (!next) throw new Error("Missing shared frame")
  expect(source.getEncoded(next)).toBe(source.getEncoded(next))
  expect(JSON.parse(new TextDecoder().decode(source.getEncoded(next)))).toEqual(getFrame())
  source.dispose()
})

test("takeover purges the cached frame and rejects a late shared capture", async () => {
  const deferred = getDeferred<ReturnType<typeof getFrame>>()
  let signal: AbortSignal | undefined
  const source = createSharedBrowserPreview({
    capture: async (request) => {
      signal = request.signal
      return deferred.promise
    },
  })

  const viewers = Array.from({ length: 10 }, () => source.get(getRequest()))
  source.invalidate("tab")
  deferred.resolve(getFrame())

  expect(signal?.aborted).toBe(true)
  expect(await Promise.all(viewers)).toEqual(Array.from({ length: 10 }, () => null))
  source.dispose()
})

test("one departing viewer cannot cancel the capture for the remaining viewer", async () => {
  const deferred = getDeferred<ReturnType<typeof getFrame>>()
  const source = createSharedBrowserPreview({ capture: async () => deferred.promise })
  const departing = new AbortController()

  const first = source.get(getRequest(departing.signal))
  const second = source.get(getRequest())
  departing.abort()
  expect(await first).toBeNull()
  deferred.resolve(getFrame())

  expect(await second).toEqual(getFrame())
  source.dispose()
})

test("an invalidated capture must settle before another capture can start for its tab", async () => {
  const deferred = getDeferred<ReturnType<typeof getFrame>>()
  let captures = 0
  const source = createSharedBrowserPreview({
    capture: async () => {
      captures += 1
      return deferred.promise
    },
  })

  const first = source.get(getRequest())
  source.invalidateBot("leo")
  const second = source.get(getRequest())
  deferred.resolve(getFrame())

  expect(await first).toBeNull()
  expect(await second).toBeNull()
  expect(captures).toBe(1)
  source.dispose()
})

test("the last departing viewer cancels the shared capture", async () => {
  const deferred = getDeferred<ReturnType<typeof getFrame>>()
  let captureSignal: AbortSignal | undefined
  const source = createSharedBrowserPreview({
    capture: async ({ signal }) => {
      captureSignal = signal
      return deferred.promise
    },
  })
  const viewer = new AbortController()

  const pending = source.get(getRequest(viewer.signal))
  viewer.abort()

  expect(await pending).toBeNull()
  expect(captureSignal?.aborted).toBe(true)
  deferred.resolve(getFrame())
  source.dispose()
})
