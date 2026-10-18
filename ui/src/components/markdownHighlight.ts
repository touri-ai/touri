import { syntaxTheme } from "./syntaxTheme"

export const getMarkdownCodeHtml = async (source: string, language: string): Promise<string | null> => {
  const [core, { createJavaScriptRegexEngine }, { bundledLanguages }] = await Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    import("shiki/langs"),
  ])
  const getLanguage = Object.hasOwn(bundledLanguages, language)
    ? bundledLanguages[language as keyof typeof bundledLanguages]
    : undefined
  if (!getLanguage && !core.isSpecialLang(language)) return null

  const highlighter = await core.createHighlighterCore({
    engine: createJavaScriptRegexEngine(),
    langs: getLanguage ? [getLanguage] : [],
    themes: [syntaxTheme],
  })

  // Keep compiled grammars and regex caches scoped to rendering, never to the conversation's lifetime.
  try {
    return highlighter.codeToHtml(source, { lang: language || "text", theme: syntaxTheme.name })
  } finally {
    highlighter.dispose()
  }
}
