import { type ReactNode, useEffect, useId, useState } from "react"
import "./ds.css"

export type DisclosureProps = {
  summary: ReactNode
  children: ReactNode
  className?: string
  defaultOpen?: boolean
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
  open: controlledOpen,
  openWhen = false,
  onOpenChange,
}: DisclosureProps) => {
  const [localOpen, setLocalOpen] = useState(defaultOpen || openWhen)
  const open = controlledOpen ?? localOpen
  const contentId = useId()
  useEffect(() => {
    if (openWhen) setLocalOpen(true)
  }, [openWhen])

  return (
    <div className={`ds-disclosure ${className}`} data-open={open}>
      <button
        type="button"
        className="ds-disclosure-trigger"
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
      <div id={contentId} className="ds-disclosure-content" hidden={!open}>
        {children}
      </div>
    </div>
  )
}
