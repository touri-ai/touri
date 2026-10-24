import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { ApiRequest, UiApi } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { NotificationBell } from "../src/components/NotificationCenter"
import { useWorkspace } from "../src/useWorkspace"

afterEach(cleanup)

const getNotice = (api: ReturnType<typeof createMockApi>) =>
  api.notify({ kind: "done", title: "Resumo fictício", body: "Pronto para conferir", createdAt: 100 })

const ConnectedBell = ({ api }: { api: UiApi }) => {
  const { data, actions } = useWorkspace(api)

  return (
    <NotificationBell
      notifications={data.notifications}
      messages={data.messages}
      actions={{
        open: () => undefined,
        dismiss: actions.dismissNotification,
        dismissAll: actions.dismissAllNotifications,
        respond: actions.respondNotification,
        reply: actions.replyToNotification,
      }}
    />
  )
}

it("reflects a read on another connected workspace and restores it after reload without browser storage", async () => {
  const api = createMockApi()
  const notice = getNotice(api)
  const desktop = renderHook(() => useWorkspace(api))
  const mobile = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(desktop.result.current.data.loaded && mobile.result.current.data.loaded).toBe(true))
  const unread = mobile.result.current.data.threads.map((thread) => thread.unread)

  await act(async () => {
    await desktop.result.current.actions.dismissAllNotifications([notice.id])
  })

  expect(mobile.result.current.data.notifications[0]?.readAt).toEqual(expect.any(Number))
  expect(mobile.result.current.data.notifications[0]?.resolvedAt).toBeNull()
  expect(mobile.result.current.data.threads.map((thread) => thread.unread)).toEqual(unread)
  desktop.unmount()
  mobile.unmount()
  localStorage.clear()
  const reloaded = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(reloaded.result.current.data.loaded).toBe(true))
  expect(reloaded.result.current.data.notifications[0]?.readAt).toEqual(expect.any(Number))
  expect(api.calls.some((call) => call.route === "POST /notifications/dismiss-all")).toBe(false)
})

it("keeps reads when a later resolution or stale snapshot omits the receipt", async () => {
  const api = createMockApi()
  const notice = getNotice(api)
  const workspace = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(workspace.result.current.data.loaded).toBe(true))
  await act(async () => {
    await workspace.result.current.actions.dismissAllNotifications([notice.id])
  })
  const readAt = workspace.result.current.data.notifications[0]?.readAt

  act(() =>
    api.emit({
      type: "notification.resolved",
      notification: Object.assign({}, notice, { resolvedAt: 200, resolution: "expired" as const }),
    }),
  )
  await act(async () => {
    await workspace.result.current.actions.refresh()
  })

  expect(workspace.result.current.data.notifications[0]).toMatchObject({
    readAt,
    resolvedAt: 200,
    resolution: "expired",
  })
})

it("ignores another person's receipt even if a transport forwards it", async () => {
  const api = createMockApi()
  const notice = getNotice(api)
  const workspace = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(workspace.result.current.data.loaded).toBe(true))

  act(() =>
    api.emit({
      type: "notifications.read",
      personId: "another-person",
      receipts: [{ notificationId: notice.id, readAt: 200 }],
    }),
  )

  expect(workspace.result.current.data.notifications[0]?.readAt ?? null).toBeNull()
})

it("retains a cross-device read that arrives before the initial notification snapshot", async () => {
  const mock = createMockApi()
  const notice = getNotice(mock)
  const pending = new Set<() => void>()
  const request: ApiRequest = async (route, input, path) => {
    if (route !== "GET /notifications") return mock.request(route, input, path)

    await new Promise<void>((resolve) => pending.add(resolve))
    return { notifications: [notice] } as never
  }
  const api = Object.assign({}, mock, { request })
  const workspace = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(pending.size).toBe(1))

  await act(async () => {
    mock.emit({ type: "notifications.read", personId: "owner", receipts: [{ notificationId: notice.id, readAt: 200 }] })
    pending.forEach((resolve) => {
      resolve()
    })
  })

  await waitFor(() => expect(workspace.result.current.data.loaded).toBe(true))
  expect(workspace.result.current.data.notifications[0]?.readAt).toBe(200)
})

it("ignores legacy local clear records and keeps a failed clear retryable", async () => {
  const mock = createMockApi()
  const notice = getNotice(mock)
  localStorage.setItem("touri.notifications.cleared.v1", JSON.stringify([`${notice.id}:${notice.createdAt}`]))
  const attempts = vi.fn().mockRejectedValueOnce(new Error("Synthetic storage failure")).mockResolvedValue(undefined)
  const request: ApiRequest = async (route, input, path) => {
    if (route === "POST /notifications/read") await attempts()
    return mock.request(route, input, path)
  }
  const api = Object.assign({}, mock, { request })
  render(<ConnectedBell api={api} />)
  fireEvent.click(await screen.findByRole("button", { name: "Notificações", exact: true }))
  await screen.findByText(notice.title)

  fireEvent.click(screen.getByRole("button", { name: "Limpar", exact: true }))

  expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível limpar as notificações")
  expect(screen.getByText(notice.title)).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "Limpar", exact: true }))
  await waitFor(() => expect(screen.queryAllByTestId("notification-row")).toHaveLength(0))
  expect(attempts).toHaveBeenCalledTimes(2)
})

it("marks one informational notice read without resolving it and leaves pending actions visible", async () => {
  const api = createMockApi()
  const notice = getNotice(api)
  const pending = api.notify({
    kind: "approval",
    title: "Revisão fictícia",
    body: "Aprovação pendente",
    requestId: "pending-approval",
  })
  render(<ConnectedBell api={api} />)
  fireEvent.click(await screen.findByRole("button", { name: "Notificações, 1 precisa de atenção" }))
  await screen.findByText(notice.title)

  fireEvent.click(screen.getByRole("button", { name: "Marcar como lida" }))

  await waitFor(() => expect(screen.queryByText(notice.title)).toBeNull())
  expect(screen.getByRole("button", { name: "Abrir e revisar" })).toBeVisible()
  const result = await api.request("GET /notifications", {})
  expect(result.notifications.find((item) => item.id === notice.id)).toMatchObject({
    resolvedAt: null,
    readAt: expect.any(Number),
  })
  expect(result.notifications.find((item) => item.id === pending.id)).toMatchObject({ resolvedAt: null })
})
