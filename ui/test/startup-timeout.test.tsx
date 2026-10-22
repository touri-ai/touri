import { render, screen } from "@testing-library/react"
import type { Message, Run } from "@touri/contracts"
import { RUN_START_TIMEOUT_MESSAGE, safeRunFailure } from "@touri/contracts/run-failure"
import { expect, it, vi } from "vitest"
import { VirtualMessageList } from "../src/components/ChatPanel"
import { errorRecovery } from "../src/errorRecovery"
import { t } from "../src/i18n"
import { runErrorFor } from "../src/runError"

it("shows the startup deadline cause with a retry action and Portuguese/English translations", () => {
  const message: Message = {
    id: "reply",
    threadId: "thread",
    parentId: "request",
    role: "assistant",
    kind: "text",
    status: "failed",
    runId: "run",
    text: "",
    parts: [
      {
        type: "notice",
        level: "error",
        code: "run_failed",
        text: `timeout: ${RUN_START_TIMEOUT_MESSAGE} [TOURI-E1008]`,
        failure: safeRunFailure("timeout", RUN_START_TIMEOUT_MESSAGE),
      },
    ],
    sender: null,
    source: "local",
    createdAt: 1,
    updatedAt: 120_001,
  }
  const run: Run = {
    id: "run",
    threadId: "thread",
    botId: "bot",
    provider: "codex",
    trigger: "user",
    requestMessageId: "request",
    replyMessageId: message.id,
    externalTurnId: null,
    status: "failed",
    errorClass: "timeout",
    errorMessage: RUN_START_TIMEOUT_MESSAGE,
    usage: null,
    routineRunId: null,
    queuedAt: 1,
    startedAt: 1,
    finishedAt: 120_001,
  }

  render(<VirtualMessageList messages={[message]} onRetry={vi.fn()} onSwitchBranch={vi.fn()} />)

  expect(screen.getByText(RUN_START_TIMEOUT_MESSAGE, { selector: "p" })).toBeVisible()
  expect(screen.getByRole("button", { name: /Tentar novamente/i })).toBeEnabled()
  expect(runErrorFor(message, run)?.detail).toBe(RUN_START_TIMEOUT_MESSAGE)
  expect(errorRecovery(RUN_START_TIMEOUT_MESSAGE, { errorClass: "timeout", locale: "en" }).message).toBe(
    "No response after 2 minutes.",
  )
  expect(t(RUN_START_TIMEOUT_MESSAGE, {}, "pt-BR")).toBe(RUN_START_TIMEOUT_MESSAGE)
  expect(t(RUN_START_TIMEOUT_MESSAGE, {}, "en")).toBe("No response after 2 minutes.")
})
