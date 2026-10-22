import { type ReactNode, useEffect, useId, useRef } from "react"
import { createPortal } from "react-dom"
import { useAnchoredPopover } from "./useAnchoredPopover"

type SidebarAction = {
  label: string
  onSelect: () => void
  destructive?: boolean
  disabled?: boolean
}

export const SidebarActionsMenu = ({
  label,
  open,
  onOpenChange: setOpen,
  actions,
  triggerClassName = "bot-settings",
  trigger: triggerContent = "···",
}: {
  label: string
  open: boolean
  onOpenChange: (open: boolean) => void
  actions: SidebarAction[]
  triggerClassName?: string
  trigger?: ReactNode
}) => {
  const container = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const { surface: menu, style, portalRoot } = useAnchoredPopover(open, trigger)
  const menuId = useId()
  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus()
    const close = (event: MouseEvent) => {
      if (
        event.target instanceof Node &&
        !container.current?.contains(event.target) &&
        !menu.current?.contains(event.target)
      )
        setOpen(false)
    }
    window.addEventListener("mousedown", close)
    return () => window.removeEventListener("mousedown", close)
  }, [open, setOpen, menu])
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
        if (
          !(
            event.relatedTarget instanceof Node &&
            (event.currentTarget.contains(event.relatedTarget) || menu.current?.contains(event.relatedTarget))
          )
        )
          setOpen(false)
      }}
    >
      <button
        type="button"
        className={triggerClassName}
        ref={trigger}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onMouseDown={(event) => {
          if (open) event.preventDefault()
        }}
        onClick={() => {
          if (open) trigger.current?.focus()
          setOpen(!open)
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        {triggerContent}
      </button>
      {open &&
        createPortal(
          <div
            className="bot-context-menu"
            id={menuId}
            style={style}
            ref={menu}
            role="menu"
            aria-label={label}
            // Native mouse clicks can blur a button without focusing the next one. Keep the menu until click activates it.
            onMouseDown={(event) => event.preventDefault()}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault()
                event.stopPropagation()
                trigger.current?.focus()
                setOpen(false)
              }
              if (event.key === "Tab") {
                trigger.current?.focus()
                setOpen(false)
              }
              const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"))
              const index =
                document.activeElement instanceof HTMLButtonElement ? buttons.indexOf(document.activeElement) : -1
              const next = getNextActionIndex(event.key, index, buttons.length)
              if (next === null) return

              event.preventDefault()
              buttons[(next + buttons.length) % buttons.length]?.focus()
            }}
          >
            {actions.map((action) => (
              <button
                key={action.label}
                type="button"
                role="menuitem"
                className={action.destructive ? "tool-action-deny" : undefined}
                disabled={action.disabled}
                onClick={() => launch(action.onSelect)}
              >
                {action.label}
              </button>
            ))}
          </div>,
          portalRoot,
        )}
    </div>
  )
}

const getNextActionIndex = (key: string, current: number, count: number): number | null => {
  if (key === "Home") return 0
  if (key === "End") return count - 1
  if (key === "ArrowDown") return current + 1
  if (key === "ArrowUp") return current - 1

  return null
}
