import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MarkdownContent } from "../src/components/MarkdownContent"
import { MermaidDiagram } from "../src/components/MermaidDiagram"
import { sanitizeMermaidSvg } from "../src/components/mermaidSvg"
import { dictionaries } from "../src/i18n"

const renderer = vi.hoisted(() => ({ loaded: vi.fn(), render: vi.fn() }))
vi.mock("../src/components/mermaidRenderer", () => {
  renderer.loaded()
  return { renderMermaid: renderer.render }
})
vi.mock("shiki", () => ({ codeToHtml: vi.fn(async () => "<pre><code>code</code></pre>") }))

const source = "flowchart LR\n  A[Pedido] --> B[Resposta]"
const svg = (text = "Resposta") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 80"><text>${text}</text></svg>`
const diagramText = () => screen.queryByRole("img", { name: "Diagrama Mermaid" })?.shadowRoot?.textContent

beforeEach(() => {
  document.documentElement.dataset.theme = "dark"
  renderer.render.mockReset().mockImplementation(async () => svg())
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => {}) } })
})
afterEach(() => {
  cleanup()
  delete document.documentElement.dataset.theme
})

describe("Mermaid fences", () => {
  it("loads the renderer only when Markdown contains a Mermaid fence", async () => {
    const view = render(<MarkdownContent content="Resposta sem diagramas." />)
    await screen.findByText("Resposta sem diagramas.")
    expect(renderer.loaded).not.toHaveBeenCalled()
    expect(renderer.render).not.toHaveBeenCalled()
    view.rerender(<MarkdownContent content={`Antes.\n\n\`\`\`mermaid\n${source}\n\`\`\`\n\nDepois.`} />)
    await waitFor(() => expect(diagramText()).toBe("Resposta"))
    expect(renderer.render).toHaveBeenCalledWith(source, "dark", expect.any(AbortSignal))
    expect(screen.getByText("Antes.")).toBeVisible()
    expect(screen.getByText("Depois.")).toBeVisible()
  })

  it("shows a diagram, exposes the original code on demand and copies it exactly", async () => {
    const view = render(<MermaidDiagram source={source} />)
    await waitFor(() => expect(diagramText()).toBe("Resposta"))
    expect(view.container.querySelector("pre")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Ver código" }))
    expect(view.container.querySelector("pre code")?.textContent).toBe(source)
    fireEvent.click(screen.getByRole("button", { name: "Copiar código" }))
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(source))
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Código copiado."))
    fireEvent.click(screen.getByRole("button", { name: "Ver diagrama" }))
    await waitFor(() => expect(diagramText()).toBe("Resposta"))
  })

  it("leaves diagram fences as code in message previews", async () => {
    const view = render(<MarkdownContent content={`\`\`\`mermaid\n${source}\n\`\`\``} preview />)
    await waitFor(() => expect(view.container.querySelector("pre code")).not.toBeNull())
    expect(screen.queryByRole("img")).toBeNull()
    expect(renderer.render).not.toHaveBeenCalled()
  })

  it("recognizes mixed-case diagram fences", async () => {
    render(<MarkdownContent content={`\`\`\`Mermaid\n${source}\n\`\`\``} />)
    await waitFor(() => expect(diagramText()).toBe("Resposta"))
    expect(renderer.render).toHaveBeenCalledWith(source, "dark", expect.any(AbortSignal))
  })

  it("rerenders existing diagrams when the app theme changes", async () => {
    render(<MermaidDiagram source={source} />)
    await waitFor(() => expect(diagramText()).toBe("Resposta"))
    document.documentElement.dataset.theme = "light"
    await waitFor(() => expect(renderer.render).toHaveBeenLastCalledWith(source, "light", expect.any(AbortSignal)))
    await waitFor(() => expect(diagramText()).toBe("Resposta"))
  })

  it("ignores stale async renders after the source changes", async () => {
    let finishOld: ((value: string) => void) | undefined
    renderer.render.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finishOld = resolve
        }),
    )
    const view = render(<MermaidDiagram source={source} />)
    await waitFor(() => expect(finishOld).toBeDefined())
    view.rerender(<MermaidDiagram source="flowchart LR\n  A --> C" />)
    await waitFor(() => expect(diagramText()).toBe("Resposta"))
    finishOld?.(svg("Antigo"))
    await waitFor(() => expect(diagramText()).toBe("Resposta"))
  })

  it("falls back to literal code on render error and reports clipboard failures", async () => {
    renderer.render.mockRejectedValueOnce(new Error("syntax error"))
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error("permission denied"))
    const view = render(<MermaidDiagram source={source} />)
    await screen.findByText("Não foi possível renderizar o diagrama. O código está abaixo.")
    expect(view.container.querySelector("pre code")?.textContent).toBe(source)
    expect(screen.queryByRole("button", { name: "Ver código" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Copiar código" }))
    await screen.findByText("Não foi possível copiar. Selecione e copie o código acima.")
  })

  it("has Portuguese and English diagram strings", () => {
    for (const key of [
      "Diagrama Mermaid",
      "Preparando diagrama…",
      "Ver código",
      "Ver diagrama",
      "Não foi possível renderizar o diagrama. O código está abaixo.",
    ] as const) {
      expect(dictionaries["pt-BR"][key]).toBeTruthy()
      expect(dictionaries.en[key]).toBeTruthy()
    }
  })

  it("preserves an author's accessible diagram title and description", async () => {
    renderer.render.mockResolvedValueOnce(
      '<svg xmlns="http://www.w3.org/2000/svg"><title>Revisão das notas</title><desc>Do pedido até a resposta final.</desc><text>Resposta</text></svg>',
    )
    render(<MermaidDiagram source={source} />)
    const diagram = await screen.findByRole("img", { name: "Revisão das notas" })
    expect(diagram).toHaveAccessibleDescription("Do pedido até a resposta final.")
  })
})

describe("diagram SVG boundary", () => {
  it("removes executable content, HTML, images and external links but keeps local SVG markers", () => {
    const clean = sanitizeMermaidSvg(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
      <script>alert(1)</script><foreignObject><div>HTML</div></foreignObject>
      <image href="https://example.test/image.svg"/><a href="javascript:alert(1)"><text>link</text></a>
      <defs><marker id="arrow"><path d="M0 0L2 2"/></marker></defs>
      <path marker-end="url(#arrow)" d="M0 0L20 20"/>
      <use href="https://example.test/external.svg#remote"/>
    </svg>`)
    const document = new DOMParser().parseFromString(clean, "image/svg+xml")
    expect(document.querySelector("script, foreignObject, image, a")).toBeNull()
    expect(document.querySelector("svg")?.hasAttribute("onload")).toBe(false)
    expect(document.querySelector("path[marker-end]")?.getAttribute("marker-end")).toBe("url(#arrow)")
    expect(document.querySelector("use")?.hasAttribute("href")).not.toBe(true)
  })

  it("rejects styles that could load resources or escape CSS validation", () => {
    for (const style of [
      "@import 'https://example.test/style.css';",
      "path{fill:url(https://example.test/image.svg)}",
      "path{fill:u/**/rl(https://example.test/image.svg)}",
      "path{fill:u\\72l(https://example.test/image.svg)}",
    ]) {
      expect(() =>
        sanitizeMermaidSvg(`<svg xmlns="http://www.w3.org/2000/svg"><style>${style}</style></svg>`),
      ).toThrow()
    }
    expect(() => sanitizeMermaidSvg("<p>not an SVG</p>")).toThrow()
  })
})
