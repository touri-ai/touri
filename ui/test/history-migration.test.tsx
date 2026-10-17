import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { HistoryMigrationStatus } from "../src/features/history/HistoryMigrationStatus"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it("shows non-blocking pt-BR history progress and removes the indicator after completion", async () => {
  vi.useFakeTimers()
  let done = 42
  const base = createMockApi()
  const request: ApiRequest = async (route, input, path) =>
    route === "GET /health"
      ? ({
          ok: true,
          version: "0.2.0",
          schemaVersion: 7,
          historyMigration: { running: done < 100, done, total: 100 },
        } as never)
      : base.request(route, input, path)
  await act(async () => {
    render(<HistoryMigrationStatus api={{ ...base, request }} />)
  })
  expect(screen.getByRole("status")).toHaveTextContent("Migrando histórico… 42%")
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  done = 76
  await act(async () => vi.advanceTimersByTimeAsync(1000))
  expect(screen.getByRole("status")).toHaveTextContent("76%")
  done = 100
  await act(async () => vi.advanceTimersByTimeAsync(1000))
  expect(screen.queryByRole("status")).not.toBeInTheDocument()
})

it("retries health failures and cancels background polling on unmount", async () => {
  vi.useFakeTimers()
  const base = createMockApi()
  const health = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({ historyMigration: { running: true, done: 1, total: 10 } })
  const request: ApiRequest = async (route, input, path) =>
    route === "GET /health" ? health() : base.request(route, input, path)
  let view: ReturnType<typeof render> | undefined
  await act(async () => {
    view = render(<HistoryMigrationStatus api={{ ...base, request }} />)
  })
  expect(screen.queryByRole("status")).not.toBeInTheDocument()
  await act(async () => vi.advanceTimersByTimeAsync(1000))
  expect(screen.getByRole("status")).toHaveTextContent("10%")
  view?.unmount()
  await act(async () => vi.advanceTimersByTimeAsync(5000))
  expect(health).toHaveBeenCalledTimes(2)
})
