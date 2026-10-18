import { act, render, screen, waitFor } from "@testing-library/react"
import { StrictMode } from "react"
import remarkGfm from "remark-gfm"
import { afterEach, describe, expect, it, vi } from "vitest"
import { observeCodeVisibility } from "../src/components/codeVisibility"
import { MarkdownContent } from "../src/components/MarkdownContent"
import { getMarkdownCodeHtml } from "../src/components/markdownHighlight"
import { useStreamingContent } from "../src/components/useStreamingContent"

vi.mock("remark-gfm", async (importOriginal) => {
  const plugin = await importOriginal<{ default: typeof remarkGfm }>()

  return { default: vi.fn(plugin.default) }
})

vi.mock("../src/components/codeVisibility", () => ({
  observeCodeVisibility: vi.fn((_element: Element | null, show: () => void) => {
    show()
    return () => undefined
  }),
}))

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
  it("does not reparse unchanged Markdown when the surrounding presentation changes", async () => {
    const view = render(<MarkdownContent content="# Resposta salva" />)
    await screen.findByRole("heading", { name: "Resposta salva" })
    const parses = vi.mocked(remarkGfm).mock.calls.length

    view.rerender(<MarkdownContent content="# Resposta salva" compact />)

    expect(remarkGfm).toHaveBeenCalledTimes(parses)
  })

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

  it("continues painting after effects are replayed in strict mode", () => {
    vi.useFakeTimers()
    const view = render(
      <StrictMode>
        <StreamingText content="Início" streaming />
      </StrictMode>,
    )

    view.rerender(
      <StrictMode>
        <StreamingText content="Texto mais recente" streaming />
      </StrictMode>,
    )
    act(() => vi.advanceTimersByTime(100))

    expect(screen.getByTestId("text")).toHaveTextContent("Texto mais recente")
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

  it("keeps a long reply copyable without compiling hidden code until it becomes visible", async () => {
    const stop = vi.fn()
    vi.mocked(observeCodeVisibility).mockReturnValueOnce(stop)
    const content = `Exemplo longo.\n\n${"Texto de exemplo. ".repeat(250)}\n\n\`\`\`typescript\nconst total = 2\n\`\`\``
    const view = render(<MarkdownContent content={content} />)
    await screen.findByRole("button", { name: "Copiar código" })
    await waitFor(() => expect(observeCodeVisibility).toHaveBeenCalled())

    expect(view.container.querySelector("code")).toHaveTextContent("const total = 2")
    expect(getMarkdownCodeHtml).not.toHaveBeenCalled()

    act(() => vi.mocked(observeCodeVisibility).mock.calls.at(-1)?.[1]())

    await waitFor(() => expect(getMarkdownCodeHtml).toHaveBeenCalledTimes(1))

    view.unmount()

    expect(stop).toHaveBeenCalledOnce()
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
