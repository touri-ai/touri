import { fireEvent, render, screen } from "@testing-library/react"
import type { Message, MessagePart, Run, RunErrorClass } from "@touri/contracts"
import { expect, it, vi } from "vitest"
import { VirtualMessageList } from "../src/components/ChatPanel"
import { errorRecovery } from "../src/errorRecovery"
import { ApiError } from "../src/errors"
import { runErrorFor } from "../src/runError"

const OVERLOADS = [
  { status: 529, diagnostic: '529 {"error":{"type":"overloaded_error","message":"Overloaded"}}' },
  { status: 529, diagnostic: "HTTP 529 Overloaded" },
  { status: 503, diagnostic: "503 Service Unavailable: The model is overloaded" },
  { status: 503, diagnostic: "503: server is overloaded" },
] as const

const RECOVERY_LOCALES = [
  { locale: "pt-BR", cause: "sem capacidade", recovery: "Escolha outro modelo nas configurações do bot" },
  { locale: "en", cause: "at capacity", recovery: "Choose another model in the bot settings" },
] as const

const getRecordedActions = (): MessagePart[] => [
  { type: "command", callId: "demo-command", command: "printf demo", output: "demo", exitCode: 0 },
  { type: "file_change", callId: "demo-file", paths: ["notes.md"], diff: null, completedOutcome: "succeeded" },
  { type: "tool_call", callId: "demo-tool", tool: "demo_tool", summary: "Demo", inputJson: "{}", ok: null },
]

const getCapacityFixture = (diagnostic: string, errorClass: RunErrorClass = "rate_limit") => {
  const message: Message = {
    id: "capacity-reply",
    threadId: "capacity-thread",
    parentId: null,
    role: "assistant",
    kind: "text",
    status: "failed",
    runId: "capacity-run",
    text: "",
    parts: [
      {
        type: "notice",
        level: "error",
        code: "run_failed",
        text: `${errorClass}: ${diagnostic}`,
        failure: {
          stage: "turn",
          detail: diagnostic,
        },
      },
    ],
    sender: null,
    source: "local",
    createdAt: 1,
    updatedAt: 2,
  }
  const run: Run = {
    id: "capacity-run",
    threadId: message.threadId,
    botId: "capacity-bot",
    provider: "codex",
    trigger: "user",
    requestMessageId: "capacity-request",
    replyMessageId: message.id,
    externalTurnId: null,
    status: "failed",
    errorClass,
    errorMessage: diagnostic,
    usage: null,
    routineRunId: null,
    queuedAt: 0,
    startedAt: 1,
    finishedAt: 2,
  }

  return { message, run }
}

it.each([
  "Selected model is at capacity. Please try a different model.",
  "The model is currently at capacity. Please try again later.",
  "O modelo selecionado está sem capacidade no momento.",
  ...OVERLOADS.map(({ diagnostic }) => diagnostic),
])("shows model capacity recovery for live and stored failures: %s", (diagnostic) => {
  const { message, run } = getCapacityFixture(diagnostic)

  const failure = runErrorFor(message, run)
  render(<VirtualMessageList messages={[message]} runs={[run]} onRetry={vi.fn()} onSwitchBranch={vi.fn()} />)

  expect(failure?.title).toBe("Modelo temporariamente sem capacidade")
  expect(failure?.hint).toContain("Escolha outro modelo nas configurações do bot")
  expect(screen.getByRole("alert")).toHaveTextContent("O modelo selecionado está sem capacidade no momento.")
  expect(screen.getByRole("alert")).toHaveTextContent("Escolha outro modelo nas configurações do bot")
  expect(screen.getByRole("alert")).not.toHaveTextContent(/atingiu o limite de uso|Muitas solicitações/)
})

it("recovers legacy unknown failures without requiring a loaded run", () => {
  const { message } = getCapacityFixture("Selected model is at capacity. Please try a different model.", "unknown")

  const failure = runErrorFor(message)

  expect(failure?.title).toBe("Modelo temporariamente sem capacidade")
  expect(failure?.hint).toContain("Escolha outro modelo")
  expect(failure?.recovery.message).toContain("Escolha outro modelo")
})

it.each(OVERLOADS.flatMap((overload) => RECOVERY_LOCALES.map((recovery) => ({ ...overload, ...recovery }))))(
  "uses capacity recovery in $locale for $diagnostic",
  ({ locale, cause, recovery, status, diagnostic }) => {
    const failure = errorRecovery(new ApiError(status, diagnostic), { errorClass: "rate_limit", locale })

    expect(failure.classified).toBe(true)
    expect(failure.message).toContain(cause)
    expect(failure.message).toContain(recovery)
    expect(failure.message).not.toMatch(/limite de uso|Muitas solicitações|usage limit/)
  },
)

it.each(["file.ts:529: overloaded operator", "server is overloaded"])(
  "does not show model capacity recovery for unrelated diagnostics: %s",
  (diagnostic) => {
    const { message, run } = getCapacityFixture(diagnostic, "unknown")

    const failure = runErrorFor(message, run)
    render(<VirtualMessageList messages={[message]} runs={[run]} onRetry={vi.fn()} onSwitchBranch={vi.fn()} />)

    expect(failure?.title).not.toBe("Modelo temporariamente sem capacidade")
    expect(screen.getByRole("alert")).not.toHaveTextContent(/sem capacidade|at capacity/i)
  },
)

it("preserves usage limit recovery for genuine rate limits", () => {
  const { message, run } = getCapacityFixture("429 usage limit reached")

  const failure = runErrorFor(message, run)

  expect(failure?.title).toBe("Limite de uso do provedor atingido")
  expect(failure?.recovery.message).toContain("atingiu o limite de uso")
})

it.each(RECOVERY_LOCALES)("keeps the capacity cause and action warning in $locale", ({ locale, cause, recovery }) => {
  getRecordedActions().forEach((part) => {
    const failure = errorRecovery("Selected model is at capacity. Please try a different model.", {
      errorClass: "rate_limit",
      parts: [part],
      locale,
    })

    expect(failure.message).toContain(cause)
    expect(failure.message).toContain(recovery)
    expect(failure.message).toContain(locale === "en" ? "Some actions may" : "Algumas ações podem")
    expect(failure.actions.map((action) => action.kind)).toEqual(["review", "resume"])
  })
})

it("shows capacity recovery after recorded work without replaying actions", () => {
  const fixture = getCapacityFixture("Selected model is at capacity. Please try a different model.")
  const message = Object.assign({}, fixture.message, { parts: getRecordedActions().concat(fixture.message.parts) })
  const retry = vi.fn()

  render(<VirtualMessageList messages={[message]} runs={[fixture.run]} onRetry={retry} onSwitchBranch={vi.fn()} />)

  const card = screen.getByRole("alert")
  expect(card).toHaveTextContent("O modelo selecionado está sem capacidade no momento.")
  expect(card).toHaveTextContent("Escolha outro modelo nas configurações do bot")
  expect(card).toHaveTextContent("Algumas ações podem ter sido concluídas.")
  expect(screen.queryByRole("button", { name: "Tentar novamente" })).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole("button", { name: "Ver ações realizadas" }))
  expect(screen.getByRole("region", { name: "Ações registradas" })).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "Retomar tarefa" }))

  expect(retry).not.toHaveBeenCalled()
})
