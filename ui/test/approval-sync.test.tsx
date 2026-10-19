import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import type { Message, NotificationRecord } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { pendingApprovalTargets } from "../src/approvalNavigation"
import { reconcileApprovalMessages, reconcileApprovalNotifications } from "../src/approvalState"
import { ApprovalNotice } from "../src/components/ApprovalNotice"
import { NotificationBell } from "../src/components/NotificationCenter"
import { useWorkspace } from "../src/useWorkspace"

const note: NotificationRecord = {
  id: 901,
  kind: "approval",
  level: "warning",
  botId: "bot-mark",
  botName: "Café Ideias",
  botColor: "#a33",
  avatarShape: "classic-none",
  threadId: "thread-mark",
  requestId: "review-901",
  title: "Ação personalizada",
  body: "Executar comando no terminal",
  createdAt: 1,
  resolvedAt: null,
  resolution: null,
}
const message = (approved = false): Message => ({
  id: "review-message",
  threadId: "thread-mark",
  parentId: null,
  role: "assistant",
  kind: "tool",
  status: "streaming",
  runId: null,
  text: "",
  parts: [
    {
      type: "approval",
      approvalId: "review-901",
      request: "command",
      detail: "pwd",
      decision: approved ? "approved" : "pending",
    },
  ],
  sender: null,
  source: "local",
  createdAt: 1,
  updatedAt: approved ? 2 : 1,
})
const allowed = { ...note, resolvedAt: 2, resolution: "allow" as const }
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it.each(["chat", "bell", "other-tab"])(
  "clears every surface within 500 ms of %s resolution and confirms for exactly four seconds",
  (source) => {
    vi.useFakeTimers()
    const actions = { open: vi.fn(), dismiss: vi.fn(), dismissAll: vi.fn(), respond: vi.fn(), reply: vi.fn() }
    const Surface = ({ resolved }: { resolved: boolean }) => {
      const notifications = resolved && source !== "chat" ? [allowed] : [note]
      const messages = [message(resolved && source === "chat")]
      return (
        <>
          <ApprovalNotice notifications={notifications} messages={messages} onReview={vi.fn()} />
          <NotificationBell notifications={notifications} messages={messages} actions={actions} />
        </>
      )
    }
    const view = render(<Surface resolved={false} />)
    expect(screen.getByRole("button", { name: "Notificações, 1 precisa de atenção" })).toBeInTheDocument()
    view.rerender(<Surface resolved />)
    expect(screen.queryByRole("button", { name: "Notificações, 1 precisa de atenção" })).toBeNull()
    expect(screen.getByRole("status")).toHaveTextContent("Autorizado. Retomando a tarefa.")
    expect(screen.queryByRole("button", { name: "Revisar", exact: true })).toBeNull()
    act(() => vi.advanceTimersByTime(3999))
    expect(screen.getByRole("status")).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.queryByRole("status")).toBeNull()
  },
)

it("shares a duplicate request's decision without treating dismissal as approval", () => {
  const duplicate = { ...note, id: 902 }
  const reconciled = reconcileApprovalNotifications([duplicate, allowed], [])
  expect(reconciled.every((item) => item.resolution === "allow")).toBe(true)
  expect(reconcileApprovalMessages([message()], [duplicate, allowed])[0]?.parts[0]).toMatchObject({
    decision: "approved",
  })
  expect(
    reconcileApprovalMessages([message()], [{ ...note, resolution: "dismissed", resolvedAt: 2 }])[0]?.parts[0],
  ).toMatchObject({ decision: "pending" })
  const onReview = vi.fn()
  render(<ApprovalNotice notifications={[note, duplicate]} messages={[message()]} onReview={onReview} />)
  fireEvent.click(screen.getByRole("button", { name: "Dispensar aviso" }))
  expect(screen.queryByRole("status")).toBeNull()
  expect(onReview).not.toHaveBeenCalled()
})

it("does not project another thread's request or decision onto an approval", () => {
  const other = { ...message(true), threadId: "other-thread" }
  expect(reconcileApprovalNotifications([note], [other])[0]?.resolution).toBeNull()
  expect(reconcileApprovalMessages([message()], [{ ...allowed, threadId: "other-thread" }])[0]?.parts[0]).toMatchObject(
    { decision: "pending" },
  )
})

it("does not turn identified or old prefixed approval echoes into a red notice, including after reload", async () => {
  const api = createMockApi()
  api.notify(note)
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))
  act(() => {
    api.emit({
      type: "notify",
      level: "warning",
      title: "Ação personalizada",
      body: note.body,
      threadId: note.threadId,
      requestId: note.requestId,
      kind: "approval",
    })
    api.emit({
      type: "notify",
      level: "warning",
      title: "Café Ideias: Ação personalizada",
      body: note.body,
      threadId: note.threadId,
    })
  })
  expect(hook.result.current.data.notice).toBeNull()
  await act(async () => {
    await api.request(
      "POST /threads/:id/respond",
      { requestId: note.requestId ?? "", behavior: "allow" },
      { id: note.threadId ?? "" },
    )
  })
  expect(hook.result.current.data.notifications.find((item) => item.requestId === note.requestId)?.resolution).toBe(
    "allow",
  )
  hook.unmount()
  const reload = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(reload.result.current.data.loading).toBe(false))
  expect(reload.result.current.data.notice).toBeNull()
  expect(reload.result.current.data.notifications.find((item) => item.requestId === note.requestId)?.resolution).toBe(
    "allow",
  )
})

it("refreshes decisions and a unique pending count after two minutes hidden, even with a socket still open", async () => {
  const api = createMockApi()
  api.getState().messages.push(message())
  let resumed = false
  const request: ApiRequest = async (route, input, path) => {
    if (route === "GET /notifications")
      return { notifications: resumed ? [allowed, { ...note, id: 902, requestId: "still-pending" }] : [note] } as never
    if (route === "GET /workspace/activity") return { messages: [message(resumed)], runs: [] } as never
    if (route === "GET /threads/:id/messages" && resumed) return { messages: [message(true)] } as never
    return api.request(route, input, path)
  }
  const client = { ...api, request }
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))
  await waitFor(() => expect(hook.result.current.data.messages.length).toBeGreaterThan(0))
  const callsBefore = api.calls.filter((call) => !call.route.startsWith("GET")).length
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
  act(() => document.dispatchEvent(new Event("visibilitychange")))
  vi.useFakeTimers()
  act(() => vi.advanceTimersByTime(120_000))
  vi.useRealTimers()
  resumed = true
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"))
    window.dispatchEvent(new Event("online"))
  })
  await waitFor(() => expect(hook.result.current.data.pendingRequestsOnReturn).toBe(1))
  await waitFor(() =>
    expect(hook.result.current.data.messages.find((item) => item.id === "review-message")?.parts[0]).toMatchObject({
      decision: "approved",
    }),
  )
  expect(api.calls.filter((call) => !call.route.startsWith("GET"))).toHaveLength(callsBefore)
  act(() =>
    api.emit({ type: "notification.resolved", notification: { ...allowed, id: 902, requestId: "still-pending" } }),
  )
  expect(hook.result.current.data.pendingRequestsOnReturn).toBe(0)
})

it("a canceled request expires the chat card and no longer counts as pending", () => {
  const canceled = { ...note, resolution: "canceled" as const, resolvedAt: 2 }
  expect(reconcileApprovalMessages([message()], [canceled])[0]?.parts[0]).toMatchObject({ decision: "expired" })
})

it("counts one pending target across duplicate message parts and reminders", () => {
  expect(pendingApprovalTargets([message(), { ...message(), id: "duplicate" }])).toHaveLength(1)
  render(
    <NotificationBell
      notifications={[note, { ...note, id: 902 }]}
      messages={[message()]}
      actions={{ open: vi.fn(), dismiss: vi.fn(), dismissAll: vi.fn(), respond: vi.fn(), reply: vi.fn() }}
    />,
  )
  expect(screen.getByRole("button", { name: "Notificações, 1 precisa de atenção" })).toBeInTheDocument()
})

it("fills the action in the approval reminder", () => {
  render(<ApprovalNotice notifications={[note]} messages={[message()]} onReview={vi.fn()} />)
  expect(screen.getByRole("status")).toHaveTextContent("Café Ideias pede sua aprovação: Executar comando no terminal")
  expect(screen.getByRole("status")).not.toHaveTextContent(/[{}]/)
})

it("keeps the legacy computer grant review card without a persistent generic notice", async () => {
  const api = createMockApi()
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))
  act(() =>
    api.emit({
      type: "notify",
      level: "warning",
      title: "Computer use approval",
      body: "Review access",
      threadId: "thread-mark",
      notificationId: 903,
    }),
  )
  expect(hook.result.current.data.notice).toBeNull()
  expect(hook.result.current.data.computerGrantRequest).toEqual({ threadId: "thread-mark" })
})

it("does not resurrect a decision received while a resume snapshot is in flight", async () => {
  const api = createMockApi()
  let recovering = false
  let release: (() => void) | undefined
  const snapshot = new Promise<void>((resolve) => {
    release = resolve
  })
  const request: ApiRequest = async (route, input, path) => {
    if (route === "GET /notifications") {
      if (recovering) await snapshot
      return { notifications: [note] } as never
    }
    return api.request(route, input, path)
  }
  const client = { ...api, request }
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))
  recovering = true
  act(() => window.dispatchEvent(new Event("online")))
  act(() => api.emit({ type: "notification.resolved", notification: allowed }))
  await act(async () => {
    release?.()
    await snapshot
  })
  await waitFor(() => expect(hook.result.current.data.pendingRequestsOnReturn).toBe(0))
  expect(hook.result.current.data.notifications.find((item) => item.requestId === note.requestId)?.resolution).toBe(
    "allow",
  )
})

it("keeps newly fetched requests when returning with a full local notification history", async () => {
  const api = createMockApi()
  const older = Array.from({ length: 200 }, (_, index) => ({
    ...allowed,
    id: index + 1,
    requestId: `old-${index}`,
  })).reverse()
  const newer = Array.from({ length: 200 }, (_, index) => ({
    ...note,
    id: index + 201,
    requestId: `new-${index}`,
  })).reverse()
  let resumed = false
  const request: ApiRequest = async (route, input, path) => {
    if (route === "GET /notifications") return { notifications: resumed ? newer : older } as never
    return api.request(route, input, path)
  }
  const client = { ...api, request }
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(hook.result.current.data.notifications).toHaveLength(200))
  resumed = true
  act(() => window.dispatchEvent(new Event("online")))
  await waitFor(() => expect(hook.result.current.data.pendingRequestsOnReturn).toBe(200))
  expect(hook.result.current.data.notifications.some((item) => item.id === 400)).toBe(true)
  expect(hook.result.current.data.notifications.some((item) => item.id === 1)).toBe(false)
})
