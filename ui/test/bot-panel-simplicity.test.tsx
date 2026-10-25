import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { createMockApi } from "../src/api/mock"
import { BotPanel } from "../src/components/BotPanel"

afterEach(cleanup)

it("explains access before opening Adjust without repeating the job", () => {
  const api = createMockApi()
  const original = api.getState().bots[0]
  if (!original) throw new Error("Missing bot fixture")
  const roleLine = "Planejamento fictício"
  const bot = Object.assign({}, original, { roleLine })

  render(
    <BotPanel
      api={api}
      bot={bot}
      routines={[]}
      paused={false}
      expanded={false}
      onExpand={vi.fn()}
      onWindow={vi.fn(async () => {})}
      onClose={vi.fn()}
      onSettings={vi.fn()}
      onRoutines={vi.fn()}
      onPermissions={vi.fn()}
      onRole={vi.fn(async () => {})}
    />,
  )

  expect(screen.getByRole("button", { name: "Ajustar", exact: true })).toHaveAttribute("aria-expanded", "false")
  expect(screen.getByText(/^Pede permissão antes de mudar arquivos;/)).toBeVisible()
  expect(screen.getByDisplayValue(roleLine)).toBeVisible()
  expect(screen.queryByText(roleLine)).toBeNull()
  expect(screen.queryByRole("button", { name: /^Escolher modelo:/ })).toBeNull()
})
