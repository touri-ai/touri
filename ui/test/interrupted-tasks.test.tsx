import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react"
import { memo, useContext } from "react"
import { afterEach, expect, it, vi } from "vitest"
import { createMockApi } from "../src/api/mock"
import { VirtualMessageList } from "../src/components/ChatPanel"
import { InterruptedTasks } from "../src/components/InterruptedTasks"
import { dictionaries, getInterruptedTaskDateLabel } from "../src/i18n"
import { pendingNotifications } from "../src/sidebarAttention"
import { RecoveryTasksContext, useRecoveryTasks } from "../src/useRecoveryTasks"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it("groups pending work by bot, reviews recorded actions and requires acknowledgement before dismissal", async () => {
  const api = createMockApi({ scenario: "interrupted-tasks" })
  const { tasks } = await api.request("GET /recovery", {})
  const onDismiss = vi.fn(async () => undefined)
  render(
    <InterruptedTasks
      tasks={tasks}
      loading={false}
      error={null}
      onClose={vi.fn()}
      onReview={vi.fn()}
      onResume={vi.fn()}
      onDismiss={onDismiss}
    />,
  )
  const uncertain = within(screen.getByRole("region", { name: "onb" })).getByTestId("interrupted-task")

  fireEvent.click(within(uncertain).getByRole("button", { name: /Ver ações realizadas/ }))

  expect(within(uncertain).getByText("Prévia do projeto")).toBeVisible()
  expect(within(uncertain).getByRole("button", { name: "Descartar" })).toBeDisabled()
  expect(onDismiss).not.toHaveBeenCalled()

  fireEvent.click(within(uncertain).getByRole("checkbox"))
  await act(async () => fireEvent.click(within(uncertain).getByRole("button", { name: "Descartar" })))

  expect(onDismiss).toHaveBeenCalledWith(expect.objectContaining({ id: "journal:process-demo" }), ["process-preview"])
  expect(screen.getAllByRole("region").length).toBeGreaterThanOrEqual(3)
})

it("requires acknowledgement for uncertain effects without a backend key", async () => {
  const api = createMockApi({ scenario: "interrupted-tasks" })
  const { tasks } = await api.request("GET /recovery", {})
  const uncertainTask = tasks.find((task) => task.id === "run:run-interrupted")
  if (!uncertainTask) throw new Error("Expected uncertain interrupted task")
  const ordinaryTask = {
    ...uncertainTask,
    effects: uncertainTask.effects.map((effect) => ({ ...effect, uncertain: false })),
  }
  const props = {
    loading: false,
    error: null,
    onClose: vi.fn(),
    onReview: vi.fn(),
    onResume: vi.fn(),
    onDismiss: vi.fn(async () => undefined),
  }
  const view = render(<InterruptedTasks {...props} tasks={[uncertainTask]} />)

  expect(screen.getByRole("checkbox")).toBeVisible()
  expect(screen.getByRole("button", { name: "Descartar" })).toBeDisabled()

  view.rerender(<InterruptedTasks {...props} tasks={[ordinaryTask]} />)

  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Descartar" })).toBeEnabled()
})

it("shows a short local date or a minute-only label for interrupted tasks", async () => {
  vi.useFakeTimers()
  const now = new Date(2026, 9, 18, 12, 0)
  vi.setSystemTime(now)

  const api = createMockApi({ scenario: "interrupted-tasks" })
  const { tasks } = await api.request("GET /recovery", {})
  const task = tasks[0]
  if (!task) throw new Error("Expected interrupted task")
  const occurredAt = new Date(2026, 9, 18, 11, 28, 27).getTime()
  const props = {
    loading: false,
    error: null,
    onClose: vi.fn(),
    onReview: vi.fn(),
    onResume: vi.fn(),
    onDismiss: vi.fn(),
  }
  const view = render(<InterruptedTasks {...props} tasks={[{ ...task, occurredAt }]} />)

  const today = screen.getByText("hoje às 11:28", { selector: "time" })
  expect(today).toHaveAttribute("dateTime", new Date(occurredAt).toISOString())
  expect(today).toHaveAttribute("title", "18/10/2026, 11:28")
  expect(getInterruptedTaskDateLabel(occurredAt, "en", Date.now())).toBe("today at 11:28 AM")

  const yesterday = new Date(2026, 9, 17, 11, 28, 27).getTime()
  view.rerender(<InterruptedTasks {...props} tasks={[{ ...task, occurredAt: yesterday }]} />)

  const earlier = screen.getByText("17/10/2026", { selector: "time" })
  expect(earlier).toBeVisible()
  expect(earlier).toHaveAttribute("title", "17/10/2026, 11:28")
})

it("bell dismissal reconciles the center immediately and retains resolved history", async () => {
  const api = createMockApi({ scenario: "interrupted-tasks" })
  const hook = renderHook(() => useRecoveryTasks(api))
  await waitFor(() => expect(hook.result.current.tasks).toHaveLength(3))
  const task = hook.result.current.tasks.find((item) => item.id === "run:run-interrupted")
  if (!task) throw new Error("Expected interrupted turn")

  await act(async () => {
    await api.request("POST /notifications/:id/dismiss", {}, { id: String(task.notification.id) })
  })

  expect(hook.result.current.tasks.find((item) => item.id === task.id)?.notification.resolvedAt).not.toBeNull()
  expect(hook.result.current.tasks.filter((item) => item.notification.resolvedAt === null)).toHaveLength(2)
  expect(dictionaries.en["Interrupção anterior · resolvida"]).toBe("Previous interruption · resolved")
})

it("keeps journal attention pending when a later run or reply has not acknowledged its effects", async () => {
  const api = createMockApi({ scenario: "interrupted-tasks" })
  const { tasks } = await api.request("GET /recovery", {})
  const task = tasks.find((item) => item.id === "journal:process-demo")
  if (!task) throw new Error("Expected uncertain journal work")
  const later = { ...task.notification, id: 999, kind: "done" as const, createdAt: task.notification.createdAt + 1 }

  const pending = pendingNotifications([task.notification, later])

  expect(pending).toEqual([task.notification])
})

it("marks only the resolved run in chat and leaves unrelated messages intact", async () => {
  const api = createMockApi({ scenario: "interrupted-tasks" })
  const { tasks } = await api.request("GET /recovery", {})
  const { messages } = await api.request("GET /threads/:id/messages", {}, { id: "thread-mark" })
  const resolved = tasks.map((task) => ({ ...task, notification: { ...task.notification, resolvedAt: Date.now() } }))

  render(
    <RecoveryTasksContext.Provider value={resolved}>
      <VirtualMessageList messages={messages} onRetry={async () => undefined} onSwitchBranch={async () => undefined} />
    </RecoveryTasksContext.Provider>,
  )

  expect(screen.getAllByText("Interrupção anterior · resolvida")).toHaveLength(1)
  expect(screen.queryByRole("button", { name: "Retomar tarefa" })).not.toBeInTheDocument()
  const disclosure = screen.getByRole("button", { name: "Ver erro", exact: true })
  expect(disclosure).toHaveAttribute("aria-expanded", "false")

  fireEvent.click(disclosure)

  expect(disclosure).toHaveAttribute("aria-expanded", "true")
  expect(screen.getByRole("alert")).toBeVisible()
  expect(dictionaries.en["Ver erro"]).toBe("View error")
})

it("requires a new acknowledgement when the recorded effects change", async () => {
  const api = createMockApi({ scenario: "interrupted-tasks" })
  const { tasks } = await api.request("GET /recovery", {})
  const task = tasks.find((item) => item.id === "journal:process-demo")
  if (!task) throw new Error("Expected uncertain journal work")
  const props = {
    loading: false,
    error: null,
    onClose: vi.fn(),
    onReview: vi.fn(),
    onResume: vi.fn(),
    onDismiss: vi.fn(),
  }
  const view = render(<InterruptedTasks {...props} tasks={[task]} />)
  fireEvent.click(screen.getByRole("checkbox"))
  expect(screen.getByRole("button", { name: "Descartar" })).toBeEnabled()

  const next = {
    ...task,
    effects: [...task.effects, { description: "Outra prévia", uncertain: true, acknowledgeKey: "another-key" }],
  }
  view.rerender(<InterruptedTasks {...props} tasks={[next]} />)

  expect(screen.getByRole("checkbox")).not.toBeChecked()
  expect(screen.getByRole("button", { name: "Descartar" })).toBeDisabled()
})

it("coalesces event bursts and does not render context consumers for an unchanged snapshot", async () => {
  const api = createMockApi({ scenario: "interrupted-tasks" })
  const renderConsumer = vi.fn()
  const Consumer = memo(() => {
    renderConsumer(useContext(RecoveryTasksContext))
    return null
  })
  const Wrapper = () => {
    const { tasks } = useRecoveryTasks(api)
    return (
      <RecoveryTasksContext.Provider value={tasks}>
        <Consumer />
      </RecoveryTasksContext.Provider>
    )
  }
  render(<Wrapper />)
  await waitFor(() => expect(renderConsumer).toHaveBeenLastCalledWith(expect.any(Array)))
  await waitFor(() => expect(renderConsumer.mock.lastCall?.[0]).toHaveLength(3))
  const previous = renderConsumer.mock.lastCall?.[0]
  const calls = renderConsumer.mock.calls.length
  const requestCount = api.calls.filter((call) => call.route === "GET /recovery").length
  const { tasks } = await api.request("GET /recovery", {})
  const notification = tasks[0]?.notification
  if (!notification) throw new Error("Expected recovery notification")
  vi.useFakeTimers()

  act(() => {
    Array.from({ length: 30 }, () => api.emit({ type: "notification.created", notification: { ...notification } }))
  })
  expect(api.calls.filter((call) => call.route === "GET /recovery")).toHaveLength(requestCount + 1)
  await act(async () => vi.advanceTimersByTimeAsync(200))

  expect(api.calls.filter((call) => call.route === "GET /recovery")).toHaveLength(requestCount + 2)
  expect(renderConsumer).toHaveBeenCalledTimes(calls)
  expect(renderConsumer.mock.lastCall?.[0]).toBe(previous)
})
