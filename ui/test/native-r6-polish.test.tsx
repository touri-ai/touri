import { act, fireEvent, render, screen, within } from "@testing-library/react"
import type { Message } from "@touri/contracts"
import { expect, it, vi } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import { MachineFields } from "../src/components/MachineFields"
import { BotCreateModal, BotSettingsModal } from "../src/components/Modals"
import { t } from "../src/i18n"
import type { WorkspaceActions } from "../src/useWorkspace"

const jargon = /micro-VM|\b(?:VM|host|Linux|Git|display|Xvfb|MiB)\b/i

it("explains machine choices without jargon and keeps diagnostics in closed details", () => {
  const bot = createMockApi().getState().bots[0]
  if (!bot) throw new Error("Missing bot fixture")
  render(
    <MachineFields
      values={{ machine: "vm", machineIdleMinutes: 10, vmProviderLogin: false, hostComputerUse: false }}
      provider={bot.provider}
      capability={{ available: false, reason: "Linux host unavailable", provider: null }}
      state={{
        botId: "test",
        status: "running",
        progress: "Xvfb ready",
        error: null,
        memoryMb: 2048,
        createdMs: 1,
        startMs: 1,
      }}
      onChange={vi.fn()}
    />,
  )
  expect(screen.getByRole("option", { name: "Neste computador" })).toBeInTheDocument()
  expect(screen.getByRole("option", { name: /Separado só para o bot/ })).toBeDisabled()
  const details = screen.getByText("Detalhes técnicos").closest("details")
  expect(details).not.toHaveAttribute("open")
  expect(screen.getByText("Xvfb ready")).not.toBeVisible()
  const defaultContent = screen.getByRole("region", { name: "Computador" }).cloneNode(true) as HTMLElement
  defaultContent.querySelectorAll("details").forEach((node) => {
    node.remove()
  })
  expect(defaultContent.textContent).not.toMatch(jargon)
  fireEvent.click(screen.getByText("Detalhes técnicos"))
  expect(screen.getByText("Xvfb ready")).toBeVisible()
})

it("keeps creation choices and bot computer settings free of jargon until technical details open", async () => {
  const create = render(<BotCreateModal onClose={vi.fn()} onCreate={vi.fn()} />)
  fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  expect(screen.getByRole("option", { name: "Neste computador" })).toBeInTheDocument()
  expect(screen.getByRole("option", { name: /Separado só para o bot/ })).toBeInTheDocument()
  create.unmount()
  const api = createMockApi()
  const bot = api.getState().bots[0]
  if (!bot) throw new Error("Missing bot fixture")
  const settings = await api.request("GET /settings", {})
  render(
    <BotSettingsModal
      bot={{ ...bot, machine: "vm" }}
      settings={settings.settings}
      projects={[]}
      routines={[]}
      actions={{ updateBot: vi.fn() } as unknown as WorkspaceActions}
      onClose={vi.fn()}
    />,
  )
  fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  fireEvent.click(screen.getByRole("tab", { name: "Computador" }))
  const memory = screen.getByLabelText("Memória por computador do bot (MiB)")
  expect(memory).not.toBeVisible()
  const pane = screen.getByRole("tabpanel", { name: "Computador" })
  const defaultContent = pane.cloneNode(true) as HTMLElement
  defaultContent.querySelectorAll("details").forEach((node) => {
    node.remove()
  })
  expect(defaultContent.textContent).not.toMatch(jargon)
  fireEvent.click(
    screen
      .getAllByText("Detalhes técnicos")
      .find((summary) => summary.closest("details")?.contains(memory)) as HTMLElement,
  )
  expect(memory).toBeVisible()
  fireEvent.change(memory, { target: { value: "256" } })
  fireEvent.click(screen.getByText("Detalhes técnicos"))
  expect(memory).not.toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "Salvar configurações" }))
  expect(screen.getByRole("alert")).toHaveTextContent("512")
  expect(memory).toBeVisible()
  fireEvent.change(memory, { target: { value: "512" } })
  expect(memory).toBeVisible()
  fireEvent.change(memory, { target: { value: "5120" } })
  expect(memory).toHaveValue(5120)
  expect(memory).toBeVisible()
})

it.each([false, true])(
  "separates scheduling from recovery after failure (recorded actions: %s)",
  async (recordedActions) => {
    const api = createMockApi()
    const state = api.getState()
    const previous = state.messages.find((message) => message.role === "assistant")
    if (!previous) throw new Error("Missing reply fixture")
    previous.parentId = state.messages.find((message) => message.role === "user")?.id ?? null
    const failed: Message = {
      ...previous,
      id: "failed-reply",
      parentId: previous.id,
      runId: "failed-run",
      status: "failed" as const,
      text: "",
      parts: [
        { type: "notice" as const, level: "error" as const, code: "run_failed", text: "cli_auth: session expired" },
      ],
      createdAt: previous.createdAt + 1,
    }
    if (recordedActions)
      failed.parts.push({ type: "command", callId: "saved-note", command: "touch notes.txt", output: "", exitCode: 0 })
    state.messages.push(failed)
    const thread = state.threads.find((entry) => entry.id === failed.threadId)
    if (!thread) throw new Error("Missing thread fixture")
    thread.activeLeafId = failed.id
    render(<App kernel={{ services: { api } }} />)
    const schedule = await screen.findByRole("button", { name: "Agendar esta tarefa" }, { timeout: 15000 })
    expect(screen.queryByRole("button", { name: "Repetir esta tarefa" })).toBeNull()
    fireEvent.click(schedule)
    const dialog = screen.getByRole("dialog", { name: "Quando?" })
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }))
    expect(api.calls.some((call) => call.route === "POST /runs/:id/retry")).toBe(false)
    if (recordedActions) {
      expect(screen.queryByRole("button", { name: "Tentar de novo" })).toBeNull()
      expect(screen.getByRole("button", { name: "Ver ações realizadas" })).toBeVisible()
      return
    }
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" })))
    expect(
      api.calls.some((call) => call.route === "POST /runs/:id/retry" && call.pathValues?.id === failed.runId),
    ).toBe(true)
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(api.calls.some((call) => call.route === "POST /routines")).toBe(false)
  },
  30000,
)

it("provides Portuguese and English for the new default copy", () => {
  expect(t("Agendar esta tarefa", {}, "en")).toBe("Schedule this task")
  expect(t("Tentar de novo", {}, "en")).toBe("Try again")
  expect(t("Detalhes técnicos", {}, "en")).toBe("Technical details")
  for (const key of [
    "Local machine",
    "Isolated Linux VM",
    "Local machine help",
    "VM machine help",
    "Host computer use help",
    "Allow host computer use",
  ] as const) {
    for (const locale of ["pt-BR", "en"] as const) expect(t(key, {}, locale)).not.toMatch(jargon)
  }
})
