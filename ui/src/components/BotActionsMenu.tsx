import { useEffect, useId, useRef } from "react"
import { createPortal } from "react-dom"
import { t } from "../i18n"
import { PanelIcon, type PanelIconName } from "./PanelIcon"
import { useAnchoredPopover } from "./useAnchoredPopover"

/** Conversation housekeeping lives here, not in the sidebar list: the list stays a flat list of bots. */
export type BotConversationActions = {
  onNewThread?: (() => void) | undefined
  onSelectThreads?: (() => void) | undefined
  onDeleteOldAutomatic?: (() => void) | undefined
  onArchived?: (() => void) | undefined
}

export const BotActionsMenu = ({
  name,
  open,
  onOpenChange: setOpen,
  onSettings,
  onRoutines,
  onDelete,
  conversations = {},
}: {
  name: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSettings: () => void
  onRoutines: () => void
  onDelete?: (() => void) | undefined
  conversations?: BotConversationActions
}) => {
  const conversationItems = getConversationItems(conversations)

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
        className="bot-settings"
        ref={trigger}
        aria-label={t("Actions for {name}", { name })}
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
        ···
      </button>
      {open &&
        createPortal(
          <div
            className="bot-context-menu"
            id={menuId}
            style={style}
            ref={menu}
            role="menu"
            aria-label={t("Actions for {name}", { name })}
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
              const direction = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0
              if (!direction && event.key !== "Home" && event.key !== "End") return
              event.preventDefault()
              const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : index + direction
              buttons[(next + buttons.length) % buttons.length]?.focus()
            }}
          >
            {conversationItems.map((item) => (
              <button key={item.label} type="button" role="menuitem" onClick={() => launch(item.onSelect)}>
                <PanelIcon name={item.icon} />
                <span>{item.label}</span>
              </button>
            ))}
            {conversationItems.length > 0 && <hr className="menu-separator" />}
            <button type="button" role="menuitem" onClick={() => launch(onSettings)}>
              <PanelIcon name="settings" />
              <span>{t("Advanced")}</span>
            </button>
            <button type="button" role="menuitem" onClick={() => launch(onRoutines)}>
              <PanelIcon name="clock" />
              <span>{t("Routines")}</span>
            </button>
            {onDelete && (
              <>
                <hr className="menu-separator" />
                <button type="button" role="menuitem" className="tool-action-deny" onClick={() => launch(onDelete)}>
                  <PanelIcon name="trash" />
                  <span>{t("Delete bot")}</span>
                </button>
              </>
            )}
          </div>,
          portalRoot,
        )}
    </div>
  )
}

type ConversationItem = { label: string; icon: PanelIconName; onSelect: (() => void) | undefined }

const getConversationItems = (conversations: BotConversationActions) => {
  const items: Array<ConversationItem> = [
    { label: t("Nova conversa"), icon: "plus", onSelect: conversations.onNewThread },
    { label: t("Select conversations…"), icon: "check", onSelect: conversations.onSelectThreads },
    { label: t("Delete old automatic conversations…"), icon: "trash", onSelect: conversations.onDeleteOldAutomatic },
    { label: t("Archived"), icon: "archive", onSelect: conversations.onArchived },
  ]

  return items.flatMap(({ label, icon, onSelect }) => (onSelect ? [{ label, icon, onSelect }] : []))
}
