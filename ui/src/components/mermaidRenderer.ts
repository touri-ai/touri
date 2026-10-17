import mermaid from "mermaid"
import { sanitizeMermaidSvg } from "./mermaidSvg"

let nextDiagram = 0
let rendering = Promise.resolve()

/** Mermaid has global configuration; serialize initialization with rendering so themes cannot race. */
export const renderMermaid = (source: string, theme: "dark" | "light", signal?: AbortSignal): Promise<string> => {
  const result = rendering.then(async () => {
    const checkCanceled = () => {
      if (signal?.aborted) throw new DOMException("Diagram render canceled", "AbortError")
    }
    checkCanceled()
    if (!source.trim() || source.length > 40_000) throw new Error("Unsupported diagram size")
    // Reject resource-bearing syntax before Mermaid creates its temporary layout DOM.
    const normalized = source.replace(/\/\*[\s\S]*?\*\//g, "")
    if (
      /(?:<|&lt;|#60;)\s*(?:img|image|iframe|object|embed|link|script)\b|\b(?:img|image)\s*:|url\s*\(|@import/i.test(
        normalized,
      ) ||
      /(?:^|[\n;])\s*(?:classDef|style|linkStyle)\b[^\n]*\\/i.test(normalized)
    )
      throw new Error("Unsupported diagram resource")
    await document.fonts?.ready
    checkCanceled()
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      htmlLabels: false,
      layout: "dagre",
      theme: theme === "dark" ? "dark" : "default",
      fontFamily: "DM Sans, sans-serif",
      maxTextSize: 40_000,
      maxEdges: 500,
      flowchart: { htmlLabels: false, useMaxWidth: true },
      secure: [
        "secure",
        "securityLevel",
        "startOnLoad",
        "suppressErrorRendering",
        "maxTextSize",
        "maxEdges",
        "htmlLabels",
        "flowchart",
        "layout",
        "theme",
        "themeCSS",
        "themeVariables",
        "fontFamily",
        "dompurifyConfig",
      ],
    })
    const container = document.createElement("div")
    container.style.cssText = "position:absolute;left:-10000px;top:0;visibility:hidden;pointer-events:none"
    document.body.appendChild(container)
    try {
      // A new ID also avoids replacing a diagram already displayed elsewhere in the transcript.
      const { svg } = await mermaid.render(`touri-diagram-${++nextDiagram}`, source, container)
      return sanitizeMermaidSvg(svg)
    } finally {
      container.remove()
    }
  })
  rendering = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}
