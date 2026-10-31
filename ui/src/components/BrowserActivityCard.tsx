import type { BrowserTabInfo, BrowserTakeoverReason, Id, MessagePart, ToolCallPart } from "@touri/contracts"
import { type ReactNode, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { ApiError } from "../errors"
import { ChannelCardFooter, useChannelBrowserView } from "../features/channelBrowser/ChannelBrowser"
import { clearBrowserHold, setBrowserHold } from "../features/desktop/browserHold"
import { InlinePreviewContext } from "../features/desktop/InlineLivePreview"
import { type PreviewFrame, startInlineFrameSource } from "../features/desktop/inlineFrameSource"
import { useInlinePreviewPreference } from "../features/desktop/inlinePreviewPreference"
import { type Locale, t } from "../i18n"
import { useBrowserActivityControls } from "./BrowserActivityControls"
import { BrowserIcon, getBrowserIconName } from "./BrowserIcon"
import { BrowserLiveHeader } from "./BrowserLiveHeader"
import { BrowserTakeoverView } from "./BrowserTakeoverView"
import { Button } from "./Button"
import {
  getBrowserActivityCurrentLabel,
  getBrowserActivityIcon,
  getBrowserActivityKind,
  getBrowserActivityLabel,
  getBrowserActivityNotice,
  getBrowserActivityOpenUrl,
  getBrowserActivityScreenshot,
  getBrowserActivityShortUrl,
  getBrowserActivityTabId,
  getBrowserActivityTime,
  getBrowserActivityTimestamps,
  getBrowserActivityTools,
  getBrowserTakeoverReason,
  hasBrowserTakeoverRequest,
  isBrowserActivityOpening,
  isBrowserActivityRunning,
  isBrowserRequestQueued,
} from "./browserActivityPresentation"
import { requestReveal } from "./revealEvent"
import { StoredToolOutput } from "./ToolOutput"
import "./browser-activity.css"

const MAX_VISIBLE_ACTIONS = 16
const WAITING_TIMEOUT_MS = 15_000
const TAB_POLL_MS = 3_000
const COMPACT_ACTIONS = 3

const BrowserPreviewImage = ({ src, alt }: { src: string; alt: string }) => {
  const [frames, setFrames] = useState({ current: src, previous: "" })

  useEffect(() => {
    setFrames((current) => (current.current === src ? current : { current: src, previous: current.current }))
    const timer = window.setTimeout(() => {
      setFrames((current) => (current.current === src ? { current: src, previous: "" } : current))
    }, 320)

    return () => window.clearTimeout(timer)
  }, [src])

  return (
    <div className="browser-activity-preview-frames">
      <img key={frames.current} className="browser-activity-preview-image" src={frames.current} alt={alt} />
      {frames.previous && (
        <img
          key={frames.previous}
          className="browser-activity-preview-image browser-activity-preview-image-previous"
          src={frames.previous}
          alt=""
          aria-hidden="true"
        />
      )}
    </div>
  )
}

export const hasBrowserActivity = (parts: readonly MessagePart[]): boolean => getBrowserActivityTools(parts).length > 0

export const BrowserActivityCard = ({
  parts,
  finished: sourceFinished,
  createdAt,
  threadId,
  runId,
  waitingForPerson = false,
  botName,
  locale = "pt-BR",
  children,
}: {
  parts: readonly MessagePart[]
  finished: boolean
  createdAt: number
  threadId?: Id
  runId?: Id | null
  waitingForPerson?: boolean | undefined
  botName: string
  locale?: Locale
  children?: ReactNode
}) => {
  const context = useContext(InlinePreviewContext)
  const browserControls = useBrowserActivityControls()
  const previewEnabled = useInlinePreviewPreference()
  const channel = useChannelBrowserView(locale)
  const browserTools = getBrowserActivityTools(parts)
  const hasTakeoverRequest = hasBrowserTakeoverRequest(browserTools)
  const queued = isBrowserRequestQueued(browserTools, runId)
  const tabId = getBrowserActivityTabId(browserTools)
  const opening = isBrowserActivityOpening(browserTools)
  const resolutionCallId = tabId ? "" : (browserTools.at(-1)?.callId ?? "")
  const [resolvedTab, setResolvedTab] = useState<{ callId: string; tabId: string }>()
  const activeTabId = opening
    ? undefined
    : (tabId ?? (resolvedTab?.callId === resolutionCallId ? resolvedTab.tabId : undefined))
  const [previewFrame, setPreviewFrame] = useState<{ tabId: string; frame: PreviewFrame }>()
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [heldTab, setHeldTab] = useState<{
    tabId: string
    held: boolean
    reason?: BrowserTakeoverReason | null
  }>()
  const [takeoverSession, setTakeoverSession] = useState<string | null>(null)
  const [controlEpoch, setControlEpoch] = useState<string | null>(null)
  const [takeoverViewEpoch, setTakeoverViewEpoch] = useState(0)
  const takeoverTabId = useRef(activeTabId)
  const [resuming, setResuming] = useState(false)
  const observingHandback = takeoverSession !== null || resuming
  const resumption = useRef<{ runId: Id | null; completed: boolean } | null>(null)
  const handbackRunId = useRef<Id | null | undefined>(undefined)
  const held = heldTab?.tabId === activeTabId && heldTab?.held === true
  const paused = held || waitingForPerson
  const heldRef = useRef(held)
  heldRef.current = held
  const finished = sourceFinished && !paused && !takeoverSession && !resuming && !queued
  const preview = previewFrame?.tabId === activeTabId ? previewFrame?.frame : undefined
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [takeoverUnavailable, setTakeoverUnavailable] = useState(false)
  const [outcomeRequest, setOutcomeRequest] = useState(0)
  const outcome = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(!finished)
  const [showAllActions, setShowAllActions] = useState(false)
  const [fullView, setFullView] = useState(false)
  const [waitedTooLong, setWaitedTooLong] = useState(false)
  const [previewAttempt, setPreviewAttempt] = useState(0)
  const contentId = useId()
  const section = useRef<HTMLElement>(null)
  const logList = useRef<HTMLDivElement>(null)
  const frameSource = useRef<{ refresh?: () => void } | undefined>(undefined)
  const toggleTakeoverRef = useRef<() => Promise<void>>(async () => {})
  const [visible, setVisible] = useState(false)
  const [hidden, setHidden] = useState(document.hidden)
  const api = context?.api
  const bot = context?.bot
  const botId = bot?.id
  const machine = bot?.machine
  const canPreview = !queued && !!api && !!bot
  const completedCount = browserTools.filter((part) => !isBrowserActivityRunning(part)).length
  const needsTabRef = useRef(!activeTabId)
  needsTabRef.current = !activeTabId
  useEffect(() => {
    if (takeoverTabId.current === activeTabId) return
    takeoverTabId.current = activeTabId
    resumption.current = null
    setTakeoverSession(null)
    setControlEpoch(null)
    setTakeoverViewEpoch(0)
  }, [activeTabId])

  useEffect(() => {
    if (!sourceFinished || (resuming && runId !== handbackRunId.current)) {
      resumption.current = null
      setResuming(false)
    }
  }, [sourceFinished, resuming, runId])

  useLayoutEffect(() => {
    if (!api || !observingHandback) return
    // Subscribe before controls become interactive; keep the listener across the release response.
    return api.subscribe(({ event }) => {
      const pending = resumption.current
      if (!pending || pending.completed || event.type !== "run.updated" || event.run.botId !== botId) return
      if (threadId && event.run.threadId !== threadId && event.run.groupThreadId !== threadId) return
      const active = ["queued", "starting", "running"].includes(event.run.status)
      const resumedRunId = pending.runId ?? (event.run.trigger === "retry" && active ? event.run.id : null)
      if (event.run.id !== resumedRunId) return
      resumption.current = { runId: resumedRunId, completed: !active }
      if (!active) setResuming(false)
    })
  }, [api, botId, observingHandback, threadId])

  useEffect(() => {
    const updateVisibility = () => setHidden(document.hidden)
    document.addEventListener("visibilitychange", updateVisibility)

    return () => document.removeEventListener("visibilitychange", updateVisibility)
  }, [])

  useEffect(() => {
    if (finished) setExpanded(false)
  }, [finished])

  useEffect(() => {
    if (paused && !finished) setExpanded(true)
  }, [finished, paused])

  useEffect(() => {
    const element = section.current
    if (!element || typeof IntersectionObserver === "undefined") {
      setVisible(true)
      return
    }

    const observer = new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting ?? false))
    observer.observe(element)

    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (
      !api ||
      !botId ||
      opening ||
      queued ||
      (sourceFinished && !hasTakeoverRequest && !waitingForPerson && !heldRef.current && !takeoverSession && !resuming)
    )
      return
    let active = true
    // Events may arrive after the initial snapshot was taken.
    let hasTabEvent = false
    const selectTab = (tabs: Array<BrowserTabInfo & { ownerBotId: Id | null }>) => {
      const candidate = tabs
        .filter(
          (tab) =>
            tab.ownerBotId === botId &&
            (tab.state === "live" || (tab.state === "unloaded" && tab.heldByUser)) &&
            (!tabId || tab.tabId === tabId),
        )
        .reduce<(typeof tabs)[number] | undefined>(
          (latest, current) => (!latest || current.lastUsedAt > latest.lastUsedAt ? current : latest),
          undefined,
        )
      if (!candidate || !active) return
      if (!tabId) setResolvedTab({ callId: resolutionCallId, tabId: candidate.tabId })
      setHeldTab({
        tabId: candidate.tabId,
        held:
          candidate.heldByUser &&
          (candidate.takeoverRunId === undefined ||
            candidate.takeoverRunId === runId ||
            (!sourceFinished && candidate.takeoverRunId === null)),
        reason: candidate.takeoverReason ?? null,
      })
    }
    const unsubscribe = api.subscribe(({ event }) => {
      if (
        event.type === "browser.tab" &&
        event.tab.ownerBotId === botId &&
        event.tab.state === "live" &&
        (!tabId || event.tab.tabId === tabId)
      ) {
        hasTabEvent = true
        if (!tabId) setResolvedTab({ callId: resolutionCallId, tabId: event.tab.tabId })
        setHeldTab({
          tabId: event.tab.tabId,
          held:
            event.tab.heldByUser &&
            (event.tab.takeoverRunId === undefined ||
              event.tab.takeoverRunId === runId ||
              (!sourceFinished && event.tab.takeoverRunId === null)),
          reason: event.tab.takeoverReason ?? null,
        })
      }
    })
    const loadTabs = () =>
      api
        .request("GET /browser/tabs", { botId })
        .then(({ tabs }) => {
          if (!hasTabEvent) selectTab(tabs)
        })
        .catch(() => {})
    void loadTabs()
    const poll = window.setInterval(() => {
      if (needsTabRef.current) void loadTabs()
    }, TAB_POLL_MS)

    return () => {
      active = false
      window.clearInterval(poll)
      unsubscribe()
    }
  }, [
    api,
    botId,
    opening,
    sourceFinished,
    hasTakeoverRequest,
    resolutionCallId,
    runId,
    tabId,
    queued,
    waitingForPerson,
    takeoverSession,
    resuming,
  ])

  // biome-ignore lint/correctness/useExhaustiveDependencies: an explicit retry restarts the source
  useEffect(() => {
    setPreviewError(null)
    if (
      !api ||
      !botId ||
      !machine ||
      !activeTabId ||
      !canPreview ||
      !previewEnabled ||
      !visible ||
      hidden ||
      !expanded ||
      finished ||
      takeoverSession ||
      waitedTooLong
    )
      return

    const source = startInlineFrameSource(
      api,
      { id: botId, machine },
      activeTabId,
      (frame) => {
        setPreviewFrame({ tabId: activeTabId, frame })
      },
      () => setPreviewError(t("Browser preview unavailable. Open the browser to reconnect.", {}, locale)),
      (reason) => setPreviewError(reason ? t("Reconnecting browser preview…", {}, locale) : null),
      { intervalMs: 700, onReset: () => setPreviewFrame(undefined) },
    )
    frameSource.current = source

    return () => {
      frameSource.current = undefined
      source()
    }
  }, [
    activeTabId,
    api,
    botId,
    machine,
    canPreview,
    expanded,
    finished,
    hidden,
    locale,
    previewEnabled,
    takeoverSession,
    visible,
    waitedTooLong,
    previewAttempt,
  ])

  // Refresh after each completed browser action; the source keeps sampling serial and throttled.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the action count is the trigger
  useEffect(() => {
    frameSource.current?.refresh?.()
  }, [completedCount])

  // biome-ignore lint/correctness/useExhaustiveDependencies: an explicit retry starts a new first-frame deadline
  useEffect(() => {
    setWaitedTooLong(false)
    const isPreviewPaused = !previewEnabled || hidden || !visible
    if (finished || preview || !expanded || isPreviewPaused) return
    const timer = window.setTimeout(() => setWaitedTooLong(true), WAITING_TIMEOUT_MS)

    return () => window.clearTimeout(timer)
  }, [expanded, finished, preview, previewAttempt, previewEnabled, hidden, visible])

  // Preserve a user's scroll position when they inspect earlier browser actions.
  // biome-ignore lint/correctness/useExhaustiveDependencies: row count changes trigger this check
  useEffect(() => {
    const list = logList.current
    if (!list || finished) return
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 48
    if (nearBottom) list.scrollTop = list.scrollHeight
  }, [browserTools.length, finished])

  const startHandback = (): void => {
    handbackRunId.current = runId
    resumption.current = sourceFinished && held ? { runId: null, completed: false } : null
  }
  const cancelHandback = (): void => {
    resumption.current = null
  }
  const finishHandback = (): void => {
    setResuming(resumption.current !== null && !resumption.current.completed)
    setPreviewFrame(undefined)
    setTakeoverSession(null)
    setControlEpoch(null)
    setTakeoverViewEpoch(0)
    if (activeTabId) setHeldTab({ tabId: activeTabId, held: false, reason: null })
  }
  const toggleTakeover = async (): Promise<void> => {
    if (!api || !activeTabId || busy || queued) return
    setBusy(true)
    setError(null)
    setTakeoverUnavailable(false)
    try {
      if (takeoverSession) {
        if (!controlEpoch) throw new Error("Missing browser control epoch")
        startHandback()
        await api.request(
          "DELETE /browser/tabs/:id/takeover/session",
          { sessionId: takeoverSession, controlEpoch },
          { id: activeTabId },
        )
        finishHandback()
        return
      }

      const {
        sessionId,
        controlEpoch: nextControlEpoch,
        viewEpoch: nextViewEpoch,
      } = await api.request("POST /browser/tabs/:id/takeover/session", {}, { id: activeTabId })
      setTakeoverSession(sessionId)
      setControlEpoch(nextControlEpoch)
      setTakeoverViewEpoch(nextViewEpoch)
      setHeldTab({ tabId: activeTabId, held: true, reason: heldTab?.reason ?? "requested" })
    } catch (error) {
      cancelHandback()
      const unavailable = error instanceof ApiError && error.errorCode === "BROWSER_TAKEOVER_UNAVAILABLE"
      setTakeoverUnavailable(unavailable)
      const message = unavailable
        ? "This browser session is unavailable. Return control, then ask the bot to open a public page again. No page was reopened."
        : "The browser tab could not be updated."
      setError(t(message, {}, locale))
      setOutcomeRequest((request) => request + 1)
    } finally {
      setBusy(false)
    }
  }
  const returnUnavailableTakeover = async (): Promise<void> => {
    if (!api || !activeTabId || busy) return
    setBusy(true)
    try {
      await api.request("POST /browser/tabs/:id/takeover", { hold: false }, { id: activeTabId })
      setHeldTab({ tabId: activeTabId, held: false, reason: null })
      setTakeoverUnavailable(false)
      setError(null)
    } catch {
      setError(t("The browser tab could not be updated.", {}, locale))
    } finally {
      setBusy(false)
    }
  }
  toggleTakeoverRef.current = toggleTakeover

  // The take-over can start from the composer strip, far from this card; bring its outcome into view.
  useEffect(() => {
    if (outcomeRequest > 0 && outcome.current) requestReveal(outcome.current)
  }, [outcomeRequest])

  useEffect(() => {
    if (!botId || !activeTabId || !takeoverSession || finished) return
    setBrowserHold(botId, { tabId: activeTabId, release: () => void toggleTakeoverRef.current() })

    return () => clearBrowserHold(botId, activeTabId)
  }, [activeTabId, botId, finished, takeoverSession])

  toggleTakeoverRef.current = toggleTakeover

  useEffect(() => {
    if (finished || takeoverSession || !activeTabId || channel?.canControl === false) return

    return browserControls.registerTakeover({
      label: t("Take over browser", {}, locale),
      run: () => void toggleTakeoverRef.current(),
    })
  }, [activeTabId, browserControls.registerTakeover, channel?.canControl, finished, locale, takeoverSession])

  if (!browserTools.length) return null

  const screenshot = getBrowserActivityScreenshot(browserTools)
  const finalPreview = preview
  const actions = browserTools.slice(-MAX_VISIBLE_ACTIONS)
  const times = getBrowserActivityTimestamps(actions, createdAt)
  const takeoverActions = browserTools.slice(-5)
  const takeoverTimes = getBrowserActivityTimestamps(takeoverActions, createdAt)
  const currentAction = browserTools.at(-1)
  const title = t("Browser for {name}", { name: botName }, locale)
  const summary = t(
    browserTools.length === 1 ? "Used the browser · 1 action" : "Used the browser · {count} actions",
    { count: browserTools.length },
    locale,
  )
  const url = getBrowserActivityShortUrl(preview?.url ?? "") || getBrowserActivityOpenUrl(browserTools)
  const requesterName = channel?.state.requesterName ?? t("Browser self", {}, locale)
  const controllerName = channel?.state.controllerId ? channel.controlName : null
  const canTakeOver = channel?.canControl !== false && !!activeTabId && !queued && !busy
  const takeoverActive = paused && !finished
  const fallbackReason = waitingForPerson ? "sensitive_action" : "requested"
  const requestedReason = takeoverActive ? getBrowserTakeoverReason(browserTools) : null
  const takeoverReason = requestedReason ?? heldTab?.reason ?? fallbackReason
  const reasonCopy = getTakeoverReasonCopy(takeoverReason, locale)
  if (takeoverSession && controlEpoch && activeTabId && api && !finished) {
    const takeoverCard = (
      <div className="browser-activity-stack">
        <article className="browser-activity-card" ref={section} aria-label={title} data-held="true">
          <BrowserTakeoverView
            api={api}
            tabId={activeTabId}
            sessionId={takeoverSession}
            controlEpoch={controlEpoch}
            initialViewEpoch={takeoverViewEpoch}
            initialPreview={preview?.src}
            initialAddress={url}
            botName={botName}
            bot={bot ?? undefined}
            locale={locale}
            reason={reasonCopy}
            actions={takeoverActions.map((part, index) => ({
              id: part.callId,
              icon: getBrowserActivityIcon(part),
              label: getBrowserActivityLabel(part, locale),
              time: getBrowserActivityTime(takeoverTimes[index] ?? createdAt, locale),
              active: part.ok === null,
            }))}
            onSessionEnded={() => {
              cancelHandback()
              setPreviewFrame(undefined)
              setTakeoverSession(null)
              setControlEpoch(null)
              setTakeoverViewEpoch(0)
              setResuming(false)
              setHeldTab({ tabId: activeTabId, held: false, reason: null })
            }}
            onHandbackStart={startHandback}
            onHandbackError={cancelHandback}
            onHandback={finishHandback}
          />
        </article>
      </div>
    )
    if (!channel) return takeoverCard
    return (
      <div className="channel-browser-card">
        {takeoverCard}
        <ChannelCardFooter locale={locale} />
      </div>
    )
  }

  const card = (
    <div className="browser-activity-stack">
      <article
        className="browser-activity-card"
        ref={section}
        aria-label={title}
        data-finished={finished}
        data-held={paused}
        data-expanded={expanded}
        data-show-all-actions={finished || showAllActions}
      >
        {!finished && !paused && (
          <span
            className="browser-activity-progress"
            role="progressbar"
            aria-label={t("Browser progress", {}, locale)}
          />
        )}
        {finished ? (
          <button
            type="button"
            className={`browser-activity-summary${screenshot?.outputAttachmentId ? "" : " browser-activity-summary-compact"}`}
            aria-expanded={expanded}
            aria-controls={expanded ? contentId : undefined}
            onClick={() => setExpanded((value) => !value)}
          >
            <span className="browser-activity-summary-copy">
              <strong>{summary}</strong>
              <small>{t("See the steps", {}, locale)}</small>
            </span>
            {screenshot?.outputAttachmentId ? (
              <span className="browser-activity-thumbnail">
                <StoredToolOutput
                  key={screenshot.outputAttachmentId}
                  api={api}
                  attachmentId={screenshot.outputAttachmentId}
                  preview={screenshot.outputPreview}
                  callId={screenshot.callId}
                  browser
                  locale={locale}
                  autoOpen
                  thumbnail
                />
              </span>
            ) : finalPreview ? (
              <span className="browser-activity-thumbnail">
                <img src={finalPreview.src} alt={t("Final browser screenshot", {}, locale)} />
              </span>
            ) : null}
            <span aria-hidden="true">{expanded ? "−" : "+"}</span>
          </button>
        ) : (
          <BrowserLiveHeader
            bot={bot ?? undefined}
            botName={botName}
            waiting={paused}
            requesterName={requesterName}
            controllerName={controllerName}
            selfControl={channel?.selfControl ?? false}
            startedAt={currentAction?.resolvedAt ?? currentAction?.startedAt ?? createdAt}
            locale={locale}
          >
            <div className="browser-activity-header-actions">
              {channel?.canControl !== false && (
                <Button
                  variant="primary"
                  disabled={!canTakeOver}
                  title={activeTabId ? undefined : t("Preparing the browser…", {}, locale)}
                  onClick={() => void toggleTakeover()}
                >
                  {t(busy ? "Updating browser control…" : "Take over browser", {}, locale)}
                </Button>
              )}
              {previewEnabled && (
                <button
                  type="button"
                  className="browser-activity-icon-button"
                  aria-label={fullView ? t("Collapse browser view", {}, locale) : t("Expand browser view", {}, locale)}
                  disabled={!preview}
                  onClick={() => setFullView((value) => !value)}
                >
                  <BrowserIcon name={fullView ? "collapse" : "expand"} />
                </button>
              )}
              <button
                type="button"
                className="browser-activity-icon-button"
                aria-label={expanded ? t("Collapse browser card", {}, locale) : t("Expand browser card", {}, locale)}
                aria-controls={expanded ? contentId : undefined}
                onClick={() => setExpanded((value) => !value)}
              >
                <BrowserIcon name={expanded ? "chevronUp" : "chevronDown"} />
              </button>
            </div>
          </BrowserLiveHeader>
        )}
        {/* The outcome sits under the control the person just used, outside the scrolling log. */}
        {(error || (takeoverUnavailable && channel?.canControl !== false)) && (
          <div className="browser-activity-alert" ref={outcome}>
            {error && <p role="alert">{error}</p>}
            {takeoverUnavailable && channel?.canControl !== false && (
              <button
                type="button"
                className="button button-quiet browser-activity-recovery-return"
                disabled={busy}
                onClick={() => void returnUnavailableTakeover()}
              >
                {t("Hand back to {name}", { name: botName }, locale)}
              </button>
            )}
          </div>
        )}
        {expanded && (
          <div
            id={contentId}
            className={`browser-activity-content${fullView || finished || !previewEnabled ? " browser-activity-content-full" : ""}`}
          >
            {finished && children && <div className="browser-activity-history">{children}</div>}
            {!finished && previewEnabled && (
              <div className={`browser-activity-preview${fullView ? " browser-activity-preview-full" : ""}`}>
                <div className="browser-activity-window">
                  {/* Reserve the chrome while loading so following history cannot move a pressed control. */}
                  <div className="browser-activity-chrome">
                    <span className="browser-activity-chrome-lock" aria-hidden="true" />
                    <span className="browser-activity-address">{url || t("Preparing the browser…", {}, locale)}</span>
                  </div>
                  <div className="browser-activity-page">
                    {preview?.src ? (
                      <BrowserPreviewImage src={preview.src} alt={t("Current browser page", {}, locale)} />
                    ) : (
                      <p className="browser-activity-placeholder" role="status">
                        <span className="motion-skeleton" aria-hidden="true">
                          <span />
                          <span />
                          <span />
                        </span>
                        {previewError ??
                          t(
                            waitedTooLong
                              ? "The browser did not send a preview in time. Retry the preview or stop the task."
                              : activeTabId
                                ? "Waiting for the browser page…"
                                : "Preparing the browser…",
                            {},
                            locale,
                          )}
                      </p>
                    )}
                  </div>
                </div>
                {waitedTooLong && previewEnabled && !preview?.src && (
                  <button
                    type="button"
                    className="button button-quiet"
                    onClick={() => {
                      setWaitedTooLong(false)
                      setPreviewAttempt((attempt) => attempt + 1)
                    }}
                  >
                    {t("Retry preview", {}, locale)}
                  </button>
                )}
                {preview?.src && previewError && (
                  <small className="browser-activity-preview-status" role="status">
                    {previewError}
                  </small>
                )}
              </div>
            )}
            {!finished && (
              <div className="browser-activity-help">
                <p>{takeoverActive ? reasonCopy : t("Follow the browser steps here.", {}, locale)}</p>
              </div>
            )}
            <div
              className="browser-activity-log"
              role="log"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need to scroll this fixed-height log
              tabIndex={0}
              aria-label={t(takeoverActive ? "Recent actions" : "Browser activity", {}, locale)}
              aria-live={finished ? "off" : "polite"}
              ref={logList}
            >
              <strong>{t(takeoverActive ? "Recent actions" : "Browser activity", {}, locale)}</strong>
              <ol>
                {actions.map((part, index) => (
                  <li
                    key={part.callId}
                    data-current={part.callId === currentAction?.callId && !finished && !paused}
                    data-running={!finished && !paused && isBrowserActivityRunning(part)}
                    data-status={getBrowserActionState(part, paused)}
                  >
                    <span className="browser-activity-action-icon" aria-hidden="true">
                      <BrowserIcon name={getBrowserIconName(getBrowserActivityKind(part))} />
                    </span>
                    <span className="browser-activity-action-label">
                      {getBrowserActionLabel(part, paused, finished, locale)}
                      {getBrowserActivityNotice(part, locale) && (
                        <small>{getBrowserActivityNotice(part, locale)}</small>
                      )}
                    </span>
                    <span
                      className="browser-activity-action-state"
                      role="img"
                      aria-label={getBrowserActionStatusLabel(part, paused, locale)}
                      data-status={getBrowserActionState(part, paused)}
                    >
                      {part.ok === null && !paused ? (
                        <span className="browser-activity-action-spinner" aria-hidden="true" />
                      ) : null}
                      {part.ok === false ? "!" : part.ok === true ? "✓" : null}
                    </span>
                    <time dateTime={new Date(times[index] ?? createdAt).toISOString()}>
                      {getBrowserActivityTime(times[index] ?? createdAt, locale)}
                    </time>
                  </li>
                ))}
              </ol>
              {!finished && actions.length > COMPACT_ACTIONS && (
                <button
                  type="button"
                  className="browser-activity-more-actions"
                  aria-expanded={showAllActions}
                  onClick={() => setShowAllActions((value) => !value)}
                >
                  {t(showAllActions ? "Show fewer browser steps" : "Show all browser steps", {}, locale)}
                </button>
              )}
              {browserTools.length > MAX_VISIBLE_ACTIONS && (
                <small>{t("Showing the latest {count} browser actions", { count: MAX_VISIBLE_ACTIONS }, locale)}</small>
              )}
              {finished && screenshot?.outputAttachmentId && (
                <section className="browser-activity-final-shot" aria-label={t("Final browser screenshot", {}, locale)}>
                  <strong>{t("Final browser screenshot", {}, locale)}</strong>
                  <StoredToolOutput
                    key={screenshot.outputAttachmentId}
                    api={api}
                    attachmentId={screenshot.outputAttachmentId}
                    preview={screenshot.outputPreview}
                    callId={screenshot.callId}
                    browser
                    locale={locale}
                    autoOpen
                  />
                </section>
              )}
            </div>
          </div>
        )}
      </article>
    </div>
  )

  if (!channel) return card

  return (
    <div className="channel-browser-card">
      {card}
      <ChannelCardFooter locale={locale} />
    </div>
  )
}

const getTakeoverReasonCopy = (reason: string, locale: Locale): string => {
  if (["captcha", "verification", "challenge"].includes(reason))
    return t("The site needs you to complete a verification step.", {}, locale)
  if (reason === "login") return t("The site asked you to sign in before continuing.", {}, locale)
  if (reason === "payment")
    return t("The site asked you to review a purchase or payment before continuing.", {}, locale)
  if (reason === "form_submit") return t("The site asked you to submit a form before continuing.", {}, locale)
  if (reason === "requested") return t("The browser is ready for you to take over.", {}, locale)

  if (reason === "sensitive_action") return t("The site needs your confirmation before continuing.", {}, locale)

  return reason
}

const getBrowserActionState = (part: ToolCallPart, held: boolean): "failed" | "complete" | "paused" | "in-progress" => {
  if (part.ok === false) return "failed"
  if (part.ok === true) return "complete"

  return held ? "paused" : "in-progress"
}

const getBrowserActionLabel = (part: ToolCallPart, held: boolean, finished: boolean, locale: Locale): string => {
  if (held && isBrowserActivityRunning(part)) return t("Pausado", {}, locale)
  if (!finished && isBrowserActivityRunning(part)) return getBrowserActivityCurrentLabel(part, locale)

  return getBrowserActivityLabel(part, locale)
}

const getBrowserActionStatusLabel = (part: ToolCallPart, held: boolean, locale: Locale): string => {
  const labels = {
    failed: "Action failed",
    complete: "Action complete",
    paused: "Pausado",
    "in-progress": "Action in progress",
  } as const

  return t(labels[getBrowserActionState(part, held)], {}, locale)
}
