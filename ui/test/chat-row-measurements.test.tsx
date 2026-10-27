import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import { StrictMode } from "react"
import { afterEach, expect, it, vi } from "vitest"
import * as browserRequestMessages from "../src/components/browserRequestMessages"
import { VirtualMessageList } from "../src/components/ChatPanel"
import { requestReveal } from "../src/components/revealEvent"

const getCards = (height: number) =>
  Array.from({ length: 101 }, (_, index) => ({
    id: `card-${index}`,
    createdAt: index,
    content: <div data-height={index === 100 ? height : 100} />,
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

it("scrolling does not rebuild an unchanged transcript when runs are omitted", () => {
  const getMessages = vi.spyOn(browserRequestMessages, "getBrowserRequestMessages")
  const view = render(
    <VirtualMessageList messages={[]} onSwitchBranch={() => undefined} onRetry={async () => undefined} />,
  )
  const initialCalls = getMessages.mock.calls.length

  fireEvent.scroll(view.getByTestId("virtual-message-list"), { target: { scrollTop: 100 } })

  expect(getMessages).toHaveBeenCalledTimes(initialCalls)
})

it("the conversation history accepts keyboard focus for scrolling", () => {
  const view = render(
    <VirtualMessageList messages={[]} onSwitchBranch={() => undefined} onRetry={async () => undefined} />,
  )
  const history = view.getByRole("region", { name: "Histórico da conversa" })

  history.focus()

  expect(history).toHaveFocus()
})

it("offers the latest page even when an older search page is at its bottom", () => {
  const onLatestHistory = vi.fn()
  const view = render(
    <VirtualMessageList
      messages={[]}
      onLatestHistory={onLatestHistory}
      onSwitchBranch={() => undefined}
      onRetry={async () => undefined}
    />,
  )

  fireEvent.click(view.getByRole("button", { name: "Voltar ao fim" }))

  expect(onLatestHistory).toHaveBeenCalledTimes(1)
})

it.each([false, true])("keeps a revealed control anchored after a clamped scroll (following: %s)", (following) => {
  const notifyResize = installMeasurements()
  const view = render(
    <VirtualMessageList
      messages={[]}
      timelineCards={[{ id: "browser-control", createdAt: 0, content: <button type="button">Devolver</button> }]}
      onSwitchBranch={() => undefined}
      onRetry={async () => undefined}
    />,
  )
  const history = view.getByRole("region", { name: "Histórico da conversa" })
  const control = view.getByRole("button", { name: "Devolver" })
  const setScrollHeight = installHistoryLayout(history, control)
  history.scrollTop = 10
  fireEvent.scroll(history)
  if (following) fireEvent.click(view.getByRole("button", { name: "Voltar ao fim" }))
  act(() => requestReveal(control))
  expect(history.scrollTop).toBe(554)

  const clampHistory = () => {
    setScrollHeight(930)
    fireEvent.scroll(history)
    setScrollHeight(1000)
    act(notifyResize)
  }

  clampHistory()
  clampHistory()

  expect(history.scrollTop).toBe(554)
  expect(control.getBoundingClientRect().top).toBe(8)

  history.scrollTop = 300
  fireEvent.scroll(history)
  act(notifyResize)

  expect(history.scrollTop).toBe(300)
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
  await waitFor(() => {
    const mountedCount = view.container.querySelectorAll("[data-message-row]").length
    expect(spacer).toHaveStyle({ height: `${mountedCount * 100 + (101 - mountedCount) * 158}px` })
  })
  const originalHeight = Number.parseFloat((spacer as HTMLElement).style.height)

  view.rerender(getList(600))
  act(notifyResize)

  await waitFor(() => expect(spacer).toHaveStyle({ height: `${originalHeight + 500}px` }))

  view.rerender(getList(100))
  act(notifyResize)

  await waitFor(() => expect(spacer).toHaveStyle({ height: `${originalHeight}px` }))
})

const installHistoryLayout = (history: HTMLElement, control: HTMLElement) => {
  // These local setters emulate the browser clamping scrollTop when measured rows shrink.
  let scrollHeight = 1000
  let scrollTop = 0
  Object.defineProperties(history, {
    clientHeight: { configurable: true, get: () => 400 },
    scrollHeight: { configurable: true, get: () => scrollHeight },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.max(0, Math.min(value, scrollHeight - 400))
      },
    },
  })
  vi.spyOn(history, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 400))
  vi.spyOn(control, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 562 - scrollTop, 100, 44))

  return (height: number) => {
    scrollHeight = height
    scrollTop = Math.min(scrollTop, scrollHeight - 400)
  }
}
