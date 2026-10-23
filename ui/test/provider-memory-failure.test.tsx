import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { Message, Run } from "@touri/contracts"
import { afterEach, expect, it } from "vitest"
import { ErrorNotice } from "../src/components/ErrorNotice"
import { errorRecovery } from "../src/errorRecovery"
import { runErrorFor } from "../src/runError"

afterEach(cleanup)

const run = { id: "run-oom", threadId: "thread-oom", errorClass: "oom", errorMessage: "Codex exited (137)" } as Run
const message = {
  id: "message-oom",
  threadId: "thread-oom",
  runId: "run-oom",
  role: "assistant",
  status: "failed",
  text: "",
  parts: [],
  updatedAt: 0,
} as unknown as Message

it("explains a memory stop in plain words and keeps the exit code in the error details", () => {
  render(<ErrorNotice error="Codex exited (137)" context={{ errorClass: "oom" }} />)

  const summary = screen.getByText(/^O bot parou antes de terminar/)
  expect(summary.textContent).toBe(
    "O bot parou antes de terminar, talvez por falta de memória. Envie a mensagem de novo para continuar. Se repetir, aumente a memória da máquina.",
  )
  expect(summary.textContent).not.toMatch(/137|provedor/)
  fireEvent.click(screen.getByRole("button", { name: "Detalhes do erro" }))
  expect(screen.getByText("Codex exited (137)")).toBeTruthy()
})

it("translates the memory stop into English", () => {
  const view = errorRecovery("Codex exited (137)", { errorClass: "oom", locale: "en" })

  expect(view.message).toBe(
    "The bot stopped before finishing, possibly because it ran out of memory. Send your message again to continue. If it happens again, give the machine more memory.",
  )
  expect(view.diagnostic).toBe("Codex exited (137)")
})

it("shows the same plain copy on the failed conversation message", () => {
  const view = runErrorFor(message, run)

  expect(view?.detail).toBe("O bot parou antes de terminar, talvez por falta de memória.")
  expect(view?.hint).toBe("Envie a mensagem de novo para continuar. Se repetir, aumente a memória da máquina.")
  expect(view?.code).not.toBe("")
})
