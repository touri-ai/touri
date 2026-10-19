import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { NotificationRecord } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import { NotificationBell } from "../src/components/NotificationCenter"
import { scopedStorageKey, setStorageScope } from "../src/storageScope"

const key = "touri.notifications.cleared.v1"
const notification: NotificationRecord = {
  id: 7,
  kind: "question",
  level: "info",
  botId: "bot-same",
  botName: "Clara",
  botColor: "#ee3344",
  avatarShape: "classic-none",
  threadId: "thread-same",
  title: "Uma pergunta",
  body: "Posso continuar?",
  requestId: "request-same",
  createdAt: 100,
  resolvedAt: null,
  resolution: null,
}

const actions = (dismissAll = vi.fn(async () => undefined)) => ({
  open: vi.fn(),
  dismiss: vi.fn(async () => undefined),
  dismissAll,
  respond: vi.fn(async () => undefined),
  reply: vi.fn(async () => undefined),
})

afterEach(() => {
  cleanup()
  setStorageScope(null)
})

it("keeps local dismissals from hiding matching notifications on a copied server database", async () => {
  render(<NotificationBell notifications={[notification]} actions={actions()} />)
  fireEvent.click(screen.getByRole("button", { name: "Notificações, 1 precisa de atenção" }))
  fireEvent.click(screen.getByRole("button", { name: "Limpar" }))
  await waitFor(() => expect(localStorage.getItem(key)).toBe('["7:100"]'))
  cleanup()
  setStorageScope("https://server.example")
  render(<NotificationBell notifications={[notification]} actions={actions()} />)
  expect(screen.getByRole("button", { name: "Notificações, 1 precisa de atenção" })).toBeVisible()
  expect(localStorage.getItem(scopedStorageKey(key))).toBeNull()
  cleanup()
  setStorageScope(null)
  render(<NotificationBell notifications={[notification]} actions={actions()} />)
  expect(screen.getByRole("button", { name: "Notificações" })).toBeVisible()
})

it("keeps a delayed dismissal response on the server where the action began", async () => {
  setStorageScope("https://first.example")
  const firstKey = scopedStorageKey(key)
  let resolve: (() => void) | undefined
  const dismiss = vi.fn(
    () =>
      new Promise<void>((done) => {
        resolve = done
      }),
  )
  render(<NotificationBell notifications={[notification]} actions={actions(dismiss)} />)
  fireEvent.click(screen.getByRole("button", { name: "Notificações, 1 precisa de atenção" }))
  fireEvent.click(screen.getByRole("button", { name: "Limpar" }))
  cleanup()
  setStorageScope("https://second.example")
  const secondKey = scopedStorageKey(key)
  resolve?.()
  await waitFor(() => expect(localStorage.getItem(firstKey)).toBe('["7:100"]'))
  expect(localStorage.getItem(secondKey)).toBeNull()
})
