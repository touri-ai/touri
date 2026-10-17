import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { Message } from "@touri/contracts"
import { describe, expect, it, vi } from "vitest"
import { VirtualMessageList } from "../src/components/ChatPanel"
import { MarkdownContent } from "../src/components/MarkdownContent"

const message = (overrides: Partial<Message> = {}): Message => ({
  id: "chat-r8",
  threadId: "thread-r8",
  parentId: null,
  role: "assistant",
  kind: "text",
  status: "complete",
  runId: null,
  text: "",
  parts: [],
  sender: null,
  source: "local",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...overrides,
})
const renderMessages = (messages: Message[]) =>
  render(<VirtualMessageList messages={messages} onSwitchBranch={vi.fn()} onRetry={vi.fn(async () => {})} />)

describe("r8 chat reading", () => {
  it("renders every text part and keeps reasoning in one accessible activity disclosure", async () => {
    renderMessages([
      message({
        createdAt: 1,
        updatedAt: 1,
        parts: [
          { type: "reasoning", text: "**Plano**\n\n- Conferir a leitura" },
          { type: "text", text: "## Resultado\n\n" },
          { type: "text", text: "**Texto completo**" },
        ],
      }),
    ])
    expect(await screen.findByRole("heading", { name: "Resultado" })).toBeVisible()
    expect(screen.getByText("Texto completo", { selector: "strong" })).toBeVisible()
    const toggle = screen.getByRole("button", { name: "Atividade" })
    expect(toggle).toHaveClass("turn-activity-toggle")
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(toggle.getAttribute("aria-controls")).toBeTruthy()
    expect(screen.queryByText("Plano", { selector: "strong" })).toBeNull()
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(await screen.findByText("Plano", { selector: "strong" })).toBeVisible()
  })

  it("collapses only completed long replies and preserves Markdown in the preview", async () => {
    const text = `## Revisão\n\n${Array.from({ length: 65 }, (_, index) => `${index + 1}. **Fluxo ${index + 1}**`).join("\n")}`
    const view = renderMessages([message({ text })])
    const toggle = screen.getByRole("button", { name: "Mostrar mais" })
    expect(await screen.findByRole("heading", { name: "Revisão" })).toBeVisible()
    expect(screen.queryByText("Fluxo 65", { selector: ".chat-message-preview strong" })).toBeNull()
    fireEvent.click(toggle)
    expect(screen.getByRole("button", { name: "Mostrar menos" })).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("Fluxo 65", { selector: "strong" })).toBeVisible()
    view.rerender(
      <VirtualMessageList
        messages={[message({ text, status: "streaming" })]}
        onSwitchBranch={vi.fn()}
        onRetry={vi.fn(async () => {})}
      />,
    )
    expect(screen.queryByRole("button", { name: "Mostrar mais" })).toBeNull()
    expect(screen.getByText("Fluxo 65", { selector: "strong" })).toBeVisible()
  })

  it("keeps cancellation with author and time, and separates calendar days without duplicate times", async () => {
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const view = renderMessages([
      message({ id: "older", createdAt: yesterday.getTime(), text: "Resposta parcial", status: "canceled" }),
      message({ id: "today", text: "Próximo passo" }),
    ])
    expect(screen.getByText("Ontem")).toBeVisible()
    expect(screen.getByText("Hoje")).toBeVisible()
    const meta = view.container.querySelector('[data-message-id="older"] .message-meta')
    expect(meta).toHaveTextContent("Cancelado")
    expect(meta?.querySelector("time")).toHaveAttribute("dateTime")
    expect(await screen.findByText("Resposta parcial")).toBeVisible()
  })

  it("offers a return to the latest reply without interrupting manual reading", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1600)
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400)
    const first = message({ text: "Histórico" })
    const props = { onSwitchBranch: vi.fn(), onRetry: vi.fn(async () => {}) }
    const view = render(<VirtualMessageList {...props} messages={[first]} />)
    const list = screen.getByTestId("virtual-message-list")
    list.scrollTop = 100
    fireEvent.scroll(list)
    view.rerender(<VirtualMessageList {...props} messages={[first, message({ id: "new", text: "Resposta final" })]} />)
    expect(list.scrollTop).toBe(100)
    fireEvent.click(screen.getByRole("button", { name: "1 nova mensagem" }))
    expect(list.scrollTop).toBe(1200)
    expect(screen.queryByRole("button", { name: /nova mensagem/ })).toBeNull()
    vi.restoreAllMocks()
  })
})

describe("r8 Markdown code", () => {
  it("copies unlabeled fenced code exactly, and avoids nested pre elements", async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
    const view = render(<MarkdownContent content={"```\nlinha um\nlinha dois\n```\n\nUse `arquivo.ts`."} />)
    fireEvent.click(await screen.findByRole("button", { name: "Copiar código" }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("linha um\nlinha dois"))
    expect(view.container.querySelector("pre pre")).toBeNull()
    expect(screen.getByText("Texto")).toBeVisible()
    expect(await screen.findByText("Código copiado")).toBeInTheDocument()
    expect(screen.getByText("arquivo.ts", { selector: "code" })).toBeVisible()
  })

  it("requires expanding a code preview before copying the complete source", async () => {
    const source = Array.from({ length: 60 }, (_, index) => `linha ${index + 1}`).join("\n")
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
    renderMessages([message({ text: `\`\`\`\n${source}\n\`\`\`` })])
    expect(await screen.findByText("Prévia")).toBeVisible()
    expect(screen.queryByRole("button", { name: "Copiar código" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Mostrar mais" }))
    fireEvent.click(await screen.findByRole("button", { name: "Copiar código" }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(source))
  })

  it("reports clipboard failure while keeping the code available", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn(async () => {
          throw new Error("negado")
        }),
      },
    })
    render(<MarkdownContent content={"```linguagem-desconhecida\nconteúdo legível\n```"} />)
    fireEvent.click(await screen.findByRole("button", { name: "Copiar código" }))
    expect(await screen.findByText("Não foi possível copiar o código")).toBeInTheDocument()
    expect(
      within(screen.getByText("conteúdo legível", { selector: "code" })).getByText("conteúdo legível"),
    ).toBeVisible()
  })
})
