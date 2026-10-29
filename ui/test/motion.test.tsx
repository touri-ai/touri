import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"
import { MotionPresence, useInsertedIds } from "../src/components/Motion"
import { AnimatedDisclosure } from "../src/components/Reveal"
import { SettingsDisclosure } from "../src/components/SettingsLayout"
import { motionTiers } from "../src/design/spring"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete document.documentElement.dataset.motion
})

test("closing surfaces are inert immediately, survive only the exit, and tolerate reopening", () => {
  vi.useFakeTimers()
  const surface = (show: boolean, text = "Preferências") => (
    <MotionPresence show={show} kind="modal">
      <button type="button">{text}</button>
    </MotionPresence>
  )
  const { rerender } = render(surface(true))
  rerender(surface(true, "Preferências atualizadas"))
  rerender(surface(false))
  expect(document.querySelector(".motion-presence")).toHaveAttribute("inert")
  expect(screen.queryByRole("button")).toBeNull()
  expect(screen.getByText("Preferências atualizadas")).toBeInTheDocument()
  act(() => vi.advanceTimersByTime(motionTiers.quick.duration - 1))
  expect(document.querySelector(".motion-presence")).toBeInTheDocument()
  rerender(surface(true))
  act(() => vi.advanceTimersByTime(motionTiers.quick.duration))
  expect(screen.getByRole("button", { name: "Preferências" })).toBeInTheDocument()
  rerender(surface(false))
  act(() => vi.advanceTimersByTime(motionTiers.quick.duration))
  expect(document.querySelector(".motion-presence")).toBeNull()
})

test("reopening a modal during its exit starts a new disclosure session", () => {
  vi.useFakeTimers()
  const getSurface = (show: boolean) => (
    <MotionPresence show={show} kind="modal">
      <SettingsDisclosure title="Som" description="Preferências de som">
        {(open) => open && <input aria-label="Som do canal" type="checkbox" defaultChecked />}
      </SettingsDisclosure>
    </MotionPresence>
  )
  const { rerender } = render(getSurface(true))
  fireEvent.click(screen.getByRole("button", { name: /Som/ }))
  fireEvent.click(screen.getByRole("checkbox", { name: "Som do canal" }))
  rerender(getSurface(true))
  expect(screen.getByRole("checkbox", { name: "Som do canal" })).not.toBeChecked()

  rerender(getSurface(false))
  expect(screen.getByLabelText("Som do canal")).not.toBeChecked()
  rerender(getSurface(true))

  expect(screen.getByRole("button", { name: /Som/ })).toHaveAttribute("aria-expanded", "false")
  fireEvent.click(screen.getByRole("button", { name: /Som/ }))
  expect(screen.getByRole("checkbox", { name: "Som do canal" })).toBeChecked()
})

test.each(["system", "app"])("%s reduced motion removes closed surfaces without a timer", (preference) => {
  if (preference === "app") document.documentElement.dataset.motion = "reduce"
  else vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList)
  const { rerender } = render(
    <MotionPresence show kind="panel">
      <p>Painel</p>
    </MotionPresence>,
  )
  rerender(
    <MotionPresence show={false} kind="panel">
      <p>Painel</p>
    </MotionPresence>,
  )
  expect(screen.queryByText("Painel")).toBeNull()
})

const List = ({ ids, text, scope = "conversa" }: { ids: string[]; text: string; scope?: string }) => {
  const inserted = useInsertedIds(ids, scope)
  return (
    <ul>
      {ids.map((id) => (
        <li key={id} data-motion-insert={inserted.has(id)}>
          {id}: {text}
        </li>
      ))}
    </ul>
  )
}

test("only inserted IDs animate; token updates and navigation history never replay", () => {
  vi.useFakeTimers()
  const { rerender } = render(<List ids={["a"]} text="Início" />)
  expect(screen.getByText("a: Início")).toHaveAttribute("data-motion-insert", "false")
  rerender(<List ids={["a", "b"]} text="Primeiro token" />)
  expect(screen.getByText("b: Primeiro token")).toHaveAttribute("data-motion-insert", "true")
  act(() => vi.advanceTimersByTime(motionTiers.surface.duration))
  rerender(<List ids={["a", "b"]} text="Mais tokens" />)
  expect(screen.getByText("b: Mais tokens")).toHaveAttribute("data-motion-insert", "false")
  rerender(<List ids={["c"]} text="Histórico" scope="outra conversa" />)
  expect(screen.getByText("c: Histórico")).toHaveAttribute("data-motion-insert", "false")
})

test("controlled disclosures share the same accessible state and request state changes", () => {
  const change = vi.fn()
  const { rerender } = render(
    <AnimatedDisclosure summary="Arquivos" expanded onExpandedChange={change}>
      <button type="button">Abrir arquivo</button>
    </AnimatedDisclosure>,
  )
  fireEvent.click(screen.getByRole("button", { name: "Arquivos" }))
  expect(change).toHaveBeenCalledWith(false)
  expect(screen.getByRole("button", { name: "Arquivos" })).toHaveAttribute("aria-expanded", "true")
  rerender(
    <AnimatedDisclosure summary="Arquivos" expanded={false}>
      <button type="button">Abrir arquivo</button>
    </AnimatedDisclosure>,
  )
  expect(screen.queryByRole("button", { name: "Abrir arquivo" })).toBeNull()
  expect(document.querySelector(".disclosure-reveal")).toHaveAttribute("inert")
})
