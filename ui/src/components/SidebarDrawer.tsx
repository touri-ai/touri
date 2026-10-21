import { type ComponentProps, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { createPortal } from "react-dom"
import { isNewBotShortcut, isPaletteShortcut } from "../features/commandPalette/shortcut"
import { t } from "../i18n"
import { Sidebar } from "./BotSidebar"
import { ThreadDeletionNotice, useThreadDeletion } from "./useThreadDeletion"

const query = "(max-width: 620px)"
const subscribe = (changed: () => void) => {
  const media = window.matchMedia(query)
  media.addEventListener("change", changed)
  return () => media.removeEventListener("change", changed)
}
const isNarrow = () => window.matchMedia(query).matches

type SidebarDrawerProps = ComponentProps<typeof Sidebar> & { panelOpen?: boolean; workspaceHeader?: HTMLElement | null }

export const SidebarDrawer = ({ panelOpen = false, workspaceHeader = null, ...props }: SidebarDrawerProps) => {
  const deletion = useThreadDeletion(props)
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
  if (!narrow)
    return (
      <>
        <Sidebar {...props} threadDeletion={deletion} />
        <ThreadDeletionNotice deletion={deletion} />
      </>
    )
  const menuButton = (
    <button
      ref={trigger}
      type="button"
      className="toolbar-icon mobile-menu-button"
      hidden={panelOpen && narrow}
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
  )

  return (
    <>
      {workspaceHeader ? createPortal(menuButton, workspaceHeader) : menuButton}
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
        onKeyDown={(event) => {
          if (isPaletteShortcut(event.nativeEvent) || isNewBotShortcut(event.nativeEvent)) close()
          // A modal dialog makes the page inert but lets Tab leave for the browser chrome; keep it in the drawer.
          if (event.key !== "Tab") return
          const focusable = [
            ...event.currentTarget.querySelectorAll<HTMLElement>(
              'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ),
          ].filter((element) => element.offsetParent !== null)
          const first = focusable[0]
          const last = focusable.at(-1)
          if (!first || !last) return
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) close()
        }}
      >
        {open && (
          <>
            <Sidebar {...props} threadDeletion={deletion} onNavigate={close} />
            <ThreadDeletionNotice deletion={deletion} />
          </>
        )}
      </dialog>
      {!open && <ThreadDeletionNotice deletion={deletion} />}
    </>
  )
}
