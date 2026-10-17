import { type CSSProperties, type ReactNode, useId, useLayoutEffect, useRef, useState } from "react"

/** Chat-only disclosures share a keyboard action, chevron and reveal animation. */
export const ChatDisclosure = ({
  label,
  expandedLabel = label,
  className = "",
  preview,
  id,
  expanded: controlledExpanded,
  onExpandedChange,
  children,
}: {
  label: string
  expandedLabel?: string
  className?: string
  preview?: ReactNode
  id?: string
  expanded?: boolean | undefined
  onExpandedChange?: (expanded: boolean) => void
  children: ReactNode
}) => {
  const [localExpanded, setExpanded] = useState(false)
  const expanded = controlledExpanded ?? localExpanded
  const generatedId = useId()
  const contentId = id ?? generatedId
  const contentRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const content = contentRef.current
    if (!content) return
    const measure = () => {
      content.parentElement?.style.setProperty("--disclosure-size", `${content.getBoundingClientRect().height}px`)
    }
    measure()
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure)
    observer?.observe(content)
    return () => observer?.disconnect()
  }, [])
  return (
    <div className={`chat-disclosure ${className}`}>
      <button
        type="button"
        className="chat-disclosure-toggle"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => {
          setExpanded(!expanded)
          onExpandedChange?.(!expanded)
        }}
      >
        <svg
          className="chat-disclosure-chevron"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
        >
          <path d="m9 5 7 7-7 7" />
        </svg>
        {expanded ? expandedLabel : label}
      </button>
      {preview && !expanded && <div className="chat-message-preview">{preview}</div>}
      <div
        id={contentId}
        className="disclosure-reveal"
        style={{ "--reveal": expanded ? 1 : 0 } as CSSProperties}
        inert={!expanded}
        aria-hidden={!expanded}
      >
        <div ref={contentRef} className="disclosure-content">
          {children}
        </div>
      </div>
    </div>
  )
}
