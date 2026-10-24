import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import type { Run } from "@touri/contracts"
import { afterEach, expect, it } from "vitest"
import { WorkScreen } from "../src/features/work/WorkScreen"
import { createWorkApi } from "./fixtures/work-api"

afterEach(cleanup)

it("links a waiting request to the preceding task in its conversation and removes the link on completion", () => {
  const api = createWorkApi()
  const active = api.getRuns()[0]
  if (!active) throw new Error("Missing active task")
  const unrelated: Run = Object.assign({}, active, { id: "other-conversation", threadId: "other-thread" })
  const waiting: Run = Object.assign({}, active, { id: "waiting", status: "queued", startedAt: null })
  const view = render(
    <WorkScreen
      runs={[unrelated, active, waiting]}
      bots={api.bots}
      threads={api.threads}
      loading={false}
      onThread={() => {}}
    />,
  )

  const queued = screen.getByRole("region", { name: "Na fila", exact: true })
  const link = within(queued).getByRole("button", { name: "Ver tarefa anterior de Planejamento" })
  const target = document.getElementById(link.getAttribute("aria-controls") ?? "")
  fireEvent.click(link)

  expect(target).toHaveAttribute("data-run-id", active.id)
  expect(target).toHaveAttribute("tabindex", "-1")
  expect(target).toHaveFocus()
  view.rerender(
    <WorkScreen
      runs={[unrelated, waiting]}
      bots={api.bots}
      threads={api.threads}
      loading={false}
      onThread={() => {}}
    />,
  )
  expect(screen.queryByRole("button", { name: "Ver tarefa anterior de Planejamento" })).not.toBeInTheDocument()
})

it("finds the execution behind a queued channel request without linking to another bot", () => {
  const api = createWorkApi()
  const template = api.getRuns()[0]
  const otherBot = api.getRuns()[1]
  if (!template || !otherBot) throw new Error("Missing task fixtures")
  const other: Run = Object.assign({}, template, { id: "other-bot", botId: otherBot.botId, groupThreadId: "channel" })
  const active: Run = Object.assign({}, template, { groupThreadId: "channel", groupTurnId: "request" })
  const waiting: Run = Object.assign({}, template, {
    id: "waiting",
    threadId: "channel",
    kind: "coordination",
    status: "queued",
    startedAt: null,
  })
  const view = render(
    <WorkScreen
      runs={[other, active, waiting]}
      bots={api.bots}
      threads={api.threads}
      loading={false}
      onThread={() => {}}
    />,
  )

  const link = screen.getByRole("button", { name: "Ver tarefa anterior de Planejamento" })
  const target = document.getElementById(link.getAttribute("aria-controls") ?? "")

  expect(target).toHaveAttribute("data-run-id", active.id)
  view.rerender(
    <WorkScreen runs={[other, waiting]} bots={api.bots} threads={api.threads} loading={false} onThread={() => {}} />,
  )
  expect(screen.queryByRole("button", { name: /^Ver tarefa anterior de/ })).not.toBeInTheDocument()
})
