import { type ReactNode, useLayoutEffect } from "react"
import "./window-frame.css"

export const WindowFrame = ({ children }: { children: ReactNode }) => {
  useLayoutEffect(() => installWindowInset(document.documentElement), [])

  return (
    <div className="window-frame window-frame-overlay">
      <div className="window-titlebar" data-tauri-drag-region="deep" aria-hidden="true" />
      <div className="window-content">{children}</div>
    </div>
  )
}

export const getWindowChrome = ({
  native,
  userAgent,
  search,
}: {
  native: boolean
  userAgent: string
  search: string
}): "overlay" | "system" => {
  if (!native || !/Macintosh|Mac OS X/i.test(userAgent)) return "system"
  if (new URLSearchParams(search).has("computer")) return "system"

  return "overlay"
}

// Body portals share the inset through the document root.
const installWindowInset = (root: HTMLElement) => {
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
