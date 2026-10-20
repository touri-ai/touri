import {
  type CSSProperties,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import "./ds.css"

export type DisclosureProps = {
  summary: ReactNode
  children: ReactNode
  className?: string
  defaultOpen?: boolean
  animateContent?: boolean
  triggerRef?: Ref<HTMLButtonElement>
  /** Controlled state; pair with onOpenChange. */
  open?: boolean
  /** Opens the section when it turns true (e.g. a validation error) without locking it open. */
  openWhen?: boolean
  onOpenChange?: (open: boolean) => void
}

/** The system collapsible: whole-row button, chevron that rotates, text at the size of its surroundings. */
export const Disclosure = ({
  summary,
  children,
  className = "",
  defaultOpen = false,
  animateContent = false,
  triggerRef,
  open: controlledOpen,
  openWhen = false,
  onOpenChange,
}: DisclosureProps) => {
  const [localOpen, setLocalOpen] = useState(defaultOpen || openWhen)
  const open = controlledOpen ?? localOpen
  const contentId = useId()
  const contentRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (openWhen) setLocalOpen(true)
  }, [openWhen])
  useLayoutEffect(() => {
    if (!animateContent) return
    const content = contentRef.current
    if (!content) return
    const measure = (): void => {
      content.parentElement?.style.setProperty("--disclosure-size", `${content.getBoundingClientRect().height}px`)
    }
    measure()
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure)
    observer?.observe(content)
    return () => observer?.disconnect()
  }, [animateContent])

  return (
    <div className={`ds-disclosure ${className}`} data-open={open}>
      <button
        type="button"
        className="ds-disclosure-trigger"
        ref={triggerRef}
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => {
          setLocalOpen(!open)
          onOpenChange?.(!open)
        }}
      >
        <svg
          className="ds-disclosure-chevron"
          width="1em"
          height="1em"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m9 6 6 6-6 6" />
        </svg>
        <span>{summary}</span>
      </button>
      <div
        id={contentId}
        className={`ds-disclosure-content ${animateContent ? "disclosure-reveal" : ""}`}
        style={animateContent ? ({ "--reveal": open ? 1 : 0 } as CSSProperties) : undefined}
        hidden={!animateContent && !open}
        inert={animateContent ? !open : undefined}
        aria-hidden={animateContent ? !open : undefined}
      >
        {animateContent ? (
          <div ref={contentRef} className="disclosure-content">
            {children}
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  )
}
