import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { Message } from "@touri/contracts"
import { afterEach, expect, it } from "vitest"
import { VirtualMessageList } from "../src/components/ChatPanel"
import { t } from "../src/i18n"

afterEach(cleanup)

it("keeps internal context restoration quiet while retaining localized diagnostics", () => {
  const text = "O contexto da conversa foi recuperado do histórico salvo."
  const message: Message = {
    id: "restored",
    threadId: "thread",
    parentId: null,
    role: "system",
    kind: "notice",
    status: "complete",
    runId: "run",
    text,
    parts: [{ type: "notice", code: "context_restored", level: "info", text }],
    sender: null,
    source: "local",
    createdAt: 1,
    updatedAt: 1,
  }
  render(<VirtualMessageList messages={[message]} onSwitchBranch={async () => {}} onRetry={async () => {}} />)
  expect(screen.queryByText(text)).toBeNull()
  expect(screen.queryByRole("button", { name: "Detalhes técnicos" })).toBeNull()
  expect(t(text, {}, "en")).toBe("The conversation context was restored from saved history.")
})

it("keeps provider session handoff notices in collapsed technical details", () => {
  const text = "The native provider session was replaced and a handoff was supplied."
  const message: Message = {
    id: "handoff",
    threadId: "thread",
    parentId: null,
    role: "system",
    kind: "notice",
    status: "complete",
    runId: "run",
    text,
    parts: [{ type: "notice", code: "session_replaced", level: "info", text }],
    sender: null,
    source: "local",
    createdAt: 1,
    updatedAt: 1,
  }
  render(<VirtualMessageList messages={[message]} onSwitchBranch={async () => {}} onRetry={async () => {}} />)
  expect(screen.queryByText("O contexto da conversa foi preservado para continuar no provedor.")).toBeNull()
  const details = screen.getByRole("button", { name: "Detalhes técnicos" })
  expect(details).toHaveAttribute("aria-expanded", "false")
  const content = document.getElementById(details.getAttribute("aria-controls") ?? "")
  expect(content).toHaveAttribute("aria-hidden", "true")
  expect(content).toHaveTextContent(text)
  fireEvent.click(details)
  expect(content).toHaveAttribute("aria-hidden", "false")
})
