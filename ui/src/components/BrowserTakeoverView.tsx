import type { Bot, BrowserTakeoverFrame, BrowserTakeoverInput } from "@touri/contracts"
import type { KeyboardEvent, PointerEvent, WheelEvent } from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import type { UiApi } from "../api/client"
import { ApiError } from "../errors"
import { type Locale, t } from "../i18n"
import { useBrowserActivityControls } from "./BrowserActivityControls"
import { BrowserLiveHeader } from "./BrowserLiveHeader"
import { Button } from "./Button"
import { requestReveal } from "./revealEvent"

type FrameMeta = Pick<
  BrowserTakeoverFrame,
  "title" | "url" | "width" | "height" | "targetEpoch" | "viewEpoch" | "loading"
>
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

const ACTIVE_FRAME_INTERVAL_MS = 16
const IDLE_FRAME_INTERVAL_MS = 1_000
const ACTIVE_FRAME_WINDOW_MS = 8_000
const MAX_PENDING_INPUTS = 32
const TOUCH_SCROLL_INTERVAL_MS = 40

// Session ids already revealed in this page; a bounded record of take-overs the person started.
const revealedSessions = new Set<string>()

export const BrowserTakeoverView = ({
  api,
  tabId,
  sessionId,
  controlEpoch,
  initialViewEpoch = 0,
  initialPreview,
  initialAddress = "",
  botName,
  bot,
  locale,
  reason,
  actions,
  onHandback,
  onHandbackStart,
  onHandbackError,
  onSessionEnded,
}: {
  api: UiApi
  tabId: string
  sessionId: string
  controlEpoch: string
  initialViewEpoch?: number
  initialPreview?: string | undefined
  initialAddress?: string
  botName: string
  bot?: Bot | undefined
  locale: Locale
  reason: string | null
  actions: Array<{ id: string; icon: string; label: string; time: string; active: boolean }>
  onHandback: () => void
  onHandbackStart?: (() => void) | undefined
  onHandbackError?: (() => void) | undefined
  onSessionEnded?: (() => void) | undefined
}) => {
  const [startedAt] = useState(Date.now)
  const dialog = useRef<HTMLDialogElement>(null)
  const fullscreenHistory = useRef(false)
  const autoExpanded = useRef(false)
  const viewportSize = useRef<{ width: number; height: number } | undefined>(undefined)
  const canvas = useRef<HTMLCanvasElement>(null)
  const screen = useRef<HTMLDivElement>(null)
  const view = useRef<HTMLElement>(null)
  const keyboard = useRef<HTMLTextAreaElement>(null)
  const handbackButton = useRef<HTMLButtonElement>(null)
  const renderedFrame = useRef<FrameMeta | null>(null)
  const latestFrameMetaRef = useRef<FrameMeta | null>(null)
  const loadedFallbackImage = useRef("")
  const viewEpoch = useRef(initialViewEpoch)
  const connected = useRef(false)
  const pendingInputs = useRef(0)
  const inputQueue = useRef(Promise.resolve())
  const pendingText = useRef("")
  const textTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(textTimer.current), [])
  const lastInputAt = useRef(0)
  const refreshFrame = useRef<() => void>(() => {})
  const sessionEndedRef = useRef(onSessionEnded)
  sessionEndedRef.current = onSessionEnded
  const localeRef = useRef(locale)
  const touch = useRef<TouchGesture | null>(null)
  const mouse = useRef<{ pointerId: number; button: "left" | "right" | "middle"; lastSentAt: number } | null>(null)
  const composing = useRef(false)
  const released = useRef(false)
  const releasing = useRef(false)
  const handbackRef = useRef<() => Promise<void>>(async () => {})
  // The history may have followed newer content past this card; bring the controls into view once per
  // session, so a remount (virtualized row, channel wrapper) does not pull the person back mid-scroll.
  useEffect(() => {
    if (!view.current || revealedSessions.has(sessionId)) return
    revealedSessions.add(sessionId)
    requestReveal(view.current)
  }, [sessionId])
  // A window that changes size (a narrower layout, the on-screen keyboard) can push Hand back out of
  // the conversation. Bring it back only when it was in view before the resize, so a person who
  // scrolled away to read is not pulled back.
  useEffect(() => {
    const section = view.current
    const history = section?.closest(".message-scroll")
    if (!section || !history) return
    const isHandbackInView = () => {
      const box = handbackButton.current?.getBoundingClientRect()
      if (!box) return false
      const area = history.getBoundingClientRect()
      const visible = window.visualViewport
      const top = Math.max(area.top, visible?.offsetTop ?? area.top)
      const bottom = Math.min(area.bottom, visible ? visible.offsetTop + visible.height : area.bottom)
      return box.top >= top && box.bottom <= bottom
    }
    let inView = isHandbackInView()
    let pendingCheck: number | null = null
    const onScroll = () => {
      inView = isHandbackInView()
    }
    // Resize events run before the scroll they cause, so the state they read is the one before the resize.
    const onResize = () => {
      if (pendingCheck !== null) return
      const wasInView = inView
      pendingCheck = requestAnimationFrame(() => {
        pendingCheck = null
        inView = isHandbackInView()
        if (wasInView && !inView) requestReveal(section)
      })
    }
    history.addEventListener("scroll", onScroll, { passive: true })
    window.addEventListener("resize", onResize)
    window.visualViewport?.addEventListener("resize", onResize)
    return () => {
      if (pendingCheck !== null) cancelAnimationFrame(pendingCheck)
      history.removeEventListener("scroll", onScroll)
      window.removeEventListener("resize", onResize)
      window.visualViewport?.removeEventListener("resize", onResize)
    }
  }, [])
  const browserControls = useBrowserActivityControls()
  const [frame, setFrame] = useState<FrameMeta | null>(null)
  const [fallbackImage, setFallbackImage] = useState("")
  const [frameReady, setFrameReady] = useState(false)
  const [workerReady, setWorkerReady] = useState(false)
  const [workerFrameReady, setWorkerFrameReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [returning, setReturning] = useState(false)
  const [fullView, setFullView] = useState(false)
  const [address, setAddress] = useState("")
  const [addressFocused, setAddressFocused] = useState(false)
  const [navigating, setNavigating] = useState(false)
  const [inlineHeight, setInlineHeight] = useState<number>()
  localeRef.current = locale

  const closeFullView = useCallback((): void => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
    if (dialog.current?.close) dialog.current.close()
    else dialog.current?.removeAttribute("open")
    if (fullscreenHistory.current) {
      fullscreenHistory.current = false
      window.history.back()
    }
    setFullView(false)
  }, [])

  const expandFullView = useCallback(
    (nativeFullscreen = true): void => {
      if (fullView) {
        closeFullView()
        return
      }
      setInlineHeight(view.current?.getBoundingClientRect().height)
      window.history.pushState(Object.assign({}, window.history.state, { browserTakeover: sessionId }), "")
      fullscreenHistory.current = true
      if (dialog.current?.showModal) dialog.current.showModal()
      else dialog.current?.setAttribute("open", "")
      setFullView(true)
      // Keep the request in the click's activation; unsupported mobile browsers retain the modal view.
      if (nativeFullscreen) void view.current?.requestFullscreen?.().catch(() => undefined)
    },
    [closeFullView, fullView, sessionId],
  )

  useEffect(() => {
    if (autoExpanded.current || !window.matchMedia?.("(max-width: 600px)").matches) return
    autoExpanded.current = true
    expandFullView(false)
  }, [expandFullView])

  useEffect(() => {
    const onFullscreen = () => {
      if (!document.fullscreenElement) closeFullView()
    }
    const onBack = () => {
      fullscreenHistory.current = false
      closeFullView()
    }
    document.addEventListener("fullscreenchange", onFullscreen)
    window.addEventListener("popstate", onBack)
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreen)
      window.removeEventListener("popstate", onBack)
    }
  }, [closeFullView])

  useEffect(() => {
    const element = dialog.current
    const viewport = window.visualViewport
    if (!fullView || !element || !viewport) return
    // The phone keyboard changes the visible area independently of the layout viewport.
    const resize = () => {
      element.style.setProperty("--takeover-visible-height", `${viewport.height}px`)
      element.style.setProperty("--takeover-visible-top", `${viewport.offsetTop}px`)
    }
    resize()
    viewport.addEventListener("resize", resize)
    viewport.addEventListener("scroll", resize)
    return () => {
      viewport.removeEventListener("resize", resize)
      viewport.removeEventListener("scroll", resize)
      element.style.removeProperty("--takeover-visible-height")
      element.style.removeProperty("--takeover-visible-top")
    }
  }, [fullView])

  const focusKeyboard = (): void => {
    keyboard.current?.focus({ preventScroll: true })
  }

  useEffect(() => {
    let active = true
    let polling = false
    let refreshRequested = false
    const lifetime = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let latestImage = ""
    let latestFrameId = 0
    const workerFrames = new Map<number, FrameMeta>()
    let workerFrameDrawn = false
    let worker: Worker | null = null
    connected.current = true
    const canvasElement = canvas.current
    const screenElement = screen.current
    const invalidateView = (): void => {
      const bounds = screenElement?.getBoundingClientRect()
      viewportSize.current = bounds
        ? {
            width: Math.min(3840, Math.max(240, Math.round(bounds.width))),
            height: Math.min(2160, Math.max(240, Math.round(bounds.height))),
          }
        : undefined
      viewEpoch.current += 1
      renderedFrame.current = null
      workerFrameDrawn = false
      setFrameReady(false)
      setWorkerFrameReady(false)
      lastInputAt.current = Date.now()
      refreshFrame.current()
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
          if (event.data.type !== "drawn" || event.data.frameId === undefined) return
          const drawn = workerFrames.get(event.data.frameId)
          if (
            !drawn ||
            drawn.viewEpoch !== viewEpoch.current ||
            drawn.targetEpoch !== latestFrameMetaRef.current?.targetEpoch
          )
            return
          workerFrames.delete(event.data.frameId)
          workerFrameDrawn = true
          renderedFrame.current = drawn
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
      if (!active || polling) return
      if (document.hidden) {
        timer = setTimeout(() => void poll(), 1_000)
        return
      }
      const startedAt = Date.now()
      polling = true
      refreshRequested = false
      try {
        const next = await api.request(
          "POST /browser/tabs/:id/takeover/frame",
          {
            sessionId,
            controlEpoch,
            stream: true,
            viewEpoch: viewEpoch.current,
            ...(viewportSize.current ? { viewport: viewportSize.current } : {}),
          },
          { id: tabId },
          { signal: lifetime.signal },
        )
        if (!active) return
        if (next.viewEpoch !== viewEpoch.current) {
          refreshRequested = true
          return
        }
        latestImage = next.image
        const nextFrame = {
          title: next.title,
          url: next.url,
          width: next.width,
          height: next.height,
          targetEpoch: next.targetEpoch,
          viewEpoch: next.viewEpoch,
          loading: next.loading ?? false,
        }
        latestFrameMetaRef.current = nextFrame
        if (!workerFrameDrawn) setFallbackImage(next.image)
        if (!workerFrameDrawn) {
          if (loadedFallbackImage.current === next.image) {
            renderedFrame.current = nextFrame
            setFrameReady(true)
          } else if (
            renderedFrame.current?.viewEpoch !== nextFrame.viewEpoch ||
            renderedFrame.current?.targetEpoch !== nextFrame.targetEpoch
          ) {
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
            current.height === nextFrame.height &&
            current.loading === nextFrame.loading
          )
            return current
          return nextFrame
        })
        setError(null)
        setNavigating(false)
        if (worker) {
          latestFrameId += 1
          workerFrames.set(latestFrameId, nextFrame)
          const oldest = workerFrames.keys().next().value
          if (workerFrames.size > 4 && oldest !== undefined) workerFrames.delete(oldest)
          worker.postMessage({ type: "frame", frameId: latestFrameId, image: next.image })
        }
      } catch (failure) {
        if (failure instanceof ApiError && (failure.status === 429 || failure.status === 409)) return
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
      } finally {
        polling = false
        const recentInput = Date.now() - lastInputAt.current < ACTIVE_FRAME_WINDOW_MS
        const interval = recentInput ? ACTIVE_FRAME_INTERVAL_MS : IDLE_FRAME_INTERVAL_MS
        const viewChanged = latestFrameMetaRef.current?.viewEpoch !== viewEpoch.current
        if (active)
          timer = setTimeout(
            () => void poll(),
            refreshRequested && viewChanged ? 0 : Math.max(0, interval - (Date.now() - startedAt)),
          )
      }
    }

    refreshFrame.current = () => {
      refreshRequested = true
      clearTimeout(timer)
      if (!polling) {
        timer = setTimeout(() => void poll(), 0)
      }
    }
    const onVisibility = () => {
      if (!document.hidden) refreshFrame.current()
    }
    document.addEventListener("visibilitychange", onVisibility)
    void poll()
    return () => {
      document.removeEventListener("visibilitychange", onVisibility)
      active = false
      lifetime.abort()
      refreshFrame.current = () => {}
      connected.current = false
      clearTimeout(timer)
      resizeObserver?.disconnect()
      if (!resizeObserver) window.removeEventListener("orientationchange", invalidateView)
      worker?.terminate()
      // A lost client leaves the bot paused so its controller can reconnect safely.
    }
  }, [api, controlEpoch, sessionId, tabId])

  const sendInput = (input: BrowserTakeoverInput): boolean => {
    if (released.current || releasing.current) return false
    if (input.kind !== "text" && !flushPendingText()) return false
    const observedFrame = input.kind === "navigate" ? latestFrameMetaRef.current : renderedFrame.current
    if (!observedFrame || (input.kind !== "navigate" && observedFrame.viewEpoch !== viewEpoch.current)) {
      setError(t("The browser view changed. Wait for the refreshed page.", {}, locale))
      return false
    }
    lastInputAt.current = Date.now()
    if (pendingInputs.current >= MAX_PENDING_INPUTS) {
      setError(t("The browser is catching up. Try again in a moment.", {}, locale))
      return false
    }
    pendingInputs.current += 1
    inputQueue.current = inputQueue.current
      .then(() => {
        // Handback stops new input but drains actions accepted before the click.
        if (!connected.current || released.current) return
        if (input.kind !== "navigate" && observedFrame.viewEpoch !== viewEpoch.current) return
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
          if (connected.current) {
            setError(null)
            refreshFrame.current()
          }
        },
        () => {
          if (connected.current) setError(t("The browser did not receive that action.", {}, locale))
        },
      )
      .then(() => {
        pendingInputs.current -= 1
      })
    return true
  }

  const flushPendingText = (): boolean => {
    clearTimeout(textTimer.current)
    if (!pendingText.current) return true
    if (!sendInput({ kind: "text", text: pendingText.current })) {
      textTimer.current = setTimeout(() => flushPendingText(), 16)
      return false
    }
    pendingText.current = ""
    return true
  }

  const sendText = (value: string): boolean => {
    if (!value || released.current || releasing.current) return true
    if (!renderedFrame.current || renderedFrame.current.viewEpoch !== viewEpoch.current) return false
    const text = pendingText.current + value
    if (text.length > 16_384) {
      setError(t("That text is too long to send to the browser.", {}, locale))
      return false
    }
    if (new TextEncoder().encode(text).byteLength > 16_384) {
      setError(t("That text is too long to send to the browser.", {}, locale))
      return false
    }
    pendingText.current = text
    clearTimeout(textTimer.current)
    textTimer.current = setTimeout(() => flushPendingText(), 8)
    return true
  }

  const flushKeyboard = (): boolean => {
    if (!flushPendingText()) return false
    const input = keyboard.current
    if (!input?.value) return true
    if (!sendText(input.value)) return false
    input.value = ""
    return flushPendingText()
  }

  const handback = async (discardTyping = false): Promise<void> => {
    if (releasing.current || released.current) return
    if (!discardTyping && !flushKeyboard()) return
    if (discardTyping) {
      clearTimeout(textTimer.current)
      pendingText.current = ""
      if (keyboard.current) keyboard.current.value = ""
    }
    releasing.current = true
    setReturning(true)
    onHandbackStart?.()
    try {
      await inputQueue.current
      await api.request("DELETE /browser/tabs/:id/takeover/session", { sessionId, controlEpoch }, { id: tabId })
      released.current = true
      closeFullView()
      onHandback()
    } catch {
      onHandbackError?.()
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
  const getMousePoint = (event: { clientX: number; clientY: number; currentTarget: HTMLElement }, clamp = false) => {
    const bounds = getPageBounds(event.currentTarget)
    if (!bounds.width || !bounds.height) return null
    const x = (event.clientX - bounds.left) / bounds.width
    const y = (event.clientY - bounds.top) / bounds.height
    if (!clamp && (x < 0 || x > 1 || y < 0 || y > 1)) return null

    return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) }
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
      event.preventDefault()
      focusKeyboard()
      const point = getMousePoint(event)
      if (!point) return
      const button = event.button === 2 ? "right" : event.button === 1 ? "middle" : "left"
      event.currentTarget.setPointerCapture?.(event.pointerId)
      mouse.current = { pointerId: event.pointerId, button, lastSentAt: 0 }
      sendInput({ kind: "pointer", phase: "down", ...point, button })
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
    const drag = mouse.current
    if (drag?.pointerId === event.pointerId) {
      const point = getMousePoint(event)
      if (!point || Date.now() - drag.lastSentAt < 32) return
      mouse.current = { ...drag, lastSentAt: Date.now() }
      sendInput({ kind: "pointer", phase: "move", ...point, button: drag.button })
      return
    }
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
    const drag = mouse.current
    if (drag?.pointerId === event.pointerId) {
      const point = getMousePoint(event, true)
      if (point) sendInput({ kind: "pointer", phase: "up", ...point, button: drag.button })
      mouse.current = null
      return
    }
    const gesture = touch.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    event.preventDefault()
    if (gesture.moved) flushTouchScroll(event, gesture)
    else {
      const point = getMousePoint(event)
      if (point) {
        focusKeyboard()
        sendInput({ kind: "click", x: point.x, y: point.y, button: "left" })
      }
    }
    touch.current = null
  }
  const pointerCancel = (event: PointerEvent<HTMLElement>): void => {
    if (mouse.current?.pointerId === event.pointerId) {
      pointerUp(event)
      return
    }
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
    event.stopPropagation()
    if (event.key === "Escape" && fullView) {
      event.preventDefault()
      closeFullView()
      return
    }
    if (event.nativeEvent.isComposing || ["Dead", "Process", "Unidentified"].includes(event.key)) return
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) return
    if (!flushKeyboard()) {
      event.preventDefault()
      return
    }
    if (event.key.toLowerCase() === "v" && (event.ctrlKey || event.metaKey)) return
    event.preventDefault()
    const modifiers =
      Number(event.altKey) | (Number(event.ctrlKey || event.metaKey) << 1) | (Number(event.shiftKey) << 3)
    sendInput({ kind: "key", phase: "down", key: event.key, code: event.code, modifiers })
  }
  const keyUp = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation()
    if (event.nativeEvent.isComposing || ["Dead", "Process", "Unidentified"].includes(event.key)) return
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) return
    if (event.key.toLowerCase() === "v" && (event.ctrlKey || event.metaKey)) return
    event.preventDefault()
    const modifiers =
      Number(event.altKey) | (Number(event.ctrlKey || event.metaKey) << 1) | (Number(event.shiftKey) << 3)
    sendInput({ kind: "key", phase: "up", key: event.key, code: event.code, modifiers })
  }

  const safeUrl = getBrowserControlAddress(frame?.url ?? "") || initialAddress
  useEffect(() => {
    if (!addressFocused) setAddress(safeUrl)
  }, [addressFocused, safeUrl])
  const navigate = (action: "goto" | "back" | "forward" | "reload") => {
    const url = address.includes("://") ? address : `https://${address}`
    if (sendInput({ kind: "navigate", action, ...(action === "goto" ? { url } : {}) })) setNavigating(true)
  }

  const browserView = (
    <section
      ref={view}
      className="browser-takeover-view"
      aria-label={t("Remote browser control", {}, locale)}
      data-full-view={fullView}
    >
      <div className="browser-takeover-controls">
        <BrowserLiveHeader
          bot={bot}
          botName={botName}
          waiting
          requesterName={t("Browser self", {}, locale)}
          controllerName={t("Browser self", {}, locale)}
          selfControl
          startedAt={startedAt}
          locale={locale}
        >
          <button
            type="button"
            className="browser-activity-icon-button"
            aria-label={t(fullView ? "Collapse browser full screen" : "Expand browser to full screen", {}, locale)}
            aria-pressed={fullView}
            onClick={() => expandFullView()}
          >
            <span aria-hidden="true">{fullView ? "↙" : "↗"}</span>
          </button>
          <Button
            variant="quiet"
            disabled={returning}
            onClick={() => void handback(true)}
            title={t("Discard unsent typing and return control", {}, locale)}
          >
            {t("Cancelar", {}, locale)}
          </Button>
          <Button ref={handbackButton} variant="primary" disabled={returning} onClick={() => void handback()}>
            {returning ? t("Returning control…", {}, locale) : t("Hand back to {name}", { name: botName }, locale)}
          </Button>
        </BrowserLiveHeader>
        <nav className="browser-takeover-navigation" aria-label={t("Browser navigation", {}, locale)}>
          {(["back", "forward", "reload"] as const).map((action) => (
            <button
              key={action}
              type="button"
              className="browser-activity-icon-button"
              disabled={!frameReady || returning}
              aria-label={t(
                ({ back: "Go back", forward: "Go forward", reload: "Reload page" } as const)[action],
                {},
                locale,
              )}
              onClick={() => navigate(action)}
            >
              <span aria-hidden="true">{{ back: "←", forward: "→", reload: "↻" }[action]}</span>
            </button>
          ))}
          <input
            className="browser-takeover-address"
            aria-label={t("Browser address", {}, locale)}
            value={address}
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://"
            onFocus={() => setAddressFocused(true)}
            onBlur={() => setAddressFocused(false)}
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key !== "Enter") return
              event.preventDefault()
              navigate("goto")
            }}
          />
          <button
            type="button"
            className="browser-activity-icon-button"
            disabled={!frameReady}
            aria-label={t("Type in the browser", {}, locale)}
            title={t("Type in the browser", {}, locale)}
            onPointerDown={(event) => {
              event.preventDefault()
              focusKeyboard()
            }}
            onClick={focusKeyboard}
          >
            <span aria-hidden="true">⌨</span>
          </button>
          {(navigating || frame?.loading) && (
            <span role="status" className="browser-takeover-loading" aria-label={t("Loading page…", {}, locale)}>
              ◌
            </span>
          )}
        </nav>
      </div>
      <div className={`browser-takeover-layout${fullView ? " browser-takeover-layout-full" : ""}`}>
        <div
          ref={screen}
          className="browser-takeover-screen"
          role="application"
          aria-label={t("Live browser page", {}, locale)}
          data-full-view={fullView}
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
            role="img"
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
          {!frameReady && initialPreview && (
            <img
              className="browser-takeover-initial-preview"
              src={initialPreview}
              alt={t("Last browser page", {}, locale)}
            />
          )}
          {!frame && !initialPreview && !error && (
            <p className="browser-takeover-placeholder">{t("Connecting to the browser…", {}, locale)}</p>
          )}
        </div>
        <details className="browser-takeover-aside">
          <summary className="browser-takeover-reason" title={t("Why {name} paused", { name: botName }, locale)}>
            {reason ?? t("Browser details", {}, locale)}
          </summary>
          <p className="browser-takeover-privacy">
            {t("People with access see the live page. Typing stays out of history and the bot's context.", {}, locale)}
          </p>
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
        </details>
      </div>
      {/* Keep the phone keyboard focused while a resized frame is being refreshed. */}
      <textarea
        ref={keyboard}
        className="browser-takeover-keyboard"
        aria-label={t("Keyboard input for the browser", {}, locale)}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        disabled={!frame}
        onKeyDown={keyDown}
        onKeyUp={keyUp}
        onCompositionStart={() => {
          composing.current = true
        }}
        onInput={(event) => {
          event.stopPropagation()
          if (composing.current) return
          if (sendText(event.currentTarget.value)) event.currentTarget.value = ""
        }}
        onPaste={(event) => {
          event.preventDefault()
          event.stopPropagation()
          const value = event.currentTarget.value + event.clipboardData.getData("text/plain")
          if (sendText(value)) event.currentTarget.value = ""
          else if (value.length <= 16_384) event.currentTarget.value = value
        }}
        onCompositionEnd={(event) => {
          composing.current = false
          if (sendText(event.currentTarget.value || event.data)) event.currentTarget.value = ""
        }}
      />
      {error && (
        <p className="browser-takeover-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )

  return (
    <div style={fullView && inlineHeight ? { height: inlineHeight } : undefined}>
      <dialog
        ref={dialog}
        className="browser-takeover-dialog"
        aria-label={t("Remote browser control", {}, locale)}
        style={!fullView ? { display: "contents" } : undefined}
        onCancel={(event) => {
          event.preventDefault()
          closeFullView()
        }}
        onClose={() => setFullView(false)}
      >
        {browserView}
      </dialog>
    </div>
  )
}

const getBrowserControlAddress = (value: string): string => {
  try {
    const url = new URL(value)
    if (!["http:", "https:"].includes(url.protocol)) return ""
    return `${url.origin}${url.pathname}`
  } catch {
    return ""
  }
}
