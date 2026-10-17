import type { PreviewBounds, PreviewTarget } from "@touri/contracts"
import { useEffect, useRef, useState } from "react"
import type { TauriInvoke } from "../api/client"
import { useIsServerMode } from "../features/server/serverMode"
import { t } from "../i18n"
import { NativePreview } from "../nativePreview"
import { ScreenState } from "./ScreenPrimitives"

type PreviewPaneProps = {
  preview: PreviewTarget | null
  modalOpen: boolean
  invokeCommand: TauriInvoke
  onOpenAgentBrowser: (url: string) => void
}

const boundsFor = (element: HTMLElement): PreviewBounds => {
  const rect = element.getBoundingClientRect()
  const x = Math.max(0, rect.left)
  const y = Math.max(0, rect.top)
  return {
    x,
    y,
    width: Math.max(0, Math.min(window.innerWidth, rect.right) - x),
    height: Math.max(0, Math.min(window.innerHeight, rect.bottom) - y),
  }
}

export const PreviewPane = ({ preview, modalOpen, invokeCommand, onOpenAgentBrowser }: PreviewPaneProps) => {
  const serverMode = useIsServerMode()
  const slotRef = useRef<HTMLDivElement>(null)
  const [label, setLabel] = useState<string | null>(null)
  const [nativeUnavailable, setNativeUnavailable] = useState(false)
  const [revision, setRevision] = useState(0)

  const url = preview?.url
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry creates a new native preview session
  useEffect(() => {
    setLabel(null)
    setNativeUnavailable(false)
    if (serverMode || !url || modalOpen || !slotRef.current) return
    const slot = slotRef.current
    const native = new NativePreview(invokeCommand)
    let active = true
    let resizing = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let frame = 0
    const hide = (): void => {
      setLabel(null)
      void native.hide().catch(() => undefined)
    }
    const show = (): void => {
      const bounds = boundsFor(slot)
      if (!active || resizing || document.hidden || bounds.width <= 0 || bounds.height <= 0) return
      void native
        .show(url, bounds)
        .then((label) => {
          if (active) {
            setLabel(label)
            setNativeUnavailable(!label)
          }
        })
        .catch(() => {
          if (active) setNativeUnavailable(true)
        })
    }
    const resize = (): void => {
      resizing = true
      hide()
      clearTimeout(timer)
      timer = setTimeout(() => {
        resizing = false
        show()
      }, 120)
    }
    const visibility = (): void => {
      if (document.hidden) hide()
      else show()
    }
    // Position can change without changing the slot's size (sidebar, scroll, layout).
    const track = (): void => {
      if (active && !resizing) void native.reposition(boundsFor(slot)).catch(() => undefined)
      if (active) frame = requestAnimationFrame(track)
    }
    show()
    frame = requestAnimationFrame(track)
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize)
    observer?.observe(slot)
    window.addEventListener("resize", resize)
    document.addEventListener("visibilitychange", visibility)
    return () => {
      active = false
      clearTimeout(timer)
      cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener("resize", resize)
      document.removeEventListener("visibilitychange", visibility)
      void native.hide().catch(() => undefined)
    }
  }, [invokeCommand, modalOpen, url, revision, serverMode])

  const reload = (): void => {
    if (label) void invokeCommand("preview_reload", { label }).catch(() => setNativeUnavailable(true))
    else setRevision((value) => value + 1)
  }

  const openExternal = (): void => {
    if (preview) void invokeCommand("open_external", { url: preview.url })
  }

  if (serverMode && preview)
    return (
      <div className="preview-empty">
        <p>{t("Este preview está no servidor. Peça ao bot para abri-lo no navegador do servidor.")}</p>
      </div>
    )

  if (!preview)
    return (
      <div className="preview-empty">
        <span className="empty-glyph">▧</span>
        <h3>{t("Preview waits here")}</h3>
        <p>{t("Start a project process with a detected HTTP port to see its local app.")}</p>
      </div>
    )

  return (
    <div className={`preview-pane ${modalOpen ? "preview-hidden" : ""}`}>
      <div className="panel-toolbar">
        <label className="visually-hidden" htmlFor="preview-target">
          Aplicativo em preview
        </label>
        <select id="preview-target" value={preview.url} onChange={() => undefined}>
          <option value={preview.url}>{preview.label}</option>
        </select>
        <code className="preview-port">localhost:{preview.port}</code>
        <small className="preview-live-label">
          {label ? "renderizado ao vivo" : nativeUnavailable ? "Visualização indisponível" : "Conectando…"}
        </small>
        <div className="toolbar-actions">
          <button type="button" className="icon-button" onClick={reload} aria-label={t("Reload preview")}>
            ↻
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={openExternal}
            aria-label={t("Open preview in default browser")}
          >
            ↗
          </button>
        </div>
      </div>
      <div ref={slotRef} className="preview-slot">
        {nativeUnavailable ? (
          <div className="preview-fallback">
            <ScreenState
              kind="error"
              description={t("Native preview is unavailable")}
              onRetry={() => setRevision((value) => value + 1)}
            >
              <code>{preview.url}</code>
              <button type="button" className="outline-button" onClick={openExternal}>
                {t("Open in browser")}
              </button>
            </ScreenState>
          </div>
        ) : (
          <div className="preview-native-placeholder">
            <div className="preview-chrome-bar">
              <span />
              <span />
              <span />
              <small>{preview.url}</small>
            </div>
            {!label && <ScreenState kind="loading" />}
          </div>
        )}
      </div>
      <div className="preview-footer">
        <span className="status-dot status-green" />
        {t("localhost only · cookies stay in this project preview")}
      </div>
      <button
        type="button"
        className="text-button preview-agent-button"
        onClick={() => onOpenAgentBrowser(preview.url)}
      >
        {t("Open in agent browser ↗")}
      </button>
    </div>
  )
}
