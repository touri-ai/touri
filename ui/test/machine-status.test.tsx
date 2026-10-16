import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { MachineState, Message, Run } from "@touri/contracts"
import { expect, it, vi } from "vitest"
import { createMockApi } from "../src/api/mock"
import { ChatPanel } from "../src/components/ChatPanel"
import { ApiError } from "../src/errors"
import { DoctorChecks } from "../src/features/doctor/DoctorChecks"

const fixture = (errorClass: string, status: MachineState["status"] = "error") => {
  const api = createMockApi()
  const original = api.getState().bots[0]
  if (!original) throw new Error("Missing bot")
  const bot = { ...original, machine: "vm" as const }
  const thread = api.getState().threads.find((item) => item.botId === bot.id)
  if (!thread) throw new Error("Missing thread")
  const message: Message = {
    id: "failure",
    threadId: thread.id,
    parentId: null,
    role: "assistant",
    kind: "text",
    status: "failed",
    runId: "failed-turn",
    text: "",
    parts: [
      {
        type: "notice",
        level: "error",
        code: "run_failed",
        text: `${errorClass}: O serviço de máquinas do macOS não está ativo. [TOURI-E8001]`,
      },
    ],
    sender: null,
    source: "local",
    createdAt: 1,
    updatedAt: 1,
  }
  const machine: MachineState = {
    botId: bot.id,
    status,
    progress: status === "starting" ? "Preparando máquina…" : null,
    error: status === "error" ? "O serviço de máquinas do macOS não está ativo. [TOURI-E8001]" : null,
    memoryMb: 2048,
    createdMs: null,
    startMs: null,
  }
  const props = {
    api,
    bot,
    thread: { ...thread, activeLeafId: message.id },
    messages: [message],
    runs: [],
    machine,
    onSend: vi.fn(),
    onRetry: vi.fn(),
    onCancel: vi.fn(),
    onSwitchBranch: vi.fn(),
    computerGrant: null,
    onComputerGrant: vi.fn(),
    onOpenTools: vi.fn(),
  }
  return { api, bot, props }
}

it("offers service recovery in the chat and composer with progress and a safe retryable failure", async () => {
  const { api, bot, props } = fixture("machine_service_unavailable")
  const originalRequest = api.request.bind(api)
  let reject: (reason: unknown) => void = () => {}
  api.request = vi.fn((route, input, path) =>
    route === "POST /machines/service/start"
      ? new Promise((_, fail) => {
          reject = fail
        })
      : originalRequest(route, input, path),
  ) as typeof api.request
  render(<ChatPanel {...props} />)
  const buttons = screen.getAllByRole("button", { name: "Iniciar serviço" })
  expect(buttons).toHaveLength(2)
  const button = within(screen.getByRole("complementary", { name: "Aviso do computador" })).getByRole("button", {
    name: "Iniciar serviço",
  })
  fireEvent.click(button)
  expect(screen.getByRole("button", { name: "Iniciando serviço…" })).toBeDisabled()
  expect(api.request).toHaveBeenCalledWith("POST /machines/service/start", { botId: bot.id })
  await act(async () => reject(new ApiError(503, "private XPC", "MACHINE_SERVICE_START_FAILED", "TOURI-E8002")))
  expect(screen.getByText(/Não foi possível iniciar o serviço de máquinas do macOS/)).toBeVisible()
  expect(screen.queryByText(/private XPC/)).not.toBeInTheDocument()
  expect(screen.getAllByRole("button", { name: "Iniciar serviço" })).toHaveLength(2)
})

it.each(["machine_service_unavailable", "machine_service_start_failed"])(
  "replaces a stale %s warning with preparation and clears it when running",
  (errorClass) => {
    const { props } = fixture(errorClass)
    const { rerender } = render(<ChatPanel {...props} />)
    expect(screen.getByRole("alert")).toBeVisible()
    rerender(<ChatPanel {...props} machine={{ ...props.machine, status: "starting" }} />)
    expect(screen.getByText("Ainda preparando o computador dele…")).toBeVisible()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.queryByText("O computador precisa de atenção")).not.toBeInTheDocument()
    expect(screen.queryByText(/não está ativo/)).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Iniciar serviço" })).not.toBeInTheDocument()
    rerender(<ChatPanel {...props} machine={{ ...props.machine, status: "running" }} />)
    expect(document.querySelector(".machine-turn-status")).toBeNull()
    expect(screen.queryByText("Ainda preparando o computador dele…")).not.toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.queryByText("O computador precisa de atenção")).not.toBeInTheDocument()
    expect(screen.queryByText(/não está ativo/)).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Iniciar serviço" })).not.toBeInTheDocument()
  },
)

it("accepts a message while the machine is preparing", async () => {
  const { props } = fixture("machine_service_unavailable", "starting")
  render(<ChatPanel {...props} messages={[]} />)
  expect(screen.getByText("Preparando o computador…")).toBeVisible()
  // The composer may first wait for the provider login check.
  await waitFor(() => expect(screen.queryByText("Colar token manualmente")).toBeNull())
  const input = screen.getByRole("textbox")
  fireEvent.change(input, { target: { value: "Prepare o relatório" } })
  fireEvent.keyDown(input, { key: "Enter" })
  await waitFor(() => expect(props.onSend).toHaveBeenCalledWith("Prepare o relatório", props.thread.activeLeafId, []))
})

it("removes a routine's service failure card when the machine recovers", () => {
  const { props } = fixture("machine_service_unavailable")
  const run: Run = {
    id: "failed-turn",
    threadId: props.thread.id,
    botId: props.bot.id,
    provider: "codex",
    trigger: "routine",
    requestMessageId: null,
    replyMessageId: "failure",
    externalTurnId: null,
    status: "failed",
    errorClass: "machine_service_unavailable",
    errorMessage: "O serviço de máquinas do macOS não está ativo.",
    usage: null,
    routineRunId: null,
    queuedAt: 1,
    startedAt: 1,
    finishedAt: 1,
  }
  const { container, rerender } = render(<ChatPanel {...props} runs={[run]} />)
  expect(container.querySelector(".run-failed")).toBeInTheDocument()
  rerender(<ChatPanel {...props} runs={[run]} machine={{ ...props.machine, status: "running" }} />)
  expect(container.querySelector(".run-failed")).not.toBeInTheDocument()
  expect(screen.queryByText(/não está ativo/)).not.toBeInTheDocument()
})

it("explains independent preparation after a failed VM turn and offers a machine stop", async () => {
  const { api, props } = fixture("timeout", "starting")
  const message = props.messages[0]
  if (!message) throw new Error("Missing reply")
  message.parts = [
    { type: "notice", level: "error", code: "run_failed", text: "timeout: A operação demorou demais. [TOURI-E1008]" },
  ]
  render(<ChatPanel {...props} />)
  expect(screen.getByText("Ainda preparando o computador dele…")).toBeVisible()
  expect(screen.getByText("Confira o estado da máquina e tente de novo.")).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "Parar máquina" }))
  await waitFor(() => expect(api.calls.some((call) => call.route === "POST /bots/:id/machine/stop")).toBe(true))
  expect(screen.queryByRole("button", { name: "Parar" })).not.toBeInTheDocument()
})

it("does not attribute a local timeout to machine preparation", () => {
  const { props } = fixture("timeout", "starting")
  render(<ChatPanel {...props} bot={{ ...props.bot, machine: "local" }} />)
  expect(screen.queryByText("Confira o estado da máquina e tente de novo.")).not.toBeInTheDocument()
  expect(screen.queryByRole("button", { name: "Parar máquina" })).not.toBeInTheDocument()
})

it("Doctor runs the explicit service action, shows progress and refreshes after success", async () => {
  const api = createMockApi()
  const onRefresh = vi.fn(async () => {})
  render(
    <DoctorChecks
      api={api}
      doctor={{
        checks: [
          {
            id: "vm-system",
            label: "Apple container · serviço",
            status: "fail",
            ok: false,
            detail: "O serviço de máquinas do macOS não está ativo. [TOURI-E8001]",
            fix: "container system start",
            action: "start-machine-service",
          },
        ],
      }}
      error={null}
      onRefresh={onRefresh}
    />,
  )
  fireEvent.click(screen.getByRole("button", { name: "Iniciar serviço" }))
  await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce())
  expect(api.calls.find((call) => call.route === "POST /machines/service/start")).toMatchObject({ input: {} })
})

it("keeps an inactive computer out of the chat header", () => {
  const f = fixture("unknown", "stopped")
  render(<ChatPanel {...f.props} machine={{ ...f.props.machine, pauseReason: "inactivity" }} />)
  expect(document.querySelector(".machine-turn-status")).toBeNull()
  expect(screen.queryByRole("button", { name: "Ligar" })).toBeNull()
})

it("shows computer activity only during work and keeps machine diagnostics off the surface", () => {
  const { props } = fixture("unknown", "running")
  const run: Run = {
    id: "active-computer-run",
    threadId: props.thread.id,
    botId: props.bot.id,
    provider: props.bot.provider,
    trigger: "user",
    requestMessageId: null,
    replyMessageId: null,
    externalTurnId: null,
    status: "running",
    errorClass: null,
    errorMessage: null,
    usage: null,
    routineRunId: null,
    queuedAt: 1,
    startedAt: 1,
    finishedAt: null,
  }
  const idle = { ...props, messages: [], runs: [] }
  const view = render(<ChatPanel {...idle} />)
  expect(document.querySelector(".machine-turn-status")).toBeNull()
  view.rerender(<ChatPanel {...idle} runs={[run]} />)
  expect(screen.getByText("Trabalhando na máquina dele…")).toBeVisible()
  expect(document.querySelector(".machine-turn-status")).not.toHaveTextContent(/VM|MiB|2048/)
  view.rerender(<ChatPanel {...idle} runs={[{ ...run, status: "succeeded" }]} />)
  expect(document.querySelector(".machine-turn-status")).toBeNull()
})

it("shows a computer permission request only for its active conversation and preserves explicit approval", async () => {
  const { api, props } = fixture("unknown", "running")
  const request = api.request
  const grantRequest = vi.fn(async (_input: unknown) => ({ grantId: "grant", expiresAt: Date.now() + 60_000 }))
  api.request = (async (route, ...args) =>
    route === "POST /computer/grants" ? grantRequest(args[0]) : request(route, ...args)) as typeof api.request
  const run: Run = {
    id: "computer-permission-run",
    threadId: props.thread.id,
    botId: props.bot.id,
    provider: props.bot.provider,
    trigger: "user",
    requestMessageId: null,
    replyMessageId: null,
    externalTurnId: null,
    status: "running",
    errorClass: null,
    errorMessage: null,
    usage: null,
    routineRunId: null,
    queuedAt: 1,
    startedAt: 1,
    finishedAt: null,
  }
  const grant = { botId: props.bot.id, threadId: props.thread.id, botName: props.bot.name }
  const pending = { ...props, messages: [], computerGrant: grant }
  const view = render(<ChatPanel {...pending} />)
  expect(screen.queryByRole("button", { name: "Permitir controle do computador" })).toBeNull()
  view.rerender(<ChatPanel {...pending} runs={[{ ...run, threadId: "another-thread" }]} />)
  expect(screen.queryByRole("button", { name: "Permitir controle do computador" })).toBeNull()
  view.rerender(<ChatPanel {...pending} runs={[run]} />)
  expect(screen.getByText("mark está aguardando permissão para controlar seu Mac.")).toBeVisible()
  expect(grantRequest).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "Permitir controle do computador" }))
  await waitFor(() =>
    expect(grantRequest).toHaveBeenCalledWith({
      botId: props.bot.id,
      threadId: props.thread.id,
      minutes: 30,
    }),
  )
  expect(props.onComputerGrant).toHaveBeenCalledOnce()
  view.rerender(<ChatPanel {...pending} runs={[{ ...run, status: "canceled" }]} />)
  expect(screen.queryByRole("button", { name: "Permitir controle do computador" })).toBeNull()
})
