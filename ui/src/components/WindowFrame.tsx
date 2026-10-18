import { type ReactNode, useLayoutEffect } from "react"
import { isNativeDesktop } from "../features/server/serverMode"
import "./window-frame.css"

export const WindowFrame = ({ children }: { children: ReactNode }) => {
  const computerWindow = new URLSearchParams(window.location.search).has("computer")
  const overlay = isNativeDesktop() && /Macintosh|Mac OS X/i.test(navigator.userAgent) && !computerWindow
  useLayoutEffect(() => installWindowInset(document.documentElement, overlay), [overlay])

  if (!overlay) return children

  return (
    <div className="window-frame window-frame-overlay">
      <div className="window-titlebar" data-tauri-drag-region="deep" aria-hidden="true" />
      <div className="window-content">{children}</div>
    </div>
  )
}

// Body portals need the same inset as the native frame, without scanning the workspace with :has().
const installWindowInset = (root: HTMLElement, overlay: boolean) => {
  if (!overlay) return
  const previous = root.getAttribute("data-window-overlay")
  root.setAttribute("data-window-overlay", "true")

  return () => {
    if (previous === null) {
      root.removeAttribute("data-window-overlay")
      return
    }
    root.setAttribute("data-window-overlay", previous)
  }
}
