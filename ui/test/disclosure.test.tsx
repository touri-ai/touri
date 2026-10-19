import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"
import { Disclosure } from "../src/components/Disclosure"

afterEach(cleanup)

const renderDisclosure = (props: Partial<Parameters<typeof Disclosure>[0]> = {}) =>
  render(
    <Disclosure summary="Detalhes técnicos" {...props}>
      <pre>team_create · 3 bots</pre>
    </Disclosure>,
  )

it("starts collapsed and names its content through aria-expanded and aria-controls", () => {
  renderDisclosure()
  const trigger = screen.getByRole("button", { name: "Detalhes técnicos" })

  expect(trigger).toHaveAttribute("aria-expanded", "false")
  expect(screen.getByText("team_create · 3 bots")).not.toBeVisible()
  expect(document.getElementById(trigger.getAttribute("aria-controls") ?? "")).toContainElement(
    screen.getByText("team_create · 3 bots"),
  )
})

it("opens and closes from a click anywhere on the row", () => {
  const { container } = renderDisclosure()
  const trigger = screen.getByRole("button", { name: "Detalhes técnicos" })

  fireEvent.click(trigger)

  expect(trigger).toHaveAttribute("aria-expanded", "true")
  expect(container.querySelector(".ds-disclosure")).toHaveAttribute("data-open", "true")
  expect(screen.getByText("team_create · 3 bots")).toBeVisible()

  fireEvent.click(trigger)

  expect(trigger).toHaveAttribute("aria-expanded", "false")
  expect(screen.getByText("team_create · 3 bots")).not.toBeVisible()
})

it.each(["{Enter}", " "])("toggles from the keyboard with %j", async (key) => {
  const user = userEvent.setup()
  renderDisclosure()

  await user.tab()
  expect(screen.getByRole("button", { name: "Detalhes técnicos" })).toHaveFocus()
  await user.keyboard(key)

  expect(screen.getByRole("button", { name: "Detalhes técnicos" })).toHaveAttribute("aria-expanded", "true")
  expect(screen.getByText("team_create · 3 bots")).toBeVisible()
})

it("reports changes and follows a controlled open state", () => {
  const onOpenChange = vi.fn()
  const { rerender } = renderDisclosure({ open: false, onOpenChange })
  fireEvent.click(screen.getByRole("button", { name: "Detalhes técnicos" }))

  expect(onOpenChange).toHaveBeenCalledWith(true)
  expect(screen.getByRole("button", { name: "Detalhes técnicos" })).toHaveAttribute("aria-expanded", "false")

  rerender(
    <Disclosure summary="Detalhes técnicos" open onOpenChange={onOpenChange}>
      <pre>team_create · 3 bots</pre>
    </Disclosure>,
  )

  expect(screen.getByRole("button", { name: "Detalhes técnicos" })).toHaveAttribute("aria-expanded", "true")
})

it("opens when openWhen turns true but stays closable afterwards", () => {
  const { rerender } = renderDisclosure({ openWhen: false })
  expect(screen.getByText("team_create · 3 bots")).not.toBeVisible()

  rerender(
    <Disclosure summary="Detalhes técnicos" openWhen>
      <pre>team_create · 3 bots</pre>
    </Disclosure>,
  )
  expect(screen.getByText("team_create · 3 bots")).toBeVisible()

  fireEvent.click(screen.getByRole("button", { name: "Detalhes técnicos" }))
  expect(screen.getByText("team_create · 3 bots")).not.toBeVisible()
})
