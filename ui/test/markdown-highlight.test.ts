import type * as SyntaxCore from "shiki/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { getMarkdownCodeHtml } from "../src/components/markdownHighlight"

vi.mock("shiki/core", async (importOriginal) => {
  const core = await importOriginal<typeof SyntaxCore>()

  return { ...core, createHighlighterCore: vi.fn(core.createHighlighterCore) }
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe("message code highlighting", () => {
  it.each([
    ["typescript", "const total: number = 2"],
    ["js", 'console.log("exemplo")'],
    ["python", 'print("exemplo")'],
    ["json", '{"total": 2}'],
    ["bash", 'printf "%s" "$total"'],
    ["html", '<article class="exemplo">Olá</article>'],
    ["css", ".exemplo { color: red; }"],
    ["sql", "SELECT nome FROM exemplos;"],
    ["yaml", "total: 2"],
    ["rust", 'fn main() { println!("exemplo"); }'],
  ])("preserves and highlights %s without keeping a compiled grammar alive", async (language, source) => {
    const { createHighlighterCore } = await import("shiki/core")

    const html = await getMarkdownCodeHtml(source, language)
    const rendered = getRenderedCode(html)
    const highlighter = await vi.mocked(createHighlighterCore).mock.results.at(-1)?.value

    expect(rendered.textContent).toBe(source)
    expect(rendered.querySelector('span[style*="--syntax-"]')).not.toBeNull()
    expect(() => highlighter?.getLoadedLanguages()).toThrow("disposed")
  })

  it.each(["", "text", "plaintext"])(
    "renders %s as plain, escaped, copyable source",
    async (language) => {
      const source = '<script>alert("exemplo")</script>\n\n  & fim\n'

      const html = await getMarkdownCodeHtml(source, language)
      const rendered = getRenderedCode(html)

      expect(rendered.textContent).toBe(source)
      expect(rendered.querySelector("script")).toBeNull()
    },
  )

  it.each(["unknown-fixture-language", "constructor", "__proto__"])(
    "keeps the existing plain code fallback for %s without compiling a grammar",
    async (language) => {
      const { createHighlighterCore } = await import("shiki/core")

      const html = await getMarkdownCodeHtml("conteúdo legível", language)

      expect(html).toBeNull()
      expect(createHighlighterCore).not.toHaveBeenCalled()
    },
  )

  it("also disposes the highlighter when rendering fails", async () => {
    const { createHighlighterCore } = await import("shiki/core")
    const highlighter = await createHighlighterCore({
      engine: { createScanner: vi.fn(), createString: vi.fn() },
      langs: [],
      themes: [],
    })
    vi.spyOn(highlighter, "codeToHtml").mockImplementation(() => {
      throw new Error("Synthetic rendering failure")
    })
    vi.mocked(createHighlighterCore).mockResolvedValueOnce(highlighter)

    await expect(getMarkdownCodeHtml("exemplo", "text")).rejects.toThrow("Synthetic rendering failure")

    expect(() => highlighter.getLoadedLanguages()).toThrow("disposed")
  })

  it("retains ANSI coloring without loading a grammar", async () => {
    const source = "\u001b[31mexemplo\u001b[0m"

    const html = await getMarkdownCodeHtml(source, "ansi")
    const rendered = getRenderedCode(html)

    expect(rendered.textContent).toBe("exemplo")
    expect(rendered.querySelector("span[style]")).not.toBeNull()
  })
})

const getRenderedCode = (html: string | null): HTMLElement => {
  const rendered = document.createElement("div")
  rendered.innerHTML = html ?? ""

  return rendered
}
