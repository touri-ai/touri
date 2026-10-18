import type { ReactNode } from "react"
import { isNativeDesktop } from "../features/server/serverMode"
import "./window-frame.css"

export const WindowFrame = ({ children }: { children: ReactNode }) => {
  const computerWindow = new URLSearchParams(window.location.search).has("computer")
  const overlay = isNativeDesktop() && /Macintosh|Mac OS X/i.test(navigator.userAgent) && !computerWindow

  return (
    <div className={`window-frame${overlay ? " window-frame-overlay" : ""}`}>
      {overlay && <div className="window-titlebar" data-tauri-drag-region="deep" aria-hidden="true" />}
      <div className="window-content">{children}</div>
    </div>
  )
}
