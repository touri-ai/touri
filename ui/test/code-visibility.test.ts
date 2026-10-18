import { describe, expect, it, vi } from "vitest"
import { type CodeObserverFactory, observeCodeVisibility } from "../src/components/codeVisibility"

describe("long reply code visibility", () => {
  it("waits for a positive visible area before preparing syntax", () => {
    const fixture = getVisibilityFixture()

    observeCodeVisibility(fixture.element, fixture.show, fixture.createObserver)
    const notify = fixture.createObserver.mock.calls[0]?.[0]
    notify?.([{ isIntersecting: false, intersectionRatio: 0 }])
    notify?.([{ isIntersecting: true, intersectionRatio: 0 }])

    expect(fixture.observe).toHaveBeenCalledWith(fixture.element)
    expect(fixture.show).not.toHaveBeenCalled()

    notify?.([{ isIntersecting: true, intersectionRatio: 0.5 }])
    notify?.([{ isIntersecting: true, intersectionRatio: 1 }])

    expect(fixture.show).toHaveBeenCalledOnce()
    expect(fixture.disconnect).toHaveBeenCalledOnce()
  })

  it("disconnects when a message is removed and ignores already queued callbacks", () => {
    const fixture = getVisibilityFixture()
    const stop = observeCodeVisibility(fixture.element, fixture.show, fixture.createObserver)

    stop()
    fixture.createObserver.mock.calls[0]?.[0]([{ isIntersecting: true, intersectionRatio: 1 }])

    expect(fixture.disconnect).toHaveBeenCalledOnce()
    expect(fixture.show).not.toHaveBeenCalled()
  })

  it("keeps syntax available when the browser has no visibility observer", () => {
    const show = vi.fn()

    observeCodeVisibility(document.createElement("div"), show, () => null)

    expect(show).toHaveBeenCalledOnce()
  })
})

const getVisibilityFixture = () => {
  const show = vi.fn()
  const observe = vi.fn()
  const disconnect = vi.fn()
  const createObserver = vi.fn<CodeObserverFactory>(() => ({ observe, disconnect }))

  return { element: document.createElement("div"), show, observe, disconnect, createObserver }
}
