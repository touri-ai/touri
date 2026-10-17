import { useEffect, useRef } from "react"
import { t } from "../i18n"

type ModalProps = {
  onClose: () => void
  children: React.ReactNode
  title: string
  eyebrow?: string
  className?: string
}

export const Modal = ({ onClose, children, title, eyebrow = "touri", className = "" }: ModalProps) => {
  const cardRef = useRef<HTMLElement>(null)
  const returnFocusRef = useRef(document.activeElement)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const card = cardRef.current
    if (!card) return
    const previous = returnFocusRef.current instanceof HTMLElement ? returnFocusRef.current : null
    if (!card.contains(document.activeElement)) {
      const initial = Array.from(card.querySelectorAll<HTMLElement>("[data-initial-focus]")).find(
        (element) => !element.closest("[hidden]"),
      )
      ;(initial ?? card.querySelector<HTMLElement>(".modal-close"))?.focus()
    }
    const handleKey = (event: KeyboardEvent) => {
      if (document.querySelectorAll(".modal-card").item(document.querySelectorAll(".modal-card").length - 1) !== card)
        return
      const confirmation = Array.from(card.querySelectorAll<HTMLElement>('[role="alertdialog"]')).find(
        (element) => !element.closest("[hidden]"),
      )
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        if (confirmation) confirmation.querySelector<HTMLButtonElement>(".button-quiet")?.click()
        else closeRef.current()
      }
      if (event.key !== "Tab") return
      const scope = confirmation ?? card
      const controls = Array.from(
        scope.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]',
        ),
      ).filter((element) => {
        if (element.closest("[hidden]") || element.tabIndex < 0) return false
        let disclosure = element.closest("details")
        while (disclosure) {
          if (!disclosure.open && disclosure.querySelector("summary") !== element) return false
          disclosure = disclosure.parentElement?.closest("details") ?? null
        }
        return true
      })
      const first = controls[0]
      const last = controls.at(-1)
      if (!first || !last) return
      if (event.shiftKey && (document.activeElement === first || !scope.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !scope.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener("keydown", handleKey, true)
    return () => {
      document.removeEventListener("keydown", handleKey, true)
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])
  return (
    <div className="modal-backdrop" role="presentation">
      <section ref={cardRef} className={`modal-card ${className}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-header">
          <div>
            <p className="eyebrow">{eyebrow}</p>
            <h2>{title}</h2>
          </div>
          <button type="button" className="icon-button modal-close" onClick={onClose} aria-label={t("Close dialog")}>
            ×
          </button>
        </header>
        {children}
      </section>
    </div>
  )
}
