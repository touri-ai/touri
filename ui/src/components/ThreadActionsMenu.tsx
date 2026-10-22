import { type CSSProperties, type RefObject, useEffect, useId, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { t } from "../i18n"
import { PanelIcon } from "./PanelIcon"
import { useAnchoredPopover } from "./useAnchoredPopover"

export const ThreadActionsMenu = ({
  title,
  titleId,
  archived,
  canArchive,
  onArchive,
  onDelete,
}: {
  title: string
  titleId: string
  archived: boolean
  canArchive: boolean
  onArchive?: (() => void) | undefined
  onDelete?: (() => void) | undefined
}) => {
  const container = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
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
  }, [open, menu])

  const launch = (action: () => void): void => {
    trigger.current?.focus()
    setOpen(false)
    action()
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: blur handling only closes the anchored menu.
    <div
      className="thread-actions-menu"
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
        className="thread-row-menu"
        ref={trigger}
        aria-label={t("Thread actions")}
        aria-describedby={titleId}
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
          if (event.key !== "ArrowDown") return
          event.preventDefault()
          setOpen(true)
        }}
      >
        ···
      </button>
      {open &&
        createMenu({
          archived,
          canArchive,
          id: menuId,
          menu,
          onArchive: onArchive ? () => launch(onArchive) : undefined,
          onDelete: onDelete ? () => launch(onDelete) : undefined,
          setOpen,
          style,
          title,
          // Keep actions above their management dialog without inheriting the card's transform.
          portalRoot: trigger.current?.closest(".modal-backdrop") ?? portalRoot,
          trigger,
        })}
    </div>
  )
}

const createMenu = ({
  archived,
  canArchive,
  id,
  menu,
  onArchive,
  onDelete,
  setOpen,
  style,
  title,
  portalRoot,
  trigger,
}: {
  archived: boolean
  canArchive: boolean
  id: string
  menu: RefObject<HTMLDivElement | null>
  onArchive: (() => void) | undefined
  onDelete: (() => void) | undefined
  setOpen: (open: boolean) => void
  style: CSSProperties
  title: string
  portalRoot: Element | DocumentFragment
  trigger: RefObject<HTMLButtonElement | null>
}) =>
  createPortal(
    <div
      className="bot-context-menu"
      id={id}
      style={style}
      ref={menu}
      role="menu"
      data-escape-boundary
      aria-label={t("Thread actions for {title}", { title })}
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
        const index = document.activeElement instanceof HTMLButtonElement ? buttons.indexOf(document.activeElement) : -1
        const direction = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0
        if (!direction && event.key !== "Home" && event.key !== "End") return
        event.preventDefault()
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : index + direction
        buttons[(next + buttons.length) % buttons.length]?.focus()
      }}
    >
      {canArchive && onArchive && (
        <button type="button" role="menuitem" onClick={onArchive}>
          <PanelIcon name="archive" />
          <span>{t(archived ? "Unarchive conversation" : "Archive conversation")}</span>
        </button>
      )}
      {canArchive && onArchive && onDelete && <hr className="menu-separator" />}
      {onDelete && (
        <button type="button" role="menuitem" className="tool-action-deny" onClick={onDelete}>
          <PanelIcon name="trash" />
          <span>{t("Delete conversation…")}</span>
        </button>
      )}
    </div>,
    portalRoot,
  )
