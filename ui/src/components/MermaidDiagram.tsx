import { useEffect, useId, useRef, useState } from "react"
import { t } from "../i18n"
import "./mermaid.css"

type Theme = "dark" | "light"
type Diagram = { source: string; theme: Theme; svg?: string; failed?: boolean }

const currentTheme = (): Theme => (document.documentElement.dataset.theme === "light" ? "light" : "dark")

const DiagramSvg = ({ svg }: { svg: string }) => {
  const container = useRef<HTMLDivElement>(null)
  const descriptionId = useId()
  const [accessible, setAccessible] = useState({ title: "", description: "" })
  useEffect(() => {
    if (!container.current) return
    const shadow = container.current.shadowRoot ?? container.current.attachShadow({ mode: "open" })
    const template = document.createElement("template")
    // Only the renderer's sanitized SVG reaches this boundary; its CSS cannot affect the surrounding app.
    template.innerHTML = svg
    shadow.replaceChildren(template.content)
    const diagram = shadow.querySelector("svg")
    if (diagram) {
      setAccessible({
        title: diagram.querySelector("title")?.textContent ?? "",
        description: diagram.querySelector("desc")?.textContent ?? "",
      })
      const width = Number(
        diagram
          .getAttribute("viewBox")
          ?.trim()
          .split(/[\s,]+/)[2],
      )
      if (Number.isFinite(width) && width > 0) diagram.style.width = `${width}px`
      diagram.style.maxWidth = "none"
      diagram.style.height = "auto"
      diagram.style.display = "block"
      diagram.style.margin = "0 auto"
      diagram.setAttribute("aria-hidden", "true")
    }
  }, [svg])
  return (
    <>
      <div
        ref={container}
        className="mermaid-diagram"
        role="img"
        aria-label={accessible.title || t("Diagrama Mermaid")}
        aria-describedby={accessible.description ? descriptionId : undefined}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: wide diagrams must be keyboard-scrollable.
        tabIndex={0}
      />
      {accessible.description && (
        <span id={descriptionId} className="visually-hidden">
          {accessible.description}
        </span>
      )}
    </>
  )
}

export const MermaidDiagram = ({ source, copyable = true }: { source: string; copyable?: boolean }) => {
  const [theme, setTheme] = useState(currentTheme)
  const [diagram, setDiagram] = useState<Diagram>({ source, theme })
  const [showCode, setShowCode] = useState(false)
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle")
  const resetCopy = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentTheme()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    // Coalesce streamed fence updates rather than lay out a new graph for every token.
    const timer = setTimeout(() => {
      void import("./mermaidRenderer")
        .then(({ renderMermaid }) => renderMermaid(source, theme, controller.signal))
        .then((svg) => {
          if (!controller.signal.aborted && svg) setDiagram({ source, theme, svg })
        })
        .catch(() => {
          if (!controller.signal.aborted) setDiagram({ source, theme, failed: true })
        })
    }, 150)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [source, theme])

  useEffect(
    () => () => {
      if (resetCopy.current) clearTimeout(resetCopy.current)
    },
    [],
  )

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(source)
      setCopyState("copied")
    } catch {
      setCopyState("failed")
      setShowCode(true)
    }
    if (resetCopy.current) clearTimeout(resetCopy.current)
    resetCopy.current = setTimeout(() => setCopyState("idle"), 2200)
  }

  const current = diagram.source === source && diagram.theme === theme
  const svg = current ? diagram.svg : undefined
  const failed = current && diagram.failed

  return (
    <section className="markdown-code mermaid-block" data-diagram-theme={theme}>
      <div className="markdown-code-header">
        <span>Mermaid</span>
        <div className="mermaid-actions">
          {svg && (
            <button type="button" aria-expanded={showCode} onClick={() => setShowCode(!showCode)}>
              {showCode ? t("Ver diagrama") : t("Ver código")}
            </button>
          )}
          {copyable && (
            <button type="button" onClick={() => void copy()} aria-label={t("Copiar código")}>
              {copyState === "copied" ? t("Código copiado.") : t("Copiar código")}
            </button>
          )}
        </div>
      </div>
      <span className="visually-hidden" role="status">
        {copyState === "copied"
          ? t("Código copiado.")
          : copyState === "failed"
            ? t("Não foi possível copiar. Selecione e copie o código acima.")
            : ""}
      </span>
      {!svg && !failed && (
        <p className="mermaid-notice" role="status">
          {t("Preparando diagrama…")}
        </p>
      )}
      {failed && (
        <p className="mermaid-notice" role="status">
          {t("Não foi possível renderizar o diagrama. O código está abaixo.")}
        </p>
      )}
      {svg && !showCode && <DiagramSvg svg={svg} />}
      {(showCode || failed) && (
        <pre>
          <code>{source}</code>
        </pre>
      )}
    </section>
  )
}
