import type { BrowserTakeoverFrame, BrowserTakeoverInput } from "@touri/contracts"
import type { KeyboardEvent, PointerEvent, WheelEvent } from "react"
import { useEffect, useRef, useState } from "react"
import type { UiApi } from "../api/client"
import { ApiError } from "../errors"
import { type Locale, t } from "../i18n"
import { useBrowserActivityControls } from "./BrowserActivityControls"
import { getBrowserActivityUrl } from "./browserActivityPresentation"

type FrameMeta = Pick<BrowserTakeoverFrame, "title" | "url" | "width" | "height" | "targetEpoch" | "viewEpoch">
type TouchGesture = {
  pointerId: number
  startX: number
  startY: number
  lastX: number
  lastY: number
  deltaX: number
  deltaY: number
  moved: boolean
  lastSentAt: number
}

const ACTIVE_FRAME_INTERVAL_MS = 300
const IDLE_FRAME_INTERVAL_MS = 1_000
const ACTIVE_FRAME_WINDOW_MS = 8_000
const MAX_PENDING_INPUTS = 32
const TOUCH_SCROLL_INTERVAL_MS = 40

export const BrowserTakeoverView = ({
  api,
  tabId,
  sessionId,
  controlEpoch,
  initialViewEpoch = 0,
  botName,
  locale,
  reason,
  actions,
  onHandback,
  onSessionEnded,
}: {
  api: UiApi
  tabId: string
  sessionId: string
  controlEpoch: string
  initialViewEpoch?: number
  botName: string
  locale: Locale
  reason: string | null
  actions: Array<{ id: string; icon: string; label: string; time: string; active: boolean }>
  onHandback: () => void
  onSessionEnded?: (() => void) | undefined
}) => {
  const canvas = useRef<HTMLCanvasElement>(null)
  const screen = useRef<HTMLDivElement>(null)
  const keyboard = useRef<HTMLTextAreaElement>(null)
  const renderedFrame = useRef<FrameMeta | null>(null)
  const latestFrameMetaRef = useRef<FrameMeta | null>(null)
  const loadedFallbackImage = useRef("")
  const viewEpoch = useRef(initialViewEpoch)
  const connected = useRef(false)
  const pendingInputs = useRef(0)
  const inputQueue = useRef(Promise.resolve())
  const lastInputAt = useRef(0)
  const sessionEndedRef = useRef(onSessionEnded)
  sessionEndedRef.current = onSessionEnded
  const localeRef = useRef(locale)
  const touch = useRef<TouchGesture | null>(null)
  const composing = useRef(false)
  const released = useRef(false)
  const releasing = useRef(false)
  const handbackRef = useRef<() => Promise<void>>(async () => {})
  const browserControls = useBrowserActivityControls()
  const [frame, setFrame] = useState<FrameMeta | null>(null)
  const [fallbackImage, setFallbackImage] = useState("")
  const [frameReady, setFrameReady] = useState(false)
  const [workerReady, setWorkerReady] = useState(false)
  const [workerFrameReady, setWorkerFrameReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [returning, setReturning] = useState(false)
  const [fullView, setFullView] = useState(false)
  localeRef.current = locale

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let latestImage = ""
    let latestFrameId = 0
    let hasFrame = false
    let workerFrameDrawn = false
    let worker: Worker | null = null
    connected.current = true
    const canvasElement = canvas.current
    const screenElement = screen.current
    const invalidateView = (): void => {
      viewEpoch.current += 1
      renderedFrame.current = null
      workerFrameDrawn = false
      setFrameReady(false)
      setWorkerFrameReady(false)
    }
    const resizeObserver =
      screenElement && typeof ResizeObserver !== "undefined" ? new ResizeObserver(invalidateView) : null
    if (screenElement && resizeObserver) resizeObserver.observe(screenElement)
    if (!resizeObserver) window.addEventListener("orientationchange", invalidateView)
    if (canvasElement && typeof canvasElement.transferControlToOffscreen === "function") {
      try {
        worker = new Worker(new URL("./browserTakeover.worker.ts", import.meta.url), { type: "module" })
        const offscreen = canvasElement.transferControlToOffscreen()
        worker.postMessage({ type: "canvas", canvas: offscreen }, [offscreen])
        const stopWorker = () => {
          worker?.terminate()
          worker = null
          workerFrameDrawn = false
          setFallbackImage(latestImage)
          const latestFrame = latestFrameMetaRef.current
          const fallbackFrame =
            latestFrame?.viewEpoch === viewEpoch.current && loadedFallbackImage.current === latestImage
              ? latestFrame
              : null
          renderedFrame.current = fallbackFrame
          setFrameReady(Boolean(fallbackFrame))
          setWorkerReady(false)
          setWorkerFrameReady(false)
        }
        worker.onmessage = (event: MessageEvent<{ type?: string; frameId?: number }>) => {
          if (!active) return
          if (event.data.type === "error") {
            stopWorker()
            return
          }
          if (event.data.type !== "drawn" || event.data.frameId !== latestFrameId) return
          const latestFrame = latestFrameMetaRef.current
          if (!latestFrame || latestFrame.viewEpoch !== viewEpoch.current) return
          workerFrameDrawn = true
          renderedFrame.current = latestFrame
          setFrameReady(true)
          setWorkerFrameReady(true)
        }
        worker.onerror = () => {
          if (active) stopWorker()
        }
        setWorkerReady(true)
      } catch {
        worker?.terminate()
        worker = null
      }
    }

    const poll = async (): Promise<void> => {
      if (!active) return
      if (document.hidden && hasFrame) {
        timer = setTimeout(() => void poll(), 1_000)
        return
      }
      try {
        const next = await api.request(
          "POST /browser/tabs/:id/takeover/frame",
          { sessionId, controlEpoch, viewEpoch: viewEpoch.current },
          { id: tabId },
        )
        if (!active) return
        if (next.viewEpoch !== viewEpoch.current) {
          timer = setTimeout(() => void poll(), 0)
          return
        }
        hasFrame = true
        latestImage = next.image
        const nextFrame = {
          title: next.title,
          url: next.url,
          width: next.width,
          height: next.height,
          targetEpoch: next.targetEpoch,
          viewEpoch: next.viewEpoch,
        }
        latestFrameMetaRef.current = nextFrame
        setFallbackImage(next.image)
        if (!workerFrameDrawn) {
          if (loadedFallbackImage.current === next.image) {
            renderedFrame.current = nextFrame
            setFrameReady(true)
          } else {
            renderedFrame.current = null
            setFrameReady(false)
          }
        }
        setFrame((current) => {
          if (!current) return nextFrame
          if (
            current.title === nextFrame.title &&
            current.url === nextFrame.url &&
            current.width === nextFrame.width &&
            current.height === nextFrame.height
          )
            return current
          return nextFrame
        })
        setError(null)
        if (worker) {
          latestFrameId += 1
          worker.postMessage({ type: "frame", frameId: latestFrameId, image: next.image })
        }
      } catch (failure) {
        if (
          active &&
          !releasing.current &&
          failure instanceof ApiError &&
          failure.status === 403 &&
          sessionEndedRef.current
        ) {
          sessionEndedRef.current()
          return
        }
        if (active) setError(t("The browser control connection was interrupted.", {}, localeRef.current))
      }
      const recentInput = Date.now() - lastInputAt.current < ACTIVE_FRAME_WINDOW_MS
      const interval = recentInput ? ACTIVE_FRAME_INTERVAL_MS : IDLE_FRAME_INTERVAL_MS
      if (active) timer = setTimeout(() => void poll(), interval)
    }

    void poll()
    return () => {
      active = false
      connected.current = false
      clearTimeout(timer)
      resizeObserver?.disconnect()
      if (!resizeObserver) window.removeEventListener("orientationchange", invalidateView)
      worker?.terminate()
      // A lost client leaves the bot paused so its controller can reconnect safely.
    }
  }, [api, controlEpoch, sessionId, tabId])

  const sendInput = (input: BrowserTakeoverInput): void => {
    if (released.current || releasing.current) return
    const observedFrame = renderedFrame.current
    if (!observedFrame || observedFrame.viewEpoch !== viewEpoch.current) {
      setError(t("The browser view changed. Wait for the refreshed page.", {}, locale))
      return
    }
    lastInputAt.current = Date.now()
    if (pendingInputs.current >= MAX_PENDING_INPUTS) {
      setError(t("The browser is catching up. Try again in a moment.", {}, locale))
      return
    }
    pendingInputs.current += 1
    inputQueue.current = inputQueue.current
      .then(() => {
        if (!connected.current || released.current || releasing.current) return
        if (observedFrame.viewEpoch !== viewEpoch.current) return
        return api.request(
          "POST /browser/tabs/:id/takeover/input",
          {
            sessionId,
            controlEpoch,
            targetEpoch: observedFrame.targetEpoch,
            viewEpoch: observedFrame.viewEpoch,
            width: observedFrame.width,
            height: observedFrame.height,
            input,
          },
          { id: tabId },
        )
      })
      .then(
        () => {
          if (connected.current) setError(null)
        },
        () => {
          if (connected.current) setError(t("The browser did not receive that action.", {}, locale))
        },
      )
      .then(() => {
        pendingInputs.current -= 1
      })
  }

  const sendText = (value: string): void => {
    if (!value) return
    if (value.length > 16_384) {
      setError(t("That text is too long to send to the browser.", {}, locale))
      return
    }
    if (new TextEncoder().encode(value).byteLength > 16_384) {
      setError(t("That text is too long to send to the browser.", {}, locale))
      return
    }
    sendInput({ kind: "text", text: value })
  }

  const handback = async (): Promise<void> => {
    if (releasing.current || released.current) return
    releasing.current = true
    setReturning(true)
    try {
      await inputQueue.current
      await api.request("DELETE /browser/tabs/:id/takeover/session", { sessionId, controlEpoch }, { id: tabId })
      released.current = true
      onHandback()
    } catch {
      setError(t("Could not return control to the bot. Try again.", {}, locale))
      releasing.current = false
    } finally {
      setReturning(false)
    }
  }

  handbackRef.current = handback

  useEffect(
    () =>
      browserControls.registerTakeover({
        label: t("Hand back to {name}", { name: botName }, locale),
        run: () => void handbackRef.current(),
      }),
    [botName, browserControls.registerTakeover, locale],
  )

  const getPageBounds = (element: HTMLElement) => {
    const bounds = element.getBoundingClientRect()
    const image = element.querySelector("canvas:not([hidden]), img")
    if (!frame || !image || getComputedStyle(image).objectFit !== "contain") return bounds

    const scale = Math.min(bounds.width / frame.width, bounds.height / frame.height)
    const width = frame.width * scale
    const height = frame.height * scale

    return {
      left: bounds.left + (bounds.width - width) / 2,
      top: bounds.top + (bounds.height - height) / 2,
      width,
      height,
    }
  }
  const getMousePoint = (event: { clientX: number; clientY: number; currentTarget: HTMLElement }) => {
    const bounds = getPageBounds(event.currentTarget)
    if (!bounds.width || !bounds.height) return null
    const x = (event.clientX - bounds.left) / bounds.width
    const y = (event.clientY - bounds.top) / bounds.height
    if (x < 0 || x > 1 || y < 0 || y > 1) return null

    return { x, y }
  }
  const clickPage = (event: PointerEvent<HTMLElement>) => {
    event.preventDefault()
    if (event.pointerType !== "touch") keyboard.current?.focus({ preventScroll: true })
    const point = getMousePoint(event)
    if (!point) return
    const button = event.button === 2 ? "right" : event.button === 1 ? "middle" : "left"
    sendInput({ kind: "click", ...point, button })
  }
  const flushTouchScroll = (event: PointerEvent<HTMLElement>, gesture: TouchGesture): TouchGesture => {
    const point = getMousePoint(event)
    const bounds = getPageBounds(event.currentTarget)
    if (!point || !bounds.width || !bounds.height || (!gesture.deltaX && !gesture.deltaY)) return gesture
    const scaleX = (frame?.width ?? bounds.width) / bounds.width
    const scaleY = (frame?.height ?? bounds.height) / bounds.height
    const clamp = (value: number) => Math.max(-1200, Math.min(1200, value))
    sendInput({
      kind: "wheel",
      ...point,
      deltaX: clamp(gesture.deltaX * scaleX),
      deltaY: clamp(gesture.deltaY * scaleY),
    })
    return {
      pointerId: gesture.pointerId,
      startX: gesture.startX,
      startY: gesture.startY,
      lastX: gesture.lastX,
      lastY: gesture.lastY,
      deltaX: 0,
      deltaY: 0,
      moved: gesture.moved,
      lastSentAt: Date.now(),
    }
  }
  const pointerDown = (event: PointerEvent<HTMLElement>): void => {
    if (event.pointerType !== "touch") {
      clickPage(event)
      return
    }
    event.preventDefault()
    if (touch.current) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    touch.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      deltaX: 0,
      deltaY: 0,
      moved: false,
      lastSentAt: Date.now(),
    }
  }
  const pointerMove = (event: PointerEvent<HTMLElement>): void => {
    const gesture = touch.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    event.preventDefault()
    const distanceX = event.clientX - gesture.startX
    const distanceY = event.clientY - gesture.startY
    const nextGesture: TouchGesture = {
      pointerId: gesture.pointerId,
      startX: gesture.startX,
      startY: gesture.startY,
      lastX: event.clientX,
      lastY: event.clientY,
      deltaX: gesture.deltaX + gesture.lastX - event.clientX,
      deltaY: gesture.deltaY + gesture.lastY - event.clientY,
      moved: gesture.moved || distanceX * distanceX + distanceY * distanceY >= 64,
      lastSentAt: gesture.lastSentAt,
    }
    touch.current =
      nextGesture.moved && Date.now() - nextGesture.lastSentAt >= TOUCH_SCROLL_INTERVAL_MS
        ? flushTouchScroll(event, nextGesture)
        : nextGesture
  }
  const pointerUp = (event: PointerEvent<HTMLElement>): void => {
    const gesture = touch.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    event.preventDefault()
    if (gesture.moved) flushTouchScroll(event, gesture)
    else {
      const point = getMousePoint(event)
      if (point) sendInput({ kind: "click", x: point.x, y: point.y, button: "left" })
    }
    touch.current = null
  }
  const pointerCancel = (event: PointerEvent<HTMLElement>): void => {
    const gesture = touch.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    event.preventDefault()
    if (gesture.moved) flushTouchScroll(event, gesture)
    touch.current = null
  }
  const scrollPage = (event: WheelEvent<HTMLElement>) => {
    event.preventDefault()
    const point = getMousePoint(event)
    if (!point) return
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? (frame?.height ?? 720) : 1
    const clamp = (value: number) => Math.max(-1200, Math.min(1200, value * scale))
    sendInput({ kind: "wheel", ...point, deltaX: clamp(event.deltaX), deltaY: clamp(event.deltaY) })
  }
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key.toLowerCase() === "v" && (event.ctrlKey || event.metaKey)) return
    event.preventDefault()
    const modifiers =
      Number(event.altKey) | (Number(event.ctrlKey) << 1) | (Number(event.metaKey) << 2) | (Number(event.shiftKey) << 3)
    sendInput({ kind: "key", phase: "down", key: event.key, code: event.code, modifiers })
  }
  const keyUp = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key.toLowerCase() === "v" && (event.ctrlKey || event.metaKey)) return
    event.preventDefault()
    const modifiers =
      Number(event.altKey) | (Number(event.ctrlKey) << 1) | (Number(event.metaKey) << 2) | (Number(event.shiftKey) << 3)
    sendInput({ kind: "key", phase: "up", key: event.key, code: event.code, modifiers })
  }

  const safeUrl = frame ? getBrowserActivityUrl(frame.url) : ""

  return (
    <section
      className="browser-takeover-view"
      aria-label={t("Remote browser control", {}, locale)}
      data-full-view={fullView}
    >
      <div className="browser-takeover-controls">
        <header className="browser-takeover-toolbar">
          <div>
            <strong>{t("Browser for {name}", { name: botName }, locale)}</strong>
            <span title={safeUrl}>
              {t("You are in control · {name} is paused", { name: botName }, locale)}
              {safeUrl ? ` · ${safeUrl}` : ` · ${t("Connecting to the browser…", {}, locale)}`}
            </span>
          </div>
          <button
            type="button"
            className="browser-activity-icon-button"
            aria-label={t(fullView ? "Collapse browser full screen" : "Expand browser to full screen", {}, locale)}
            aria-pressed={fullView}
            onClick={() => setFullView((value) => !value)}
          >
            <span aria-hidden="true">{fullView ? "↙" : "↗"}</span>
          </button>
          <button type="button" className="button button-quiet" disabled={returning} onClick={() => void handback()}>
            {returning ? t("Returning control…", {}, locale) : t("Hand back to {name}", { name: botName }, locale)}
          </button>
        </header>
        <p
          className="browser-takeover-privacy browser-takeover-privacy-sticky"
          role="status"
          aria-label={t("Browser privacy", {}, locale)}
        >
          {t("What you type here stays out of chat, the bot, and history.", {}, locale)}
        </p>
      </div>
      <div className={`browser-takeover-layout${fullView ? " browser-takeover-layout-full" : ""}`}>
        <div
          ref={screen}
          className="browser-takeover-screen"
          role="application"
          aria-label={t("Live browser page", {}, locale)}
          data-full-view={fullView}
          style={
            fullView
              ? { aspectRatio: "auto", height: "min(72vh, 720px)" }
              : { aspectRatio: frame ? `${frame.width} / ${frame.height}` : "16 / 10" }
          }
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={pointerUp}
          onPointerCancel={pointerCancel}
          onContextMenu={(event) => event.preventDefault()}
          onWheel={scrollPage}
        >
          <canvas
            ref={canvas}
            className="browser-takeover-canvas"
            aria-label={t("Live browser page", {}, locale)}
            hidden={!workerReady || !workerFrameReady}
          />
          {fallbackImage && (!workerReady || !workerFrameReady) && (
            <img
              className="browser-takeover-image"
              src={fallbackImage}
              alt={t("Live browser page", {}, locale)}
              decoding="async"
              onLoad={(event) => {
                loadedFallbackImage.current = event.currentTarget.src
                const loadedFrame = latestFrameMetaRef.current
                if (loadedFrame?.viewEpoch !== viewEpoch.current) return
                renderedFrame.current = loadedFrame
                setFrameReady(true)
              }}
            />
          )}
          {!frame && !error && (
            <p className="browser-takeover-placeholder">{t("Connecting to the browser…", {}, locale)}</p>
          )}
        </div>
        <aside className="browser-takeover-aside">
          <section className="browser-takeover-reason">
            <strong>{t("Why {name} paused", { name: botName }, locale)}</strong>
            <p>{reason ?? t("This page needs your help before {name} can continue.", { name: botName }, locale)}</p>
            <p>
              {t("Finish the step here. When you hand back control, {name} can continue.", { name: botName }, locale)}
            </p>
          </section>
          <section className="browser-takeover-actions" aria-label={t("Latest browser actions", {}, locale)}>
            <strong>{t("Latest actions", {}, locale)}</strong>
            <ol>
              {actions.slice(-5).map((action) => (
                <li key={action.id} data-active={action.active}>
                  <span className="browser-activity-icon" aria-hidden="true">
                    {action.icon}
                  </span>
                  <span>{action.label}</span>
                  <time>{action.active ? t("Now", {}, locale) : action.time}</time>
                </li>
              ))}
            </ol>
          </section>
          <div className="browser-takeover-footer">
            <p>{t("What you type here stays out of chat, the bot, and history.", {}, locale)}</p>
            <button
              type="button"
              className="button button-quiet"
              disabled={!frameReady}
              onClick={() => keyboard.current?.focus()}
            >
              {t("Type in the browser", {}, locale)}
            </button>
          </div>
        </aside>
      </div>
      <textarea
        ref={keyboard}
        className="browser-takeover-keyboard"
        aria-label={t("Keyboard input for the browser", {}, locale)}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        disabled={!frameReady}
        onKeyDown={keyDown}
        onKeyUp={keyUp}
        onCompositionStart={() => {
          composing.current = true
        }}
        onInput={(event) => {
          if (composing.current) return
          sendText(event.currentTarget.value)
          event.currentTarget.value = ""
        }}
        onPaste={(event) => {
          event.preventDefault()
          sendText(event.clipboardData.getData("text/plain"))
          event.currentTarget.value = ""
        }}
        onCompositionEnd={(event) => {
          composing.current = false
          sendText(event.currentTarget.value || event.data)
          event.currentTarget.value = ""
        }}
      />
      {error && (
        <p className="browser-takeover-error" role="alert">
          {error}
        </p>
      )}
      {!workerReady && !fallbackImage && !frame && (
        <span className="browser-takeover-status" role="status">
          {t("Waiting for the browser page…", {}, locale)}
        </span>
      )}
    </section>
  )
}
