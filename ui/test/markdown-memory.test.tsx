import { cleanup, render, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { MarkdownContent } from "../src/components/MarkdownContent"
import { createMarkdownHighlighter } from "../src/components/markdownHighlight"

const bundledEngine = vi.hoisted(() => vi.fn())
vi.mock("shiki", async (original) => {
  bundledEngine()
  return original()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const getGrammar = async (language: string) => ({ name: language, load: [] })
const makeEngine = () => {
  let languages: string[] = []
  return {
    dispose: vi.fn(),
    codeToHtml: vi.fn((source: string) => source),
    getLoadedLanguages: () => languages,
    loadLanguage: vi.fn(async () => {
      languages = [...languages, `language-${languages.length}`]
    }),
  }
}

it("releases compiled grammars after idle while leaving rendered code on screen", async () => {
  vi.useFakeTimers()
  const engine = makeEngine()
  const highlighter = createMarkdownHighlighter({ createEngine: async () => engine, getGrammar })

  const html = await highlighter.highlight("const sample = 42", "typescript")
  await vi.advanceTimersByTimeAsync(5_000)

  expect(html).toBe("const sample = 42")
  expect(engine.dispose).toHaveBeenCalledOnce()
})

it("recycles the registry before loading more languages and recreates it after idle", async () => {
  vi.useFakeTimers()
  const createEngine = vi.fn(async () => makeEngine())
  const highlighter = createMarkdownHighlighter({ createEngine, getGrammar, maxLanguages: 2 })

  await highlighter.highlight("first", "first")
  await highlighter.highlight("second", "second")
  await highlighter.highlight("third", "third")
  await vi.advanceTimersByTimeAsync(5_000)
  await highlighter.highlight("fourth", "fourth")

  expect(createEngine).toHaveBeenCalledTimes(3)
  expect((await createEngine.mock.results[0]?.value)?.dispose).toHaveBeenCalledOnce()
})

it("does not create an engine for plain text or unknown languages", async () => {
  const createEngine = vi.fn(async () => makeEngine())
  const highlighter = createMarkdownHighlighter({ createEngine })

  const plain = await highlighter.highlight("<script>literal</script>", "text")
  const unknown = await highlighter.highlight("literal", "unrecognized-example-language")

  expect(plain).toBeUndefined()
  expect(unknown).toBeUndefined()
  expect(createEngine).not.toHaveBeenCalled()
})

it("does not extend a grammar cache's lifetime for plain text updates", async () => {
  vi.useFakeTimers()
  const engine = makeEngine()
  const highlighter = createMarkdownHighlighter({
    createEngine: async () => engine,
    getGrammar: async (language) => (language === "text" ? undefined : getGrammar(language)),
  })

  await highlighter.highlight("const sample = 42", "typescript")
  await vi.advanceTimersByTimeAsync(4_999)
  await highlighter.highlight("a streaming plain text update", "text")
  await vi.advanceTimersByTimeAsync(1)

  expect(engine.dispose).toHaveBeenCalledOnce()
})

it("skips abandoned updates and oversized fences without retaining an engine", async () => {
  const createEngine = vi.fn(async () => makeEngine())
  const highlighter = createMarkdownHighlighter({ createEngine, getGrammar })
  const controller = new AbortController()
  controller.abort()

  const abandoned = await highlighter.highlight("abandoned", "typescript", controller.signal)
  const large = await highlighter.highlight("x".repeat(50_001), "typescript")

  expect(abandoned).toBeUndefined()
  expect(large).toBeUndefined()
  expect(createEngine).not.toHaveBeenCalled()
})

it("serializes grammar loads and recovers after a failed load", async () => {
  vi.useFakeTimers()
  const engine = makeEngine()
  engine.loadLanguage.mockRejectedValueOnce(new Error("Unsupported grammar"))
  const highlighter = createMarkdownHighlighter({ createEngine: async () => engine, getGrammar })

  const failed = highlighter.highlight("invalid", "invalid")
  const next = highlighter.highlight("valid", "valid")

  await expect(failed).rejects.toThrow("Unsupported grammar")
  await expect(next).resolves.toBe("valid")
  expect(engine.codeToHtml).toHaveBeenCalledOnce()
})

it("renders aliases without a WebAssembly engine and preserves unknown code literally", async () => {
  const view = render(
    <MarkdownContent
      content={'```js\nconst sample = "exemplo"\n```\n\n```unknown-example\n<img src=x onerror=alert(1)>\n```'}
    />,
  )

  await waitFor(() => expect(view.container.querySelector(".markdown-highlight .shiki")).not.toBeNull())

  expect(view.container).toHaveTextContent('const sample = "exemplo"')
  expect(view.container).toHaveTextContent("<img src=x onerror=alert(1)>")
  expect(view.container.querySelector("img,script")).toBeNull()
  expect(bundledEngine).not.toHaveBeenCalled()
})

it("releases the previous markup when a fence switches to an unsupported language", async () => {
  const view = render(<MarkdownContent content={"```js\nconst previous = 1\n```"} />)
  await waitFor(() => expect(view.container.querySelector(".markdown-highlight")).not.toBeNull())

  view.rerender(<MarkdownContent content={"```unrecognized-example\nnew source <tag>\n```"} />)

  await waitFor(() => expect(view.container.querySelector(".markdown-highlight")).toBeNull())
  expect(view.container).toHaveTextContent("new source <tag>")
  expect(view.container).not.toHaveTextContent("const previous = 1")
})
