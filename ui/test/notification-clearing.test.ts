import type { NotificationRecord } from "@touri/contracts"
import { expect, it, vi } from "vitest"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { ApiError } from "../src/errors"
import { clearNotifications } from "../src/notificationClearing"

it("clears selected dispensable recoveries and retains acknowledgement-protected work", async () => {
  const api = createMockApi({ scenario: "interrupted-tasks" })
  const { notifications } = await api.request("GET /notifications", {})
  const update = vi.fn()

  const result = await clearNotifications(
    api,
    notifications.map((item) => item.id),
    notifications,
    update,
  )

  const saved = (await api.request("GET /notifications", {})).notifications
  expect(result.skipped).toBe(1)
  expect(result.skippedIds).toEqual([
    notifications.find((item) => item.requestId === "recovery:journal:process-demo")?.id,
  ])
  expect(saved.filter((item) => item.readAt)).toHaveLength(2)
  expect(saved.filter((item) => item.resolution === "dismissed")).toHaveLength(2)
  expect(update).toHaveBeenCalled()
  expect(api.calls.some((call) => call.route === "POST /notifications/dismiss-all")).toBe(false)
})

it("preserves other decisions and never dismisses notifications outside the selected IDs", async () => {
  const api = createMockApi({ scenario: "interrupted-tasks" })
  const approval = api.notify({
    kind: "approval",
    title: "Aprovação fictícia",
    body: "Revisar",
    requestId: "recovery:approval",
  })
  const question = api.notify({
    kind: "question",
    title: "Pergunta fictícia",
    body: "Qual opção?",
    requestId: "recovery:question",
  })
  const review = api.notify({ kind: "notice", title: "Revisão fictícia", body: "Revisar", requestId: "pr-ready:demo" })
  const { notifications } = await api.request("GET /notifications", {})
  const selected = notifications.find((item) => item.requestId === "recovery:routine:routine-demo")
  if (!selected) throw new Error("Missing synthetic recovery notification")
  const ids = [approval.id, question.id, review.id, selected.id]

  const result = await clearNotifications(api, ids, notifications, vi.fn())

  expect(result.skippedIds).toEqual(expect.arrayContaining([approval.id, question.id, review.id]))
  expect(result.skipped).toBe(3)
  const dismissals = api.calls.filter((call) => call.route === "POST /notifications/:id/dismiss")
  expect(dismissals.map((call) => call.pathValues?.id)).toEqual([String(selected.id)])
  const saved = (await api.request("GET /notifications", {})).notifications
  expect(saved.filter((item) => item.resolvedAt !== null).map((item) => item.id)).toEqual([selected.id])
})

it("leaves an unexpected server failure retryable instead of reporting it as protected work", async () => {
  const mock = createMockApi({ scenario: "interrupted-tasks" })
  const { notifications } = await mock.request("GET /notifications", {})
  const attempts = vi.fn().mockRejectedValueOnce(new ApiError(500, "Falha fictícia", "STORE_ERROR"))
  const request: ApiRequest = async (route, input, path) => {
    if (route === "POST /notifications/:id/dismiss") await attempts()
    return mock.request(route, input, path)
  }
  const api = Object.assign({}, mock, { request })
  const ids = notifications.map((item) => item.id)

  await expect(clearNotifications(api, ids, notifications, vi.fn())).rejects.toMatchObject({ status: 500 })
  const retry = await clearNotifications(api, ids, notifications, vi.fn())

  expect(retry.skipped).toBe(1)
})

it("keeps successful partial updates when a later dismissal fails", async () => {
  const mock = createMockApi({ scenario: "interrupted-tasks" })
  const { notifications } = await mock.request("GET /notifications", {})
  const ordered = notifications
  const request: ApiRequest = async (route, input, path) => {
    if (route === "POST /notifications/:id/dismiss" && path?.id === String(ordered[1]?.id))
      throw new ApiError(503, "Falha fictícia", "STORE_ERROR")
    return mock.request(route, input, path)
  }
  const update = vi.fn<(items: NotificationRecord[]) => void>()
  const api = Object.assign({}, mock, { request })

  await expect(
    clearNotifications(
      api,
      ordered.map((item) => item.id),
      ordered,
      update,
    ),
  ).rejects.toMatchObject({
    status: 503,
  })

  expect(update).toHaveBeenCalledWith([expect.objectContaining({ id: ordered[0]?.id, resolution: "dismissed" })])
})
