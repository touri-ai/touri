import { invoke } from "@tauri-apps/api/core"
import { isValidElement, lazy, type ReactNode, Suspense, useContext, useEffect, useMemo, useRef, useState } from "react"
import type { Components } from "react-markdown"
import { localFileLinks, localFilePath } from "../messageMarkdown"
import { protectDiffFences } from "./codeFence"
import { DiffOutput } from "./DiffOutput"
import { EvidenceContext, type EvidenceContextValue, EvidenceGallery } from "./EvidenceGallery"
import { type EvidenceNode, evidenceImages } from "./evidenceMarkdown"
import { LocalFileLink } from "./LocalFileLink"
import { syntaxTheme } from "./syntaxTheme"

type MarkdownRendererProps = {
  content: string
  compact?: boolean
  preview?: boolean
  evidence?: EvidenceContextValue | undefined
}

type PreviewNode = { type: string; value?: string; children?: PreviewNode[] }
// Trim parsed Markdown nodes so a preview never leaves a broken fence, link or emphasis marker.
const chatPreview = () => (tree: PreviewNode) => {
  let remaining = 1200
  let truncated = false
  const trim = (node: PreviewNode): void => {
    if (node.value) {
      const value = node.type === "code" ? node.value.split("\n").slice(0, 8).join("\n") : node.value
      truncated ||= value !== node.value || value.length > remaining
      node.value = value.length > remaining ? `${value.slice(0, remaining).trimEnd()}…` : value
      remaining = Math.max(0, remaining - value.length)
    }
    if (node.children) {
      const limit = node.type === "root" ? 4 : node.type === "list" ? 6 : node.type === "table" ? 4 : Infinity
      const omitted = node.children.length > limit
      node.children = node.children.slice(0, limit).filter((child) => {
        if (remaining === 0 || truncated) return false
        trim(child)
        return true
      })
      truncated ||= omitted
    }
  }
  trim(tree)
}

const LazyMarkdown = lazy(async () => {
  const [
    { default: ReactMarkdown, defaultUrlTransform },
    { default: remarkGfm },
    { unified },
    { default: remarkParse },
  ] = await Promise.all([import("react-markdown"), import("remark-gfm"), import("unified"), import("remark-parse")])
  const buildComponents = (preview: boolean): Components => ({
    img: ({ alt }) => <span>{alt}</span>,
    a: ({ href, children }) => {
      const path = localFilePath(href ?? "")
      return path ? (
        <LocalFileLink path={path}>{children}</LocalFileLink>
      ) : (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => {
            if (!href || !/^https?:\/\//i.test(href) || !("__TAURI_INTERNALS__" in window)) return
            event.preventDefault()
            void invoke("open_external", { url: href }).catch(() => window.open(href, "_blank", "noopener,noreferrer"))
          }}
        >
          {children}
        </a>
      )
    },
    pre: ({ children }) => {
      if (!isValidElement<{ className?: string; children?: ReactNode }>(children)) return <pre>{children}</pre>
      const language = children.props.className?.replace(/^language-/, "") ?? "text"
      if (language === "diff") return <DiffOutput source={String(children.props.children ?? "").replace(/\n$/, "")} />
      return (
        <ShikiCode
          language={language}
          source={String(children.props.children ?? "").replace(/\n$/, "")}
          copyable={!preview}
        />
      )
    },
    table: ({ children }) => (
      // biome-ignore lint/a11y/noNoninteractiveTabindex: horizontal tables must be keyboard-scrollable.
      <section className="markdown-table" tabIndex={0} aria-label="Tabela da mensagem">
        <table>{children}</table>
      </section>
    ),
  })
  const fullComponents = buildComponents(false)
  const previewComponents = buildComponents(true)
  const fullPlugins = [remarkGfm, localFileLinks]
  const previewPlugins = [remarkGfm, chatPreview, localFileLinks]
  const Markdown = ({ content, preview }: MarkdownRendererProps) => {
    const evidence = useContext(EvidenceContext)
    const images = useMemo(() => {
      if (!evidence) return []
      const tree = unified().use(remarkParse).use(remarkGfm).parse(protectDiffFences(content)) as EvidenceNode
      if (preview) chatPreview()(tree)
      return evidenceImages(tree)
    }, [content, preview, evidence])
    return (
      <>
        <ReactMarkdown
          skipHtml
          urlTransform={(url, key) => (key === "href" && localFilePath(url) ? url : defaultUrlTransform(url))}
          remarkPlugins={preview ? previewPlugins : fullPlugins}
          components={preview ? previewComponents : fullComponents}
        >
          {protectDiffFences(content)}
        </ReactMarkdown>
        {images.length > 0 && <EvidenceGallery images={images} />}
      </>
    )
  }
  return { default: Markdown }
})

const ShikiCode = ({ language, source, copyable = true }: { language: string; source: string; copyable?: boolean }) => {
  const [html, setHtml] = useState<string | null>(null)
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle")
  const resetRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (resetRef.current) clearTimeout(resetRef.current)
    },
    [],
  )
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(source)
      setCopyState("copied")
    } catch {
      setCopyState("failed")
    }
    if (resetRef.current) clearTimeout(resetRef.current)
    resetRef.current = setTimeout(() => setCopyState("idle"), 2200)
  }

  useEffect(() => {
    let active = true
    void import("shiki")
      .then(async ({ codeToHtml }) => {
        const rendered = await codeToHtml(source, {
          lang: language || "text",
          theme: syntaxTheme,
        })
        if (active) setHtml(rendered)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [language, source])

  return (
    <div className="markdown-code">
      <div className="markdown-code-header">
        <span>{language === "text" ? "Texto" : language}</span>
        {copyable ? (
          <button type="button" onClick={() => void copy()} aria-label="Copiar código">
            {copyState === "copied" ? "Copiado" : "Copiar"}
          </button>
        ) : (
          <span>Prévia</span>
        )}
        <span className="visually-hidden" role="status">
          {copyState === "copied" ? "Código copiado" : copyState === "failed" ? "Não foi possível copiar o código" : ""}
        </span>
      </div>
      {html ? (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki generates this markup from a code block, not user HTML.
        <div className="markdown-highlight" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre>
          <code>{source}</code>
        </pre>
      )}
    </div>
  )
}

export const MarkdownContent = ({ content, compact = false, preview = false, evidence }: MarkdownRendererProps) => (
  <div className={`markdown-content${compact ? " markdown-compact" : ""}`}>
    <Suspense fallback={<p className="whitespace-pre-wrap">{preview ? content.slice(0, 600) : content}</p>}>
      {evidence ? (
        <EvidenceContext.Provider value={evidence}>
          <LazyMarkdown content={content} preview={preview} />
        </EvidenceContext.Provider>
      ) : (
        <LazyMarkdown content={content} preview={preview} />
      )}
    </Suspense>
  </div>
)
