import { render, screen } from "@testing-library/react"
import type { Message, Run, RunErrorClass } from "@touri/contracts"
import { expect, it, vi } from "vitest"
import { VirtualMessageList } from "../src/components/ChatPanel"
import { errorRecovery } from "../src/errorRecovery"
import { ApiError } from "../src/errors"
import { runErrorFor } from "../src/runError"

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

it.each([
  ["pt-BR", "sem capacidade", "Escolha outro modelo nas configurações do bot"],
  ["en", "at capacity", "Choose another model in the bot settings"],
] as const)("uses capacity recovery in %s even with a rate limit status", (locale, cause, recovery) => {
  const diagnostic = "Selected model is at capacity. Please try a different model."

  const failure = errorRecovery(new ApiError(429, diagnostic), { errorClass: "rate_limit", locale })

  expect(failure.classified).toBe(true)
  expect(failure.message).toContain(cause)
  expect(failure.message).toContain(recovery)
  expect(failure.message).not.toMatch(/limite de uso|Muitas solicitações|usage limit/)
})

it("preserves usage limit recovery for genuine rate limits", () => {
  const { message, run } = getCapacityFixture("429 usage limit reached")

  const failure = runErrorFor(message, run)

  expect(failure?.title).toBe("Limite de uso do provedor atingido")
  expect(failure?.recovery.message).toContain("atingiu o limite de uso")
})
