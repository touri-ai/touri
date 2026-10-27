import { afterEach, expect, test, vi } from "vitest"
import { installLazyAssetRecovery } from "../src/lazyAssetRecovery"

afterEach(() => {
  window.sessionStorage.clear()
  vi.clearAllTimers()
  vi.useRealTimers()
})

test("keeps pending attachments when a lazy stylesheet fails", () => {
  vi.useFakeTimers()
  const target = new EventTarget()
  const reload = vi.fn()
  const event = new Event("vite:preloadError", { cancelable: true })

  installLazyAssetRecovery({
    target,
    getStorage: () => window.sessionStorage,
    canReload: () => false,
    reload,
  })

  target.dispatchEvent(event)

  expect(reload).not.toHaveBeenCalled()
  expect(event.defaultPrevented).toBe(false)
})

test("retries a failed lazy stylesheet once and exposes a repeated failure", () => {
  vi.useFakeTimers()
  const target = new EventTarget()
  const reload = vi.fn()

  installLazyAssetRecovery({
    target,
    getStorage: () => window.sessionStorage,
    canReload: () => true,
    reload,
  })

  const firstError = new Event("vite:preloadError", { cancelable: true })
  target.dispatchEvent(firstError)

  const repeatedError = new Event("vite:preloadError", { cancelable: true })
  target.dispatchEvent(repeatedError)

  expect(reload).toHaveBeenCalledTimes(1)
  expect(firstError.defaultPrevented).toBe(true)
  expect(repeatedError.defaultPrevented).toBe(false)
})

test("allows another recovery after the retry marker expires", () => {
  vi.useFakeTimers()
  const target = new EventTarget()
  const reload = vi.fn()

  installLazyAssetRecovery({
    target,
    getStorage: () => window.sessionStorage,
    canReload: () => true,
    reload,
  })

  const firstError = new Event("vite:preloadError", { cancelable: true })
  target.dispatchEvent(firstError)
  vi.advanceTimersByTime(30_000)

  const laterError = new Event("vite:preloadError", { cancelable: true })
  target.dispatchEvent(laterError)

  expect(reload).toHaveBeenCalledTimes(2)
  expect(laterError.defaultPrevented).toBe(true)
})

test.each(["missing", "read fails", "write fails"])("leaves errors visible when retry storage is %s", (failure) => {
  vi.useFakeTimers()
  const target = new EventTarget()
  const reload = vi.fn()
  const event = new Event("vite:preloadError", { cancelable: true })
  const storage = {
    getItem: () => {
      if (failure === "read fails") throw new Error("Synthetic read failure")

      return null
    },
    setItem: () => {
      if (failure === "write fails") throw new Error("Synthetic write failure")
    },
    removeItem: () => undefined,
  }
  installLazyAssetRecovery({
    target,
    getStorage: () => (failure === "missing" ? undefined : storage),
    canReload: () => true,
    reload,
  })

  target.dispatchEvent(event)

  expect(reload).not.toHaveBeenCalled()
  expect(event.defaultPrevented).toBe(false)
})
