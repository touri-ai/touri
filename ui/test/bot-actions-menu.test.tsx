import { act, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { afterEach, expect, it, vi } from "vitest"
import { BotActionsMenu } from "../src/components/BotActionsMenu"

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const routines = vi.fn()
const settings = vi.fn()
const remove = vi.fn()
const Fixture = () => {
  const [open, setOpen] = useState(false)
  return (
    <div data-testid="scrolling-list" style={{ overflow: "auto", height: 100 }}>
      <BotActionsMenu
        name="Teste"
        open={open}
        onOpenChange={setOpen}
        onSettings={settings}
        onRoutines={routines}
        onDelete={remove}
      />
      <button type="button">Fora do menu</button>
    </div>
  )
}
const trigger = () => screen.getByRole("button", { name: "Ações de Teste" })
const menu = () => screen.getByRole("menu", { name: "Ações de Teste" })

it("escapes the scroll container and keeps every action clickable after focus moves into the portal", async () => {
  const user = userEvent.setup()
  render(<Fixture />)
  await user.click(trigger())
  expect(menu().parentElement).toBe(document.body)
  expect(screen.getByTestId("scrolling-list")).not.toContainElement(menu())
  expect(within(menu()).getByRole("menuitem", { name: "Avançado" })).toHaveFocus()
  await user.keyboard("{ArrowDown}{Enter}")
  expect(routines).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole("menu")).toBeNull()
  expect(trigger()).toHaveFocus()
  await user.click(trigger())
  await user.click(within(menu()).getByRole("menuitem", { name: "Excluir bot" }))
  expect(remove).toHaveBeenCalledTimes(1)
})

it("wraps arrow keys, supports Home/End, returns focus on Escape and dismisses outside the portal", async () => {
  const user = userEvent.setup()
  render(<Fixture />)
  trigger().focus()
  await user.keyboard("{ArrowDown}{End}")
  expect(within(menu()).getByRole("menuitem", { name: "Excluir bot" })).toHaveFocus()
  await user.keyboard("{ArrowDown}")
  expect(within(menu()).getByRole("menuitem", { name: "Avançado" })).toHaveFocus()
  await user.keyboard("{ArrowUp}{Home}{ArrowDown}")
  expect(within(menu()).getByRole("menuitem", { name: "Rotinas" })).toHaveFocus()
  await user.keyboard("{Escape}")
  expect(screen.queryByRole("menu")).toBeNull()
  expect(trigger()).toHaveFocus()
  await user.click(trigger())
  await user.click(screen.getByRole("button", { name: "Fora do menu" }))
  expect(screen.queryByRole("menu")).toBeNull()
  await user.click(trigger())
  act(() => screen.getByRole("button", { name: "Fora do menu" }).focus())
  expect(screen.queryByRole("menu")).toBeNull()
})

it("keeps focus during a pointer press until the chosen action activates", async () => {
  const user = userEvent.setup()
  remove.mockClear()
  render(<Fixture />)
  await user.click(trigger())
  const first = within(menu()).getByRole("menuitem", { name: "Avançado" })
  await user.pointer({ keys: "[MouseLeft>]", target: within(menu()).getByRole("menuitem", { name: "Excluir bot" }) })
  expect(first).toHaveFocus()
  expect(remove).not.toHaveBeenCalled()
  await user.pointer({ keys: "[/MouseLeft]" })
  expect(remove).toHaveBeenCalledOnce()
  expect(trigger()).toHaveFocus()
  await user.click(trigger())
  await user.click(trigger())
  expect(screen.queryByRole("menu")).toBeNull()
  expect(trigger()).toHaveFocus()
  await user.keyboard("{ArrowDown}{Tab}")
  expect(screen.queryByRole("menu")).toBeNull()
  expect(screen.getByRole("button", { name: "Fora do menu" })).toHaveFocus()
})

it("portals into an open native dialog so the mobile drawer does not make its menu inert", async () => {
  const user = userEvent.setup()
  render(
    <dialog open>
      <Fixture />
    </dialog>,
  )
  await user.click(trigger())
  expect(menu().parentElement).toBe(screen.getByRole("dialog"))
  expect(screen.getByTestId("scrolling-list")).not.toContainElement(menu())
  await user.keyboard("{Escape}")
  expect(trigger()).toHaveFocus()
})

it("flips at the bottom, shifts at either horizontal edge, and repositions on scroll and resize", () => {
  vi.stubGlobal("innerWidth", 900)
  vi.stubGlobal("innerHeight", 600)
  let anchor = { left: 850, right: 890, top: 560, bottom: 590, width: 40, height: 30 }
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
    return (this.matches(".bot-settings") ? anchor : { left: 0, top: 0, width: 168, height: 140 }) as DOMRect
  })
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(168)
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(140)
  render(<Fixture />)
  fireEvent.click(trigger())
  expect(menu()).toHaveStyle({ position: "fixed", left: "722px", top: "416px" })
  anchor = { left: 0, right: 40, top: 80, bottom: 110, width: 40, height: 30 }
  fireEvent.scroll(screen.getByTestId("scrolling-list"))
  expect(menu()).toHaveStyle({ left: "8px", top: "114px" })
  anchor = { left: 880, right: 920, top: 80, bottom: 110, width: 40, height: 30 }
  fireEvent(window, new Event("resize"))
  expect(menu()).toHaveStyle({ left: "724px", top: "114px" })
})
