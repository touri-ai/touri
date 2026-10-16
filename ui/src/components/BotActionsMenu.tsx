import { useEffect, useRef } from "react"
import { t } from "../i18n"

export const BotActionsMenu = ({
  name,
  open,
  onOpenChange: setOpen,
  onSettings,
  onRoutines,
  onDelete,
}: {
  name: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSettings: () => void
  onRoutines: () => void
  onDelete?: (() => void) | undefined
}) => {
  const container = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus()
    const close = (event: MouseEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false)
    }
    window.addEventListener("mousedown", close)
    return () => window.removeEventListener("mousedown", close)
  }, [open, setOpen])
  const launch = (action: () => void) => {
    trigger.current?.focus()
    setOpen(false)
    action()
  }
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: focus leaving the action group only closes its menu
    <div
      className="bot-actions-menu"
      ref={container}
      onBlur={(event) => {
        if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setOpen(false)
      }}
    >
      <button
        type="button"
        className="bot-settings"
        ref={trigger}
        aria-label={t("Actions for {name}", { name })}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        ···
      </button>
      {open && (
        <div
          className="bot-context-menu"
          ref={menu}
          role="menu"
          aria-label={t("Actions for {name}", { name })}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation()
              trigger.current?.focus()
              setOpen(false)
            }
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"))
            const index =
              document.activeElement instanceof HTMLButtonElement ? buttons.indexOf(document.activeElement) : -1
            const direction = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0
            if (!direction && event.key !== "Home" && event.key !== "End") return
            event.preventDefault()
            const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : index + direction
            buttons[(next + buttons.length) % buttons.length]?.focus()
          }}
        >
          <button type="button" role="menuitem" onClick={() => launch(onSettings)}>
            {t("Advanced")}
          </button>
          <button type="button" role="menuitem" onClick={() => launch(onRoutines)}>
            {t("Routines")}
          </button>
          {onDelete && (
            <button type="button" role="menuitem" className="tool-action-deny" onClick={() => launch(onDelete)}>
              {t("Delete bot")}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
