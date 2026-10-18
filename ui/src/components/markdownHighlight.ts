import type { HighlighterCore, LanguageInput } from "shiki/core"
import { syntaxTheme } from "./syntaxTheme"

type Engine = Pick<HighlighterCore, "codeToHtml" | "loadLanguage" | "getLoadedLanguages" | "dispose">
type Grammar = { name: string; load: LanguageInput }
type Options = {
  createEngine?: () => Promise<Engine>
  getGrammar?: (language: string) => Promise<Grammar | undefined>
  idleMs?: number
  maxLanguages?: number
}

/** Mutable grammar registries must be recycled between requests, without racing visible fences. */
export const createMarkdownHighlighter = ({
  createEngine = createEngineWithoutWasm,
  getGrammar = getMarkdownGrammar,
  idleMs = 5_000,
  maxLanguages = 8,
}: Options = {}) => {
  // Only the registry is cached; settled queue entries keep no source or rendered HTML.
  let engine: Engine | undefined
  let work = Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | undefined

  const dispose = () => {
    engine?.dispose()
    engine = undefined
  }
  const highlight = async (source: string, language: string, signal?: AbortSignal) => {
    if (signal?.aborted || source.length > 50_000) return undefined

    const grammar = await getGrammar(language)
    if (!grammar || signal?.aborted) return undefined

    clearTimeout(timer)
    try {
      const loaded = engine?.getLoadedLanguages() ?? []
      if (!loaded.includes(grammar.name) && loaded.length >= maxLanguages) dispose()
      engine ??= await createEngine()
      if (signal?.aborted) return undefined

      await engine.loadLanguage(grammar.load)
      return engine.codeToHtml(source, { lang: grammar.name, theme: syntaxTheme.name })
    } finally {
      if (engine) timer = setTimeout(dispose, idleMs)
    }
  }

  return {
    highlight: (source: string, language: string, signal?: AbortSignal) => {
      const result = work.then(() => highlight(source, language, signal))
      work = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    },
  }
}

const createEngineWithoutWasm = async (): Promise<Engine> => {
  const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
  ])
  return createHighlighterCore({ engine: createJavaScriptRegexEngine(), langs: [], themes: [syntaxTheme] })
}

const getMarkdownGrammar = async (language: string): Promise<Grammar | undefined> => {
  if (["", "text", "txt", "plain", "plaintext"].includes(language.toLowerCase())) return undefined

  const { bundledLanguagesInfo } = await import("shiki/langs")
  const grammar = bundledLanguagesInfo.find((grammar) => grammar.id === language || grammar.aliases?.includes(language))
  return grammar ? { name: grammar.id, load: grammar.import } : undefined
}

const markdownHighlighter = createMarkdownHighlighter()
export const highlightMarkdownCode = (source: string, language: string, signal?: AbortSignal) =>
  markdownHighlighter.highlight(source, language, signal)
