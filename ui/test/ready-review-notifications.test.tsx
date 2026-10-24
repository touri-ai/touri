import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { BotGroup, NotificationRecord, Thread } from "@touri/contracts"
import { afterEach, describe, expect, it, vi } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import { type NotificationActions, NotificationBell } from "../src/components/NotificationCenter"
import * as i18n from "../src/i18n"
import { countAttention, pendingNotifications } from "../src/sidebarAttention"
import { getReadyReviewFixture } from "./fixtures/ready-review"

const getTranslation = i18n.t
const now = Date.UTC(2026, 9, 20, 12)

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const getReview = (overrides: Partial<NotificationRecord> = {}): NotificationRecord => ({
  id: 797,
  kind: "notice",
  level: "info",
  botId: null,
  botName: null,
  botColor: "#3b93f0",
  avatarShape: "classic-none",
  threadId: "review-conversation",
  requestId: `pr-ready:${"a".repeat(64)}`,
  title: "PR ready",
  body: "A alteração fictícia está disponível para conferir.",
  createdAt: now,
  resolvedAt: null,
  resolution: null,
  ...overrides,
})

const getOrigin = (): { threads: Thread[]; groups: BotGroup[] } => {
  const base = createMockApi().getState().threads[0]
  if (!base) throw new Error("Missing synthetic conversation")

  return {
    threads: [{ ...base, id: "review-conversation", title: "Revisão da alteração fictícia", groupId: "announcements" }],
    groups: [
      {
        id: "announcements",
        name: "avisos",
        color: "#3b93f0",
        avatarShape: "classic-none",
        avatarSeed: "announcements",
        memberIds: [base.botId],
        coordinatorBotId: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
  }
}

const getActions = (): NotificationActions => ({
  open: vi.fn(),
  dismiss: vi.fn().mockResolvedValue(undefined),
  dismissAll: vi.fn(),
  respond: vi.fn(),
  reply: vi.fn(),
})

describe.each([
  { locale: "pt-BR" as const, ready: "Revisão pronta", open: "Abrir e revisar", origin: "Conversa de origem" },
  { locale: "en" as const, ready: "Review ready", open: "Open and review", origin: "Originating conversation" },
])("ready reviews in $locale", ({ locale, ready, open, origin }) => {
  it("shows the originating channel conversation and opens it without deciding or dismissing the review", () => {
    vi.spyOn(i18n, "t").mockImplementation((key, params) => getTranslation(key, params, locale))
    const review = getReview()
    const actions = getActions()
    render(<NotificationBell notifications={[review]} actions={actions} now={now} {...getOrigin()} />)

    fireEvent.click(
      screen.getByRole("button", { name: getTranslation("Notifications need attention", { count: 1 }, locale) }),
    )
    const row = screen.getByTestId("notification-row")

    expect(row).toHaveAttribute("data-unread", "true")
    expect(row.querySelector(".ds-badge")).toHaveTextContent(ready)
    expect(within(row).getByText(`${origin}: #avisos · Revisão da alteração fictícia`)).toBeVisible()
    expect(within(row).queryByRole("textbox")).toBeNull()
    expect(within(row).getByRole("button", { name: open })).toHaveClass("ds-button-primary")

    fireEvent.click(within(row).getByRole("button", { name: open }))

    expect(actions.open).toHaveBeenCalledOnce()
    expect(actions.open).toHaveBeenCalledWith(review)
    expect(actions.respond).not.toHaveBeenCalled()
    expect(actions.reply).not.toHaveBeenCalled()
    expect(actions.dismiss).not.toHaveBeenCalled()
  })
})

it("keeps an older unresolved review actionable beyond the recent informational limit", () => {
  const review = getReview({ createdAt: now - 60_000 })
  const notices = Array.from({ length: 24 }, (_, index) =>
    getReview({
      id: index + 1,
      requestId: `notice:${index}`,
      title: "Aviso automático",
      createdAt: now + index,
    }),
  )
  const notifications = [review, ...notices]
  render(<NotificationBell notifications={notifications} actions={getActions()} now={now} {...getOrigin()} />)

  fireEvent.click(screen.getByRole("button", { name: /Notificações/ }))

  expect(pendingNotifications(notifications)).toEqual([review])
  expect(countAttention(notifications)).toBe(1)
  expect(screen.getByText("Revisão pronta")).toBeVisible()
  expect(screen.getAllByTestId("notification-row")).toHaveLength(17)
})

it("uses the persisted notice marker rather than review-looking text or a channel name", () => {
  const notifications = [
    getReview({ requestId: null, body: "READY revisão pronta para review" }),
    getReview({ id: 798, requestId: "notice:demo", title: "PR ready" }),
    getReview({ id: 799, kind: "done" }),
    getReview({ id: 800, threadId: null }),
  ]

  expect(pendingNotifications(notifications)).toEqual([])
  expect(countAttention(notifications)).toBe(0)
})

it("retains the resolved review, its origin and its conversation action in history", async () => {
  const review = getReview()
  const actions = getActions()
  const origin = getOrigin()
  const view = render(<NotificationBell notifications={[review]} actions={actions} now={now} {...origin} />)
  fireEvent.click(screen.getByRole("button", { name: /Notificações/ }))

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Dispensar" }))
  })
  const resolved = getReview({ resolvedAt: now + 1, resolution: "dismissed" })
  view.rerender(<NotificationBell notifications={[resolved]} actions={actions} now={now} {...origin} />)
  const row = screen.getByTestId("notification-row")

  expect(actions.dismiss).toHaveBeenCalledWith(review.id)
  expect(countAttention([resolved])).toBe(0)
  expect(row).toHaveClass("resolved")
  expect(row).toHaveAttribute("data-unread", "false")
  expect(within(row).getByText("Resolvido")).toBeVisible()
  expect(within(row).getByText("Conversa de origem: #avisos · Revisão da alteração fictícia")).toBeVisible()
  expect(within(row).queryByRole("button", { name: "Dispensar" })).toBeNull()

  fireEvent.click(within(row).getByRole("button", { name: "Ver conversa" }))

  expect(actions.open).toHaveBeenCalledWith(resolved)
})

it("does not infer an origin from unrelated visible conversations", () => {
  const review = getReview({ threadId: "unavailable-conversation" })
  render(<NotificationBell notifications={[review]} actions={getActions()} now={now} {...getOrigin()} />)

  fireEvent.click(screen.getByRole("button", { name: /Notificações/ }))

  expect(screen.queryByText(/Conversa de origem:/)).toBeNull()
  expect(screen.getByRole("button", { name: "Abrir e revisar" })).toBeVisible()
})

it("opens a channel without bots and restores resolved reviews after remounting the workspace", async () => {
  const { api, mock, review, thread } = await getReadyReviewFixture()
  const view = render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  fireEvent.click(await screen.findByRole("button", { name: "Notificações, 1 precisa de atenção" }))
  const center = screen.getByRole("region", { name: "Central de notificações" })
  const pending = within(center).getByText(review.body).closest("li")
  if (!pending) throw new Error("Missing ready review row")

  expect(within(pending).getByText("Conversa de origem: #avisos · Revisão da alteração fictícia")).toBeVisible()
  fireEvent.click(within(pending).getByRole("button", { name: "Abrir e revisar" }))
  await screen.findByRole("textbox", { name: "Mensagem para avisos" })
  expect(new URLSearchParams(window.location.search).get("thread")).toBe(thread.id)
  expect(await within(screen.getByTestId("virtual-message-list")).findByText(review.body)).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "Notificações, 1 precisa de atenção" }))
  fireEvent.click(
    within(screen.getByRole("region", { name: "Central de notificações" })).getByRole("button", {
      name: "Dispensar",
    }),
  )

  await waitFor(() => expect(screen.getByRole("button", { name: "Notificações", exact: true })).toBeVisible())
  expect(mock.calls.filter((call) => call.route === "POST /notifications/:id/dismiss")).toMatchObject([
    { pathValues: { id: String(review.id) } },
  ])
  expect(mock.calls.some((call) => call.route === "POST /threads/:id/respond")).toBe(false)
  expect(mock.calls.some((call) => call.route === "POST /bots/:id/messages")).toBe(false)

  view.unmount()
  render(<App kernel={{ services: { api } }} />)
  fireEvent.click(await screen.findByRole("button", { name: "Notificações", exact: true }))
  const history = screen.getByRole("region", { name: "Central de notificações" })

  expect(within(history).getByText(review.body)).toBeVisible()
  expect(history.querySelectorAll(".notification-row.resolved")).toHaveLength(2)
  expect(within(history).getAllByRole("button", { name: "Ver conversa" })).toHaveLength(2)
})

it("opens the exact review conversation directly from the sidebar attention action", async () => {
  const { api, mock, review, thread } = await getReadyReviewFixture()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })

  fireEvent.click(await screen.findByRole("button", { name: "Abrir pendência de touri" }))

  await screen.findByRole("textbox", { name: "Mensagem para avisos" })
  expect(new URLSearchParams(window.location.search).get("thread")).toBe(thread.id)
  expect(await within(screen.getByTestId("virtual-message-list")).findByText(review.body)).toBeVisible()
  expect(screen.queryByRole("region", { name: "Central de notificações" })).toBeNull()
  expect(mock.calls.some((call) => call.route === "POST /notifications/:id/dismiss")).toBe(false)
  expect(mock.calls.some((call) => call.route === "POST /threads/:id/respond")).toBe(false)
})
