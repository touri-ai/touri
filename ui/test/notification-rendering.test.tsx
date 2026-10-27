import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import { type MascotEvent, MascotMachine } from "../src/components/mascotState"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

test("notification toggles reuse bot activity until workspace data changes", async () => {
  const api = createMockApi({ scenario: "interrupted-tasks" })
  const updates = vi.spyOn(MascotMachine.prototype, "send")
  const view = render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  const bell = screen.getByRole("button", { name: /Notificações,/ })
  fireEvent.click(bell)
  const center = await screen.findByRole("region", { name: "Central de notificações" })
  expect(within(center).getAllByTestId("notification-row")).toHaveLength(3)
  await act(async () => {
    fireEvent.click(bell)
  })
  const baseline = getRuntimeUpdateCount(updates.mock.calls)

  Array.from({ length: 20 }, (_, index) => index).forEach((index) => {
    fireEvent.click(bell)
    expect(bell).toHaveAttribute("aria-expanded", String(index % 2 === 0))
  })

  expect(getRuntimeUpdateCount(updates.mock.calls)).toBe(baseline)
  expect(bell).toHaveAttribute("aria-expanded", "false")

  fireEvent.click(bell)
  fireEvent.keyDown(window, { key: "Escape" })

  expect(bell).toHaveAttribute("aria-expanded", "false")
  expect(getRuntimeUpdateCount(updates.mock.calls)).toBe(baseline)

  act(() => {
    api.notify({
      kind: "question",
      botId: "bot-mark",
      threadId: "thread-mark",
      requestId: "issue998-question",
      title: "Escolha uma opção",
      body: "Qual opção devo usar?",
    })
  })

  await waitFor(() => {
    expect(view.container.querySelector(".chat-bot-chip .tb-avatar")).toHaveAttribute(
      "data-mascot-state",
      "waiting-approval",
    )
  })
  expect(getRuntimeUpdateCount(updates.mock.calls)).toBeGreaterThan(baseline)
})

const getRuntimeUpdateCount = (calls: ReadonlyArray<readonly [MascotEvent, number]>): number =>
  calls.filter(([event]) => event.type === "runtime").length
