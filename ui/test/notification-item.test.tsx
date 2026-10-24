import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import type { NotificationRecord } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import { type NotificationActions, NotificationBell } from "../src/components/NotificationCenter"

afterEach(cleanup)

const getNotification = (overrides: Partial<NotificationRecord> = {}): NotificationRecord => ({
  id: 1,
  kind: "approval",
  level: "warning",
  botId: "bot-a",
  botName: "Ateliê",
  botColor: "#3b93f0",
  avatarShape: "classic-none",
  threadId: "thread-a",
  requestId: "request-a",
  title: "Criar time",
  body: "Revise cada bot antes de criar o time.",
  createdAt: Date.now(),
  resolvedAt: null,
  resolution: null,
  ...overrides,
})

const getActions = (): NotificationActions => ({
  open: vi.fn(),
  dismiss: vi.fn().mockResolvedValue(undefined),
  dismissAll: vi.fn(),
  respond: vi.fn(),
  reply: vi.fn(),
})

const renderCenter = (notifications: NotificationRecord[], actions = getActions()) => {
  render(<NotificationBell notifications={notifications} actions={actions} />)
  fireEvent.click(screen.getByRole("button", { name: /Notificações/ }))

  return { actions, row: screen.getAllByTestId("notification-row")[0] as HTMLElement }
}

it("renders bot, state badge, time, title and body for an item", () => {
  const { row } = renderCenter([getNotification({ kind: "notice", requestId: null })])

  expect(within(row).getByText("Ateliê").tagName).toBe("STRONG")
  expect(row.querySelector(".ds-badge")).toHaveTextContent("Aviso do bot")
  expect(row.querySelector("time")).toHaveTextContent("agora")
  expect(row.querySelector(".notification-title")).toHaveTextContent("Criar time")
  expect(row.querySelector(".notification-body")).toHaveTextContent("Revise cada bot antes de criar o time.")
})

it("offers one primary action on an approval and opens the full card instead of approving", () => {
  const { actions, row } = renderCenter([getNotification()])
  const primary = within(row).getByRole("button", { name: "Abrir e revisar" })

  expect(row.querySelectorAll(".ds-button-primary")).toHaveLength(1)
  expect(within(row).queryByRole("button", { name: "Aprovar" })).toBeNull()
  expect(within(row).queryByRole("button", { name: "Negar" })).toBeNull()

  fireEvent.click(primary)

  expect(actions.open).toHaveBeenCalledOnce()
  expect(actions.respond).not.toHaveBeenCalled()
})

it("labels an explicit action dismissal separately from reading information", () => {
  const { actions, row } = renderCenter([getNotification()])
  const quiet = within(row).getByRole("button", { name: "Dispensar" })

  expect(quiet).toHaveClass("ds-button-quiet")

  fireEvent.click(quiet)

  expect(actions.dismiss).toHaveBeenCalledWith(1)
})

it("uses a secondary action and a state-colored badge for a finished item", () => {
  const { row } = renderCenter([getNotification({ id: 2, kind: "done", title: "Relatório pronto", requestId: null })])

  expect(row.querySelector(".ds-badge")).toHaveClass("ds-badge-success")
  expect(within(row).getByRole("button", { name: "Ver conversa" })).toHaveClass("ds-button-secondary")
  expect(row.querySelectorAll(".ds-button-primary")).toHaveLength(0)
})

it("tints unread items and shows the notification center header", () => {
  const { row } = renderCenter([getNotification()])

  expect(row).toHaveAttribute("data-unread", "true")
  expect(
    screen.getByRole("region", { name: "Central de notificações" }).querySelector("header strong"),
  ).toHaveTextContent("Notificações")
})

it("does not tint a resolved item", () => {
  const { row } = renderCenter([getNotification({ resolvedAt: Date.now(), resolution: "allow" })])

  expect(row).toHaveAttribute("data-unread", "false")
})
