import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { createMockApi } from "../src/api/mock"
import { NotificationAttentionBar } from "../src/components/NotificationAttentionBar"
import { getReadyReviewFixture } from "./fixtures/ready-review"

afterEach(cleanup)

it("opens the pending approval even when a question arrived first", () => {
  const api = createMockApi()
  const question = api.notify({ kind: "question", botId: "bot-onb", title: "Pergunta", body: "Qual projeto?" })
  const approval = api.notify({ kind: "approval", botId: "bot-mark", title: "Aprovação", body: "Permitir pasta" })
  const notifications = [question, approval]
  const onSelect = vi.fn()

  render(<NotificationAttentionBar notifications={notifications} onSelect={onSelect} />)
  const card = screen.getByRole("button", { name: /^Precisa de você.*mark quer sua aprovação/ })
  fireEvent.click(card)

  expect(onSelect).toHaveBeenCalledWith(approval)
  expect(card).toHaveAccessibleDescription("Abrir pendência de mark")
  expect(card.querySelector("[data-bot-id]")).toHaveAttribute("data-bot-id", "bot-mark")
  expect(screen.getByText("mark quer sua aprovação")).toBeVisible()
  expect(notifications).toEqual([question, approval])
})

it("returns to the waiting question after the approval is resolved", () => {
  const api = createMockApi()
  const question = api.notify({ kind: "question", botId: "bot-onb", title: "Pergunta", body: "Qual projeto?" })
  const approval = api.notify({ kind: "approval", botId: "bot-mark", title: "Aprovação", body: "Permitir pasta" })
  const onSelect = vi.fn()
  const view = render(<NotificationAttentionBar notifications={[question, approval]} onSelect={onSelect} />)

  view.rerender(
    <NotificationAttentionBar
      notifications={[question, Object.assign({}, approval, { resolvedAt: Date.now() })]}
      onSelect={onSelect}
    />,
  )
  fireEvent.click(screen.getByRole("button", { name: /^Precisa de você.*onb precisa da sua resposta/ }))

  expect(onSelect).toHaveBeenCalledWith(question)
  expect(screen.getByText("onb precisa da sua resposta")).toBeVisible()
})

it("identifies a ready review and opens its original notification", async () => {
  const { review } = await getReadyReviewFixture()
  const onSelect = vi.fn()
  render(<NotificationAttentionBar notifications={[review]} onSelect={onSelect} />)

  const card = screen.getByRole("button", { name: /^Precisa de você.*Revisão pronta/ })
  fireEvent.click(card)

  expect(onSelect).toHaveBeenCalledWith(review)
  expect(card).toHaveAccessibleDescription("Abrir pendência de touri")
})
