import { fireEvent, render, screen, within } from "@testing-library/react"
import { expect, test, vi } from "vitest"
import { BotActionsMenu } from "../src/components/BotActionsMenu"

test("bot actions distinguish deletion from navigation while retaining keyboard control", () => {
  const close = vi.fn()
  const remove = vi.fn()
  render(
    <BotActionsMenu
      name="Aurora"
      open
      onOpenChange={close}
      onSettings={vi.fn()}
      onRoutines={vi.fn()}
      onDelete={remove}
    />,
  )
  const menu = screen.getByRole("menu", { name: "Ações de Aurora" })
  const advanced = within(menu).getByRole("menuitem", { name: "Avançado", exact: true })
  const deletion = within(menu).getByRole("menuitem", { name: "Excluir bot", exact: true })
  const separator = within(menu).getByRole("separator")

  expect(separator.previousElementSibling).toHaveTextContent("Rotinas")
  expect(separator.nextElementSibling).toBe(deletion)
  expect(advanced).toHaveFocus()
  expect(within(menu).queryByRole("img")).toBeNull()

  fireEvent.keyDown(menu, { key: "End" })

  expect(deletion).toHaveFocus()
  expect(remove).not.toHaveBeenCalled()

  fireEvent.click(deletion)

  expect(remove).toHaveBeenCalledOnce()
  expect(close).toHaveBeenCalledWith(false)
})

test("read-only action menus do not show a destructive section", () => {
  render(<BotActionsMenu name="Aurora" open onOpenChange={vi.fn()} onSettings={vi.fn()} onRoutines={vi.fn()} />)
  const menu = screen.getByRole("menu", { name: "Ações de Aurora" })

  expect(within(menu).queryByRole("separator")).toBeNull()
  expect(within(menu).getAllByRole("menuitem")).toHaveLength(2)
})
