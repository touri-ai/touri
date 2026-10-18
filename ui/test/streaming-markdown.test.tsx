import { act, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MarkdownContent } from "../src/components/MarkdownContent"
import { getMarkdownCodeHtml } from "../src/components/markdownHighlight"
import { useStreamingContent } from "../src/components/useStreamingContent"

vi.mock("../src/components/markdownHighlight", () => ({
  getMarkdownCodeHtml: vi.fn(async () => '<pre class="shiki"><code>const total = 2</code></pre>'),
}))
vi.mock("../src/components/MermaidDiagram", () => ({
  MermaidDiagram: () => <div data-testid="finished-diagram" />,
}))

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe("streaming Markdown", () => {
  it("keeps the latest text at a bounded cadence without waiting for the stream to stop", () => {
    vi.useFakeTimers()
    const view = render(<StreamingText content="Início" streaming />)

    view.rerender(<StreamingText content="Início de" streaming />)
    act(() => vi.advanceTimersByTime(50))
    view.rerender(<StreamingText content="Início de uma resposta" streaming />)

    expect(screen.getByTestId("text")).toHaveTextContent(/^Início$/)

    act(() => vi.advanceTimersByTime(50))

    expect(screen.getByTestId("text")).toHaveTextContent("Início de uma resposta")
  })

  it("flushes the exact final text on completion or cancellation and releases pending work", () => {
    vi.useFakeTimers()
    const view = render(<StreamingText content="Parcial" streaming />)

    view.rerender(<StreamingText content="Resposta completa" streaming={false} />)

    expect(screen.getByTestId("text")).toHaveTextContent("Resposta completa")
    expect(vi.getTimerCount()).toBe(0)

    view.rerender(<StreamingText content="Outra resposta" streaming />)
    view.unmount()

    expect(vi.getTimerCount()).toBe(0)
  })

  it("keeps code copyable while streaming and highlights only after completion", async () => {
    const content = "```typescript\nconst total = 2\n```"
    const view = render(<MarkdownContent content={content} streaming />)

    expect(await screen.findByRole("button", { name: "Copiar código" })).toBeVisible()
    expect(view.container.querySelector("code")).toHaveTextContent("const total = 2")
    expect(getMarkdownCodeHtml).not.toHaveBeenCalled()

    view.rerender(<MarkdownContent content={content} streaming={false} />)

    await waitFor(() => expect(getMarkdownCodeHtml).toHaveBeenCalledTimes(1))
    expect(view.container.querySelector(".shiki")).not.toBeNull()
  })

  it("defers diagram rendering until the final source is available", async () => {
    const content = "```mermaid\ngraph TD\nA --> B\n```"
    const view = render(<MarkdownContent content={content} streaming />)

    expect(await screen.findByText(/A --> B/)).toBeVisible()
    expect(screen.queryByTestId("finished-diagram")).toBeNull()

    view.rerender(<MarkdownContent content={content} streaming={false} />)

    expect(await screen.findByTestId("finished-diagram")).toBeVisible()
  })
})

const StreamingText = ({ content, streaming }: { content: string; streaming: boolean }) => (
  <p data-testid="text">{useStreamingContent(content, streaming)}</p>
)
