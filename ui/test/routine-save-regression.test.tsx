import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { expect, it, vi } from "vitest"
import { createMockApi } from "../src/api/mock"
import CronScreen from "../src/components/CronScreen"
import type { WorkspaceActions } from "../src/useWorkspace"

it("preserves the routine draft after a rejected save", async () => {
  const state = createMockApi().getState()
  const createRoutine = vi.fn().mockRejectedValue(new Error("save failed"))
  render(
    <CronScreen
      bots={state.bots}
      selectedBotId={state.bots[0]?.id ?? null}
      routines={[]}
      routineRuns={[]}
      messages={[]}
      actions={{ createRoutine } as unknown as WorkspaceActions}
      onNotice={vi.fn()}
      onReviewApprovals={vi.fn()}
    />,
  )
  fireEvent.click(screen.getByRole("button", { name: "Criar rotina" }))
  const dialog = screen.getByRole("dialog")
  fireEvent.change(within(dialog).getByRole("textbox", { name: /^(Tarefa|Prompt)$/ }), {
    target: { value: "Organize minhas notas em uma lista." },
  })
  const review = within(dialog).queryByRole("button", { name: "Revisar rotina" })
  if (review) {
    fireEvent.click(review)
    fireEvent.click(within(dialog).getByRole("button", { name: "Ativar rotina" }))
  } else fireEvent.click(within(dialog).getByRole("button", { name: "Salvar rotina" }))
  await waitFor(() => expect(createRoutine).toHaveBeenCalledOnce())
  // Let the rejected request settle before checking the preserved editor.
  await act(async () => {})
  expect(screen.getByRole("dialog")).toBeVisible()
  expect(within(dialog).getByText("Organize minhas notas em uma lista.")).toBeVisible()
})
