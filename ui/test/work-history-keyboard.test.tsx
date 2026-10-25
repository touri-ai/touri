import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { Message } from "@touri/contracts"
import { afterEach, expect, test, vi } from "vitest"
import { VirtualMessageList } from "../src/components/ChatPanel"

afterEach(cleanup)

test("saved conversation history participates in sequential keyboard focus", async () => {
  const message: Message = {
    id: "saved-message",
    threadId: "saved-thread",
    parentId: null,
    role: "assistant",
    kind: "text",
    status: "complete",
    runId: null,
    text: "Resposta de exemplo salva.",
    parts: [{ type: "text", text: "Resposta de exemplo salva." }],
    sender: null,
    source: "local",
    createdAt: 1,
    updatedAt: 1,
  }
  const user = userEvent.setup()
  render(<VirtualMessageList messages={[message]} onSwitchBranch={vi.fn()} onRetry={vi.fn()} />)
  const history = screen.getByRole("region", { name: "Histórico da conversa" })

  await user.tab()

  expect(history).toHaveAttribute("tabindex", "0")
  expect(history).toHaveFocus()
})
