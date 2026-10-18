import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { createMockApi } from "../src/api/mock"
import { VirtualMessageList } from "../src/components/ChatPanel"
import { InterruptedTasks } from "../src/components/InterruptedTasks"
import { dictionaries } from "../src/i18n"
import { pendingNotifications } from "../src/sidebarAttention"
import { RecoveryTasksContext, useRecoveryTasks } from "../src/useRecoveryTasks"

afterEach(cleanup)

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
  const rows = screen.getAllByTestId("interrupted-task")
  const uncertain = rows.find((row) => within(row).queryByRole("checkbox"))
  if (!uncertain) throw new Error("Expected uncertain journal work")

  fireEvent.click(within(uncertain).getByRole("button", { name: /Ver ações realizadas/ }))

  expect(within(uncertain).getByText("Prévia do projeto")).toBeVisible()
  expect(within(uncertain).getByRole("button", { name: "Descartar" })).toBeDisabled()
  expect(onDismiss).not.toHaveBeenCalled()

  fireEvent.click(within(uncertain).getByRole("checkbox"))
  await act(async () => fireEvent.click(within(uncertain).getByRole("button", { name: "Descartar" })))

  expect(onDismiss).toHaveBeenCalledWith(expect.objectContaining({ id: "journal:process-demo" }), ["process-preview"])
  expect(screen.getAllByRole("region").length).toBeGreaterThanOrEqual(3)
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
