import { render, screen, waitFor } from "@testing-library/react"
import type { Message } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import { VirtualMessageList } from "../src/components/ChatPanel"
import { MarkdownContent } from "../src/components/MarkdownContent"

const parsedLengths = vi.hoisted(() => [] as number[])
vi.mock("react-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-markdown")>()
  const Recorded = (props: Parameters<typeof actual.default>[0]) => {
    parsedLengths.push(String(props.children ?? "").length)
    return actual.default(props)
  }
  return { ...actual, default: Recorded }
})

afterEach(() => {
  vi.restoreAllMocks()
  parsedLengths.length = 0
})

const longAnswer = [
  "Aqui está o roteiro fictício completo:\n\n",
  ...Array.from(
    { length: 60 },
    (_, index) =>
      `${index + 1}. **Etapa ${index + 1}:** revise o item ${index + 1} com calma. Depois confirme o horário.\n`,
  ),
].join("")

it("a growing streamed reply reparses only its last block on each update", async () => {
  const view = render(<MarkdownContent content={longAnswer.slice(0, 4_000)} streaming />)
  await screen.findByText(/Etapa 20:/)
  parsedLengths.length = 0

  view.rerender(<MarkdownContent content={longAnswer.slice(0, 4_400)} streaming />)
  await waitFor(() => expect(parsedLengths.length).toBeGreaterThan(0))

  // Finished blocks keep their text, so only the block still receiving text is parsed again.
  expect(Math.max(...parsedLengths)).toBeLessThan(1_500)
  view.rerender(<MarkdownContent content={longAnswer} streaming={false} />)
  await screen.findByText(/Etapa 60:/)
})

it("rendering messages that did not fail builds no date strings for failure labels", () => {
  const messages: Message[] = Array.from({ length: 20 }, (_, index) => ({
    id: `message-${index}`,
    threadId: "thread",
    parentId: index ? `message-${index - 1}` : null,
    role: index % 2 ? "assistant" : "user",
    kind: "text",
    status: "complete",
    runId: null,
    text: `Mensagem ${index}`,
    parts: [{ type: "text", text: `Mensagem ${index}` }],
    sender: null,
    source: "local",
    createdAt: 1_700_000_000_000 + index,
    updatedAt: 1_700_000_000_000 + index,
  }))
  const dates = vi.spyOn(Date.prototype, "toLocaleDateString")
  const times = vi.spyOn(Date.prototype, "toLocaleTimeString")

  render(<VirtualMessageList messages={messages} onSwitchBranch={vi.fn()} onRetry={vi.fn(async () => {})} />)

  expect(dates).not.toHaveBeenCalled()
  expect(times).not.toHaveBeenCalled()
})
