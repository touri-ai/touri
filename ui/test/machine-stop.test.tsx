import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { MachineState, Run } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import { BotComputer } from "../src/components/BotComputer"
import { MachineStatus } from "../src/components/MachineStatus"

vi.mock("../src/features/desktop/DesktopPanel", () => ({
  DesktopPanel: () => <section aria-label="Área de trabalho de teste" />,
}))
afterEach(() => window.history.replaceState({}, "", "/"))

const machine: MachineState = {
  botId: "bot-mark",
  status: "running",
  progress: null,
  error: null,
  memoryMb: 2048,
  createdMs: 1,
  startMs: 1,
}

it.each(["panel", "window"])(
  "%s blocks stopping for a turn in another conversation of the same bot",
  async (surface) => {
    const api = createMockApi()
    await api.request("PATCH /bots/:id", { machine: "vm" }, { id: machine.botId })
    if (surface === "window") window.history.replaceState({}, "", `/?computer=${machine.botId}`)
    render(<App kernel={{ services: { api } }} />)
    if (surface === "window") await screen.findByRole("region", { name: "Computador de mark" })
    else await screen.findByRole("textbox", { name: "Mensagem para mark" })
    const run: Run = {
      id: "other-thread-turn",
      botId: machine.botId,
      threadId: "other-thread",
      provider: "codex",
      trigger: "user",
      status: "running",
      queuedAt: 1,
      startedAt: 1,
      finishedAt: null,
      requestMessageId: null,
      replyMessageId: null,
      externalTurnId: null,
      errorClass: null,
      errorMessage: null,
      usage: null,
      routineRunId: null,
    }
    await act(async () => {
      api.emit({ type: "machine.updated", machine })
      api.emit({ type: "run.updated", run })
    })
    if (surface === "panel") {
      fireEvent.click(screen.getByRole("button", { name: "Painel do bot" }))
      fireEvent.click(screen.getByRole("tab", { name: "Computador" }))
    }
    expect(await screen.findAllByRole("button", { name: "Parar máquina" })).toHaveLength(1)
    for (const button of screen.getAllByRole("button", { name: "Parar máquina" })) expect(button).toBeDisabled()
    await act(async () => api.emit({ type: "run.updated", run: { ...run, status: "succeeded", finishedAt: 2 } }))
    for (const button of screen.getAllByRole("button", { name: "Parar máquina" })) expect(button).toBeEnabled()
    await act(async () => fireEvent.click(screen.getAllByRole("button", { name: "Parar máquina" })[0] as HTMLElement))
    expect(screen.queryByRole("button", { name: "Parar máquina" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Ligar computador" })).toBeVisible()
  },
  15_000,
)

for (const surface of ["header", "computer"] as const) {
  const fixture = (activeTurns = false) => {
    const api = createMockApi()
    const bot = api.getState().bots[0]
    if (!bot) throw new Error("Missing bot")
    return {
      api,
      element:
        surface === "header" ? (
          <MachineStatus api={api} machine={machine} turnFailed={false} activeTurns={activeTurns} />
        ) : (
          <BotComputer api={api} bot={{ ...bot, machine: "vm" }} machine={machine} activeTurns={activeTurns} />
        ),
    }
  }

  it(`${surface}: stops a running VM through the existing stop route`, async () => {
    const { api, element } = fixture()
    render(element)
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Parar máquina" })))
    expect(api.calls).toContainEqual({
      route: "POST /bots/:id/machine/stop",
      input: {},
      pathValues: { id: machine.botId },
    })
    expect(api.calls.some((call) => /reset|restart/.test(call.route))).toBe(false)
  })

  it(`${surface}: explains why stopping is disabled during an active turn`, () => {
    const { api, element } = fixture(true)
    render(element)
    const stop = screen.getByRole("button", { name: "Parar máquina" })
    expect(stop).toBeDisabled()
    expect(stop).toHaveAccessibleDescription("Aguarde o turno terminar ou pare o turno para parar a máquina.")
    fireEvent.click(stop)
    expect(api.calls.some((call) => call.route === "POST /bots/:id/machine/stop")).toBe(false)
  })

  it(`${surface}: prevents duplicate stops and allows retry after an error`, async () => {
    const { api, element } = fixture()
    const original = api.request.bind(api)
    let rejectStop: (error: Error) => void = () => {}
    api.request = vi.fn((route, input, path) =>
      route === "POST /bots/:id/machine/stop"
        ? new Promise((_, reject) => {
            rejectStop = reject
          })
        : original(route, input, path),
    ) as typeof api.request
    render(element)
    fireEvent.click(screen.getByRole("button", { name: "Parar máquina" }))
    expect(screen.getByRole("button", { name: "Parando máquina…" })).toBeDisabled()
    await act(async () => rejectStop(new Error("Falha ao parar a máquina")))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Falha ao parar a máquina"))
    expect(screen.getByRole("button", { name: "Parar máquina" })).toBeEnabled()
  })
}
