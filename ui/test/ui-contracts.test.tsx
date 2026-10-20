import { readFileSync } from "node:fs"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { MachineState, ToolCallPart } from "@touri/contracts"
import { useLayoutEffect, useRef } from "react"
import { afterEach, expect, test, vi } from "vitest"
import { createMockApi } from "../src/api/mock"
import { ActivityMark } from "../src/components/ActivityMark"
import { AvatarRuntimeProvider } from "../src/components/AvatarRuntime"
import { BotAvatar } from "../src/components/BotAvatar"
import { mascotSignalFor } from "../src/components/mascotState"
import { PageTransition } from "../src/components/PageTransition"
import { ToolCallCard } from "../src/components/ToolCallCard"
import type { AppRoute } from "../src/workspaceState"

const tokens = readFileSync("src/design/tokens.css", "utf8")
const styles = readFileSync("src/styles.css", "utf8")
const motion = readFileSync("src/design/motion.css", "utf8")
const seed = createMockApi().getState()
const bot = seed.bots[0]
if (!bot) throw new Error("Missing bot fixture")
const machine: MachineState = {
  botId: bot.id,
  status: "stopped",
  pauseReason: "inactivity",
  progress: null,
  error: null,
  memoryMb: 1024,
  createdMs: 1,
  startMs: 1,
}
const tool: ToolCallPart = {
  type: "tool_call",
  callId: "contract-tool",
  tool: "Read",
  summary: "Ler arquivo",
  inputJson: '{"path":"/workspace/README.md"}',
  outputJson: "Primeiro resultado",
  ok: true,
}
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete document.documentElement.dataset.motion
})

test("A12c: two elevations (e1 cards, e2 menus and dialogs) back every elevation role and surfaces consume roles", () => {
  const recipe = (name: string) => tokens.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]
  expect(recipe("e1")).toContain("0 1px 2px")
  expect(recipe("e2")?.split(",")).toHaveLength(2)
  for (const role of ["control", "inline", "card", "composer", "badge", "chip"]) {
    expect(recipe(`elevation-${role}`), role).toBe("var(--e1)")
  }
  for (const role of ["menu", "popover", "modal", "window", "dialog", "notifications"]) {
    expect(recipe(`elevation-${role}`), role).toBe("var(--e2)")
  }
  expect(styles).toMatch(/\.tool-call-card\s*\{[^}]*box-shadow: var\(--elevation-inline\)/)
  expect(styles).toContain("box-shadow: var(--elevation-modal)")
})

test("A12d: semantic menu, row and bubble geometry is shared by consumers", () => {
  for (const name of [
    "menu-row-height",
    "menu-corner",
    "menu-padding",
    "bubble-radius",
    "bubble-padding-block",
    "bubble-padding-inline",
    "chat-column-width",
  ]) {
    expect(tokens).toContain(`--${name}:`)
    expect(styles).toContain(`var(--${name})`)
  }
  const sidebar = readFileSync("src/components/bot-sidebar.css", "utf8")
  expect(sidebar).toContain("var(--control-size)")
  expect(sidebar).toContain("var(--menu-row-height)")
})

test("A13a: visible idle parking follows machine lifecycle and wakes without a visibility event", () => {
  const scene = (state: MachineState) => (
    <AvatarRuntimeProvider
      value={{ ...seed, notifications: [], loading: false, runs: [], messages: [], machines: [state] }}
    >
      <BotAvatar bot={bot} />
    </AvatarRuntimeProvider>
  )
  const view = render(scene(machine))
  expect(view.container.querySelector(".tb-avatar")).toHaveAttribute("data-mascot-state", "parked")
  view.rerender(scene({ ...machine, status: "starting", pauseReason: null }))
  expect(view.container.querySelector(".tb-avatar")).toHaveAttribute("data-mascot-state", "idle")
  vi.spyOn(document, "hidden", "get").mockReturnValue(true)
  fireEvent(document, new Event("visibilitychange"))
  expect(view.container.querySelector(".tb-avatar")).toHaveAttribute("data-mascot-state", "idle")
})

test("A13a: parking preserves approval precedence and manual stops are not idle parking", () => {
  const project = (state: MachineState, waiting = false) =>
    mascotSignalFor({ botId: bot.id, machine: state, waiting }).state
  expect(project(machine)).toBe("parked")
  expect(project(machine, true)).toBe("waiting-approval")
  expect(project({ ...machine, pauseReason: null })).toBe("idle")
})

test("A13b: activity ink follows state with a static reduced-motion equivalent", () => {
  expect(motion).toMatch(/@property --activity-ink\s*\{[^}]*syntax: "<color>"/)
  expect(motion).toContain("transition: --activity-ink")
  expect(styles).toMatch(/\.activity-mark\s*\{[^}]*transition: color/)
  for (const state of ["thinking", "working-tool", "typing", "waiting-approval"] as const) {
    expect(styles).toContain(`.activity-mark[data-mascot-state="${state}"]`)
  }
  vi.spyOn(window, "matchMedia").mockReturnValue({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as MediaQueryList)
  const view = render(<ActivityMark state="working-tool" parts={[tool]} />)
  expect(view.container.querySelector(".activity-mark")).toHaveAttribute("data-reduced-motion", "true")
  view.rerender(<ActivityMark state="waiting-approval" />)
  expect(screen.getByRole("status")).toHaveTextContent("Preciso da sua autorização.")
})

test("A14: tool insertion and native disclosure share reveal without restarting on deltas", async () => {
  const frames: FrameRequestCallback[] = []
  const raf = vi.fn((callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal("requestAnimationFrame", raf)
  vi.stubGlobal("cancelAnimationFrame", vi.fn())
  const user = userEvent.setup()
  const view = render(<ToolCallCard part={tool} />)
  const card = screen.getByRole("article")
  expect(card).toHaveClass("tool-surface-reveal")
  act(() => {
    for (const frame of frames.splice(0)) frame(0)
  })
  expect(card.style.getPropertyValue("--reveal")).toBe("1")
  const summary = screen.getByText("Resultado")
  await user.click(summary)
  expect(summary.closest("details")).toHaveAttribute("open")
  const content = summary.nextElementSibling
  expect(content).toHaveClass("disclosure-reveal")
  await waitFor(() => expect(frames).not.toHaveLength(0))
  act(() => {
    for (const frame of frames.splice(0)) frame(16)
  })
  expect(content).not.toHaveAttribute("inert")
  const count = raf.mock.calls.length
  view.rerender(<ToolCallCard part={{ ...tool, outputJson: "Primeiro resultado e mais um delta" }} />)
  expect(screen.getByRole("article")).toBe(card)
  expect(raf).toHaveBeenCalledTimes(count)
  expect(content).toHaveTextContent("mais um delta")
  await user.click(summary)
  expect(summary.closest("details")).not.toHaveAttribute("open")
  await waitFor(() => expect(content).toHaveStyle("--reveal: 0"))
})

test.each([false, true])("A15: actual route changes focus destination, including reduced motion (%s)", (reduced) => {
  if (reduced) document.documentElement.dataset.motion = "reduce"
  const scene = (route: AppRoute, label: string) => (
    <PageTransition route={route}>
      <h1>{label}</h1>
      <input aria-label="Rascunho" />
    </PageTransition>
  )
  const chat: AppRoute = { section: "bots", screen: "chat" }
  const view = render(scene(chat, "Conversa"))
  const input = screen.getByRole("textbox")
  input.focus()
  view.rerender(scene({ section: "bots", screen: "preview" }, "Preview"))
  expect(screen.getByRole("heading", { name: "Preview" })).toHaveFocus()
  input.focus()
  view.rerender(scene({ section: "bots", screen: "preview" }, "Preview atualizado"))
  expect(input).toHaveFocus()
  view.rerender(scene(chat, "Conversa"))
  expect(screen.getByRole("heading", { name: "Conversa" })).toHaveFocus()
})

test("A15: an explicit approval destination keeps focus during page navigation", () => {
  const Destination = () => {
    const ref = useRef<HTMLElement>(null)
    useLayoutEffect(() => {
      ref.current?.focus()
    }, [])
    return (
      <article ref={ref} tabIndex={-1} data-approval-id="destination">
        Aprovação solicitada
      </article>
    )
  }
  const view = render(
    <PageTransition route={{ section: "advanced", page: "cron" }}>
      <h1>Cron</h1>
    </PageTransition>,
  )
  view.rerender(
    <PageTransition route={{ section: "bots", screen: "chat" }}>
      <h1>Conversa</h1>
      <Destination />
    </PageTransition>,
  )
  expect(screen.getByRole("article")).toHaveFocus()
})
