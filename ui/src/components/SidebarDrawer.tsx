import { type ComponentProps, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { isNewBotShortcut, isPaletteShortcut } from "../features/commandPalette/shortcut"
import { t } from "../i18n"
import { Sidebar } from "./BotSidebar"

const query = "(max-width: 620px)"
const subscribe = (changed: () => void) => {
  const media = window.matchMedia(query)
  media.addEventListener("change", changed)
  return () => media.removeEventListener("change", changed)
}
const isNarrow = () => window.matchMedia(query).matches

export const SidebarDrawer = (props: ComponentProps<typeof Sidebar>) => {
  const narrow = useSyncExternalStore(subscribe, isNarrow)
  const [open, setOpen] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const close = () => {
    dialog.current?.close()
    setOpen(false)
    trigger.current?.focus({ preventScroll: true })
  }
  useEffect(() => {
    if (!narrow) {
      setOpen(false)
      return
    }
    if (!open) return
    const element = dialog.current
    element?.showModal()
    element?.querySelector<HTMLButtonElement>(".sidebar-close")?.focus()
    return () => element?.close()
  }, [narrow, open])

  if (!narrow) return <Sidebar {...props} />
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="toolbar-icon mobile-menu-button"
        aria-label={t("Open menu")}
        aria-expanded={open}
        aria-controls="workspace-sidebar-drawer"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>
      <dialog
        ref={dialog}
        id="workspace-sidebar-drawer"
        className="sidebar-drawer"
        aria-label={t("Workspace sidebar")}
        aria-modal="true"
        onCancel={(event) => {
          event.preventDefault()
          close()
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) close()
        }}
        onKeyDown={(event) => {
          if (isPaletteShortcut(event.nativeEvent) || isNewBotShortcut(event.nativeEvent)) close()
        }}
      >
        {open && <Sidebar {...props} onNavigate={close} />}
      </dialog>
    </>
  )
}
