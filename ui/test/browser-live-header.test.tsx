import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"
import { BrowserLiveHeader } from "../src/components/BrowserLiveHeader"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

test.each([
  { locale: "pt-BR" as const, status: "Esperando Ana", elapsed: "há 2 s" },
  { locale: "en" as const, status: "Waiting for Ana", elapsed: "2 s ago" },
])("elapsed time does not repeat live announcements in $locale", ({ locale, status, elapsed }) => {
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
  const view = render(
    <BrowserLiveHeader
      botName="Lia"
      waiting
      requesterName="Ana"
      controllerName={null}
      startedAt={10_000}
      locale={locale}
    />,
  )
  const announcement = screen.getByRole("status")

  act(() => vi.advanceTimersByTime(2_000))

  expect(announcement).toHaveTextContent(status)
  expect(announcement).not.toHaveTextContent(elapsed)
  expect(screen.getByText(`· ${elapsed}`)).toHaveAttribute("aria-hidden", "true")

  view.rerender(
    <BrowserLiveHeader
      botName="Lia"
      waiting
      requesterName="Ana"
      controllerName="Ana"
      startedAt={10_000}
      locale={locale}
    />,
  )
  act(() => vi.advanceTimersByTime(2_000))

  expect(screen.getByRole("status")).toHaveTextContent(locale === "en" ? "Ana is using the browser" : "Ana está usando")
  expect(screen.getByText("· 0:02")).toHaveAttribute("aria-hidden", "true")

  view.unmount()

  expect(vi.getTimerCount()).toBe(0)
})

test.each([
  { locale: "pt-BR" as const, person: "você", status: "você está usando" },
  { locale: "en" as const, person: "you", status: "You are using the browser" },
])("self control uses the correct grammar in $locale", ({ locale, person, status }) => {
  render(
    <BrowserLiveHeader
      botName="Lia"
      waiting
      requesterName={person}
      controllerName={person}
      selfControl
      startedAt={Date.now()}
      locale={locale}
    />,
  )

  expect(screen.getByRole("status")).toHaveTextContent(status)
})
