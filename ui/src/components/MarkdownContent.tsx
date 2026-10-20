import { invoke } from "@tauri-apps/api/core"
import {
  createContext,
  isValidElement,
  lazy,
  memo,
  type ReactNode,
  Suspense,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import type { Components } from "react-markdown"
import { userFacingError } from "../errors"
import { localFileLinks, localFilePath } from "../messageMarkdown"
import { useSaveNotice } from "../useSaveNotice"
import { protectDiffFences } from "./codeFence"
import { observeCodeVisibility } from "./codeVisibility"
import { DiffOutput } from "./DiffOutput"
import { EvidenceContext, type EvidenceContextValue, EvidenceGallery, readImage } from "./EvidenceGallery"
import {
  decodedEvidencePath,
  type EvidenceImage,
  type EvidenceNode,
  evidenceImages,
  evidencePath,
} from "./evidenceMarkdown"
import { LocalFileLink } from "./LocalFileLink"
import { MermaidDiagram } from "./MermaidDiagram"
import { getMarkdownCodeHtml } from "./markdownHighlight"
import { useStreamingContent } from "./useStreamingContent"

type MarkdownRendererProps = {
  content: string
  compact?: boolean
  preview?: boolean
  streaming?: boolean
  evidence?: EvidenceContextValue | undefined
}

const CodeVisibilityContext = createContext(false)
const StreamingContext = createContext(false)

type PreviewNode = { type: string; value?: string; children?: PreviewNode[] }

const linkText = (children: ReactNode): string => {
  if (typeof children === "string") return children
  if (Array.isArray(children)) return children.map(linkText).join("")
  return isValidElement<{ children?: ReactNode }>(children) ? linkText(children.props.children) : ""
}

const MarkdownLink = ({ href, children }: { href?: string | undefined; children?: ReactNode }) => {
  const context = useContext(EvidenceContext)
  const { notice, saveImage } = useSaveNotice()
  const [error, setError] = useState("")
  const path = href
    ? (localFilePath(href) ?? decodedEvidencePath(href, /\b(baixar|download|save)\b/i.test(linkText(children))))
    : null
  if (context && path && evidencePath(path)) {
    const filename = path.split("/").at(-1) || "Arquivo"
    const download = async () => {
      setError("")
      try {
        await saveImage(() => readImage({ path, filename, caption: filename }, context), filename)
      } catch (reason) {
        setError(userFacingError(reason))
      }
    }
    return (
      <>
        <button type="button" className="text-button" onClick={() => void download()}>
          {children}
        </button>
        {(error || notice) && <span role="status">{error || notice}</span>}
      </>
    )
  }
  if (path)
    return (
      <LocalFileLink path={path.startsWith("/") ? path : [context?.base, path].filter(Boolean).join("/")}>
        {children}
      </LocalFileLink>
    )
  return (
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
}
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

const MarkdownCodeBlock = ({ children, preview }: { children: ReactNode; preview: boolean }) => {
  const streaming = useContext(StreamingContext)
  if (!isValidElement<{ className?: string; children?: ReactNode }>(children)) return <pre>{children}</pre>

  const language = children.props.className?.replace(/^language-/, "") ?? "text"
  if (language.toLowerCase() === "mermaid" && !preview && !streaming)
    return <MermaidDiagram source={String(children.props.children ?? "").replace(/\n$/, "")} />
  if (language === "diff") return <DiffOutput source={String(children.props.children ?? "").replace(/\n$/, "")} />

  return (
    <ShikiCode
      language={language}
      source={String(children.props.children ?? "").replace(/\n$/, "")}
      copyable={!preview}
      highlight={!streaming}
    />
  )
}

const LazyMarkdown = lazy(async () => {
  const [
    { default: ReactMarkdown, defaultUrlTransform },
    { default: remarkGfm },
    { unified },
    { default: remarkParse },
  ] = await Promise.all([import("react-markdown"), import("remark-gfm"), import("unified"), import("remark-parse")])
  const buildComponents = (preview: boolean, images: EvidenceImage[]): Components => ({
    img: ({ alt, src }) => {
      const path = src ? decodedEvidencePath(src, true) : null
      if (path && images.some((image) => image.path === path)) return null
      return <span>{alt}</span>
    },
    a: ({ href, children }) => <MarkdownLink href={href}>{children}</MarkdownLink>,
    p: ({ node, children }) => {
      const content = node?.children.filter((child) => child.type !== "text" || child.value.trim()) ?? []
      const link = content.length === 1 ? content[0] : undefined
      const href = link?.type === "element" && link.tagName === "a" ? link.properties.href : undefined
      const path = typeof href === "string" ? decodedEvidencePath(localFilePath(href) ?? href, true) : null
      const isDownload = /\b(baixar|download|save)\b/i.test(linkText(children))
      if (isDownload && path && images.some((image) => image.path === path && image.imageSyntax)) return null

      return <p>{children}</p>
    },
    pre: ({ children }) => <MarkdownCodeBlock preview={preview}>{children}</MarkdownCodeBlock>,
    table: ({ children }) => (
      // biome-ignore lint/a11y/noNoninteractiveTabindex: horizontal tables must be keyboard-scrollable.
      <section className="markdown-table" tabIndex={0} aria-label="Tabela da mensagem">
        <table>{children}</table>
      </section>
    ),
  })
  const fullPlugins = [remarkGfm, localFileLinks]
  const previewPlugins = [remarkGfm, chatPreview, localFileLinks]
  const Markdown = ({ content, preview }: MarkdownRendererProps) => {
    const evidence = useContext(EvidenceContext)
    const isPreview = preview ?? false
    const images = useMemo(() => {
      if (!evidence) return []
      const tree = unified().use(remarkParse).use(remarkGfm).parse(protectDiffFences(content)) as EvidenceNode
      if (isPreview) chatPreview()(tree)
      return evidenceImages(tree)
    }, [content, isPreview, evidence])
    const components = useMemo(() => buildComponents(isPreview, images), [isPreview, images])
    return (
      <>
        <ReactMarkdown
          skipHtml
          urlTransform={(url, key) => (key === "href" && localFilePath(url) ? url : defaultUrlTransform(url))}
          remarkPlugins={isPreview ? previewPlugins : fullPlugins}
          components={components}
        >
          {protectDiffFences(content)}
        </ReactMarkdown>
        {images.length > 0 && <EvidenceGallery images={images} inline />}
      </>
    )
  }
  return { default: memo(Markdown) }
})

const ShikiCode = ({
  language,
  source,
  copyable = true,
  highlight = true,
}: {
  language: string
  source: string
  copyable?: boolean
  highlight?: boolean
}) => {
  const [html, setHtml] = useState<string | null>(null)
  const [visible, setVisible] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const visibleOnly = useContext(CodeVisibilityContext)
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
    if (!highlight || !visibleOnly) return

    return observeCodeVisibility(root.current, () => setVisible(true))
  }, [highlight, visibleOnly])
  useEffect(() => {
    if (!highlight || (visibleOnly && !visible)) return

    let active = true
    void getMarkdownCodeHtml(source, language)
      .then((rendered) => {
        if (active) setHtml(rendered)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [language, source, highlight, visibleOnly, visible])

  const highlighted = html !== null && highlight

  return (
    <div className="markdown-code" ref={root}>
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
      <div className="markdown-code-body">
        <pre aria-hidden={highlighted || undefined}>
          <code>{source}</code>
        </pre>
        {highlighted && (
          // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki generates this markup from a code block, not user HTML.
          <div className="markdown-highlight" dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </div>
    </div>
  )
}

export const MarkdownContent = ({
  content,
  compact = false,
  preview = false,
  streaming = false,
  evidence,
}: MarkdownRendererProps) => {
  const displayed = useStreamingContent(content, streaming)
  const visibleOnly = !streaming && (content.length > 4000 || content.split("\n").length > 40)

  return (
    <StreamingContext.Provider value={streaming}>
      <CodeVisibilityContext.Provider value={visibleOnly}>
        <div className={`markdown-content${compact ? " markdown-compact" : ""}`}>
          <Suspense fallback={<p className="whitespace-pre-wrap">{preview ? displayed.slice(0, 600) : displayed}</p>}>
            {evidence ? (
              <EvidenceContext.Provider value={evidence}>
                <LazyMarkdown content={displayed} preview={preview} streaming={streaming} />
              </EvidenceContext.Provider>
            ) : (
              <LazyMarkdown content={displayed} preview={preview} streaming={streaming} />
            )}
          </Suspense>
        </div>
      </CodeVisibilityContext.Provider>
    </StreamingContext.Provider>
  )
}
