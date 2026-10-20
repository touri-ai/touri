import { act, cleanup, render, waitFor } from "@testing-library/react"
import { StrictMode } from "react"
import { afterEach, expect, it, vi } from "vitest"
import { VirtualMessageList } from "../src/components/ChatPanel"

const getCards = (height: number) =>
  Array.from({ length: 101 }, (_, index) => ({
    id: `card-${index}`,
    createdAt: index,
    content: <div data-height={index === 0 ? height : 100} />,
  }))

const installMeasurements = () => {
  const notifications = new Set<() => void>()
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const height = Number(this.firstElementChild?.getAttribute("data-height") ?? 0)
    return new DOMRect(0, 0, 400, height)
  })
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        notifications.add(callback)
      }
      observe() {}
      disconnect() {}
    },
  )
  return () =>
    notifications.forEach((notify) => {
      notify()
    })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it.each([false, true])("updates virtual offsets when a row grows and collapses (strict: %s)", async (strict) => {
  const notifyResize = installMeasurements()
  const getList = (height: number) => (
    <VirtualMessageList
      messages={[]}
      timelineCards={getCards(height)}
      onSwitchBranch={() => undefined}
      onRetry={async () => undefined}
    />
  )
  const view = render(getList(100), strict ? { wrapper: StrictMode } : {})
  const spacer = view.getByTestId("virtual-message-list").firstElementChild
  const originalHeight = 34 * 100 + 67 * 158
  await waitFor(() => expect(spacer).toHaveStyle({ height: `${originalHeight}px` }))

  view.rerender(getList(600))
  act(notifyResize)

  await waitFor(() => expect(spacer).toHaveStyle({ height: `${originalHeight + 500}px` }))

  view.rerender(getList(100))
  act(notifyResize)

  await waitFor(() => expect(spacer).toHaveStyle({ height: `${originalHeight}px` }))
})
