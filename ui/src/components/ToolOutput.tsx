import { redactToolText } from "@touri/contracts/redaction"
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { UiApi } from "../api/client"
import { localizeToolText, t } from "../i18n"
import { contrastAnsiColor } from "./ansiContrast"
import { parseAnsiOutput } from "./ansiOutput"
import { browserToolResult } from "./browserToolPresentation"
import { DiffOutput } from "./DiffOutput"
import { EvidenceGallery } from "./EvidenceGallery"
import { RevealDetails } from "./Reveal"
import { ToolCode } from "./ToolCode"
import type { ToolLanguage } from "./toolHighlight"
import { asToolRecord, parseToolValue } from "./toolPresentation"

type OutputImage = { src: string; mime: string; caption?: string | undefined }
const MAX_IMAGE_OUTPUT_BYTES = 20 * 1024 * 1024
const imageEnvelope = (text: string): boolean =>
  /"type"\s*:\s*"image"|data:image\/[^;]+;base64,|"(?:dataBase64|imageBase64)"\s*:/.test(text)

const localizedPrettyValue = (value: unknown): string =>
  JSON.stringify(parseToolValue(localizeToolText(redactToolText(JSON.stringify(value)))), null, 2)

/** Handles both MCP image blocks and Claude's base64 source envelope without touching the VM controls. */
const readOutput = (raw: string) => {
  const images: OutputImage[] = []
  const texts: string[] = []
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 6) return
    if (Array.isArray(value)) {
      if (value.some((item) => ["image", "text"].includes(String(asToolRecord(item)?.type)))) {
        for (const item of value) visit(item, depth + 1)
      } else texts.push(localizedPrettyValue(value))
      return
    }
    const record = asToolRecord(value)
    if (!record) {
      texts.push(String(value ?? "Sem saída"))
      return
    }
    if (record.type === "image" || typeof record.dataBase64 === "string") {
      const source = asToolRecord(record.source) ?? record
      const mime = source.mimeType ?? source.media_type ?? source.mime
      const data = source.data ?? source.dataBase64
      const prefix = `data:${mime};base64,`
      const base64 = typeof data === "string" ? (data.startsWith(prefix) ? data.slice(prefix.length) : data) : null
      if (
        typeof mime === "string" &&
        /^image\/(png|jpeg|webp|gif)$/.test(mime) &&
        base64 !== null &&
        base64.length <= 20 * 1024 * 1024 &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(base64)
      )
        images.push({ src: `data:${mime};base64,${base64}`, mime })
      return
    }
    if (record.type === "text" && typeof record.text === "string") {
      visit(parseToolValue(record.text), depth + 1)
      return
    }
    if (
      Array.isArray(record.content) &&
      record.content.some((item) => ["image", "text"].includes(String(asToolRecord(item)?.type)))
    ) {
      visit(record.content, depth + 1)
      if (record.structured ?? record.structuredContent)
        texts.push(localizedPrettyValue(record.structured ?? record.structuredContent))
      return
    }
    texts.push(localizedPrettyValue(record))
  }
  visit(parseToolValue(raw))
  const lines = texts.flatMap((text) =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  )
  const isDownloadAction = (line: string) => /^(?:\[)?(?:baixar imagem|download image)(?:\])?(?:\(.*\))?$/i.test(line)
  const downloadActions = lines.filter(isDownloadAction)
  const hasPerImageDownloads = images.length > 0 && downloadActions.length === images.length
  const isCaption = (line: string) =>
    line.length <= 80 &&
    !["{", "}", "[", "]", "`", ":"].some((character) => line.includes(character)) &&
    !isDownloadAction(line)
  const captions = hasPerImageDownloads ? lines.filter(isCaption) : []
  const matchedCaptions = hasPerImageDownloads && captions.length === images.length
  const labeledImages = matchedCaptions
    ? images.map((image, index) => ({ ...image, caption: captions[index] }))
    : images
  const hiddenLines = new Set([...(hasPerImageDownloads ? downloadActions : []), ...(matchedCaptions ? captions : [])])
  const visibleText =
    images.length > 0
      ? texts
          .map((text) =>
            text
              .split("\n")
              .filter((line) => !hiddenLines.has(line.trim()))
              .join("\n"),
          )
          .join("\n")
      : texts.join("\n")
  return { images: labeledImages, text: visibleText }
}

export const ToolText = ({ text, language }: { text: string; language?: ToolLanguage | undefined }) => {
  const [expanded, setExpanded] = useState(false)
  const localized = localizeToolText(redactToolText(text))
  const parsed = parseToolValue(localized)
  const structured = parsed !== null && typeof parsed === "object"
  const safe = structured ? JSON.stringify(parsed, null, 2) : localized
  const codeLanguage = language ?? (structured ? "json" : undefined)
  const spans = useMemo(() => parseAnsiOutput(safe), [safe])
  const codeRef = useRef<HTMLElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: expanding or replacing ANSI spans requires rechecking their DOM colors.
  useLayoutEffect(() => {
    const code = codeRef.current
    if (!code || codeLanguage) return
    const adjust = () => {
      const surface = getComputedStyle(code.closest("pre") ?? code).backgroundColor
      for (const node of code.querySelectorAll<HTMLElement>("span[data-ansi-color]")) {
        node.style.color = node.dataset.ansiColor ?? ""
        node.style.opacity = node.dataset.ansiOpacity ?? ""
        const style = getComputedStyle(node)
        const background = style.backgroundColor === "rgba(0, 0, 0, 0)" ? surface : style.backgroundColor
        const color = contrastAnsiColor(style.color, background)
        if (color !== style.color) node.style.color = color
        // Faint text on arbitrary terminal backgrounds must remain readable too.
        if (background && node.style.opacity) node.style.opacity = "1"
      }
    }
    adjust()
    const observer = new MutationObserver(adjust)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] })
    const disclosure = code.closest("details")
    if (disclosure) observer.observe(disclosure, { attributes: true, attributeFilter: ["open"] })
    return () => observer.disconnect()
  }, [spans, expanded, codeLanguage])
  const length = codeLanguage ? safe.length : spans.reduce((total, span) => total + span.text.length, 0)
  const truncated = length > 1200
  let remaining = expanded ? Infinity : 1200
  const visibleSpans = spans
    .map((span) => {
      const content = span.text.slice(0, remaining)
      remaining = Math.max(0, remaining - content.length)
      return { ...span, text: content }
    })
    .filter((span) => span.text)
  return (
    <div>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable output needs keyboard access */}
      <figure className="tool-code-region" aria-label="Saída da ferramenta" tabIndex={0}>
        <pre>
          {codeLanguage ? (
            <ToolCode
              text={`${expanded ? safe : safe.slice(0, 1200)}${truncated && !expanded ? "…" : ""}`}
              language={codeLanguage}
            />
          ) : (
            <code ref={codeRef}>
              {visibleSpans.map((span) =>
                Object.values(span.style).some(Boolean) ? (
                  <span
                    key={span.offset}
                    style={span.style}
                    data-ansi-color={span.style.color ?? ""}
                    data-ansi-opacity={span.style.opacity}
                  >
                    {span.text}
                  </span>
                ) : (
                  <Fragment key={span.offset}>{span.text}</Fragment>
                ),
              )}
              {truncated && !expanded ? "…" : ""}
            </code>
          )}
        </pre>
      </figure>
      {truncated && (
        <button
          type="button"
          className="tool-text-toggle"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          {expanded ? "Recolher saída" : "Mostrar saída completa"}
        </button>
      )}
    </div>
  )
}

export const ToolOutput = ({
  raw,
  callId,
  language,
  live = false,
}: {
  raw: string
  callId: string
  language?: ToolLanguage | undefined
  live?: boolean
}) => {
  const { images, text } = readOutput(raw)
  const liveRef = useRef<HTMLDivElement>(null)
  // Keep the newest lines in view even when the tail exceeds the scroll region.
  // biome-ignore lint/correctness/useExhaustiveDependencies: new output must advance the live scroll position.
  useLayoutEffect(() => {
    const region = liveRef.current?.querySelector("figure")
    if (live && region) region.scrollTop = region.scrollHeight
  }, [live, text])
  return (
    <>
      {images.length > 0 && (
        <EvidenceGallery
          images={images.map((image, index) => ({
            path: `${callId}-${index + 1}`,
            src: image.src,
            caption: redactToolText(image.caption ?? "Captura de tela da ferramenta"),
            filename: `${callId}-${index + 1}.${image.mime.split("/")[1]}`,
          }))}
        />
      )}
      {text &&
        (live ? (
          <div className="tool-details tool-output" ref={liveRef}>
            <p>Resultado</p>
            <ToolText text={redactToolText(text).slice(-1200)} language={language} />
          </div>
        ) : (
          <RevealDetails className="tool-details tool-output" summary="Resultado">
            <ToolText text={text} language={language} />
          </RevealDetails>
        ))}
    </>
  )
}

export const StoredToolOutput = ({
  api,
  attachmentId,
  preview,
  callId,
  diff = false,
  browser = false,
}: {
  api?: UiApi | undefined
  attachmentId: string
  preview?: string | undefined
  callId: string
  diff?: boolean
  browser?: boolean
}) => {
  const [raw, setRaw] = useState<string | null>(null)
  const [nextOffset, setNextOffset] = useState<number | null>(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<"load" | "image_size" | null>(null)
  const generation = useRef(0)
  useEffect(() => {
    generation.current += 1
    return () => {
      generation.current += 1
    }
  }, [])
  const load = async () => {
    if (!api || loading) return
    const attempt = generation.current
    setLoading(true)
    setError(null)
    try {
      let page = await api.request(
        "GET /attachments/:id/content",
        { offset: nextOffset ?? 0, limit: 64 * 1024 },
        { id: attachmentId },
      )
      const chunks = [page.text]
      // Images need a complete envelope to render. Keep bounded pages private
      // until the explicit open finishes, so partial base64 never reaches chat.
      const image = !diff && (preview === "" || imageEnvelope((raw ?? "") + page.text))
      if (image) {
        let bytes = new TextEncoder().encode((raw ?? "") + page.text).byteLength
        while (true) {
          if (generation.current !== attempt) return
          if (page.bytes > MAX_IMAGE_OUTPUT_BYTES || bytes > MAX_IMAGE_OUTPUT_BYTES) {
            setError("image_size")
            return
          }
          if (page.nextOffset === null) break
          page = await api.request(
            "GET /attachments/:id/content",
            { offset: page.nextOffset, limit: 64 * 1024 },
            { id: attachmentId },
          )
          chunks.push(page.text)
          bytes += new TextEncoder().encode(page.text).byteLength
        }
      }
      if (generation.current === attempt) {
        setRaw((previous) => (previous ?? "") + chunks.join(""))
        setNextOffset(page.nextOffset)
      }
    } catch {
      if (generation.current === attempt) setError("load")
    } finally {
      if (generation.current === attempt) setLoading(false)
    }
  }
  const result = browser && raw !== null ? browserToolResult(raw) : null
  return (
    <>
      {raw === null && preview && <ToolText text={preview} />}
      {result?.title && <p className="tool-summary">{result.title}</p>}
      {result?.url && <p className="tool-summary">{result.url}</p>}
      {raw !== null &&
        (diff ? (
          <RevealDetails className="tool-details tool-output" summary="Resultado">
            <DiffOutput source={raw} />
          </RevealDetails>
        ) : (
          (result ? result.output : raw) != null && (
            <ToolOutput raw={(result ? result.output : raw) ?? ""} callId={callId} />
          )
        ))}
      {nextOffset !== null && (
        <button type="button" className="button button-quiet" disabled={!api || loading} onClick={() => void load()}>
          {loading
            ? t("Carregando resultado…")
            : raw === null
              ? t("Abrir resultado completo")
              : t("Carregar mais saída")}
        </button>
      )}
      {error && (
        <p role="status">
          {error === "image_size"
            ? t("Esta imagem é grande demais para abrir aqui.")
            : t("Não foi possível abrir o resultado. Tente novamente.")}
        </p>
      )}
    </>
  )
}
