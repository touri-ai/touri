import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { createMockApi } from "../src/api/mock"
import CronScreen from "../src/components/CronScreen"
import { useWorkspace } from "../src/useWorkspace"

afterEach(cleanup)

it.each(["trigger", "item"] as const)("keeps an active menu's %s focused when routines finish loading", (target) => {
  const api = createMockApi()
  const DeferredRoutines = ({ visible }: { visible: boolean }) => {
    const { actions } = useWorkspace(api)

    return (
      <>
        <button type="button" aria-label="Ações do bot" aria-haspopup="menu" aria-expanded="true">
          ···
        </button>
        <div role="menu" aria-label="Ações do bot">
          <button type="button" role="menuitem">
            Avançado
          </button>
        </div>
        {visible && (
          <CronScreen
            selectedBotId={null}
            bots={[]}
            routines={[]}
            routineRuns={[]}
            messages={[]}
            actions={actions}
            onReviewApprovals={vi.fn()}
            onNotice={vi.fn()}
          />
        )}
      </>
    )
  }
  const view = render(<DeferredRoutines visible={false} />)
  const control = screen.getByRole(target === "trigger" ? "button" : "menuitem")
  control.focus()

  view.rerender(<DeferredRoutines visible />)

  expect(screen.getByRole("region", { name: "Rotinas", exact: true })).toBeVisible()
  expect(control).toHaveFocus()
})
