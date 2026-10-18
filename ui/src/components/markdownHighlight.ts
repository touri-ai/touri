import { syntaxTheme } from "./syntaxTheme"

export const getMarkdownCodeHtml = async (source: string, language: string): Promise<string> => {
  const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, { bundledLanguages }] = await Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    import("shiki/langs"),
  ])
  const getLanguage = Object.hasOwn(bundledLanguages, language)
    ? bundledLanguages[language as keyof typeof bundledLanguages]
    : undefined
  const hasGrammar = Boolean(getLanguage) || language === "ansi"
  const highlighter = await createHighlighterCore({
    engine: createJavaScriptRegexEngine(),
    langs: getLanguage ? [getLanguage] : [],
    themes: [syntaxTheme],
  })

  // Keep compiled grammars and regex caches scoped to rendering, never to the conversation's lifetime.
  try {
    return highlighter.codeToHtml(source, { lang: hasGrammar ? language : "text", theme: syntaxTheme.name })
  } finally {
    highlighter.dispose()
  }
}
