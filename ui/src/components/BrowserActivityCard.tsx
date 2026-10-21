import type { BrowserTabInfo, BrowserTakeoverReason, Id, MessagePart } from "@touri/contracts"
import { useContext, useEffect, useId, useRef, useState } from "react"
import {
  ChannelCardFooter,
  ChannelControlNote,
  ChannelHiddenPreview,
  ChannelVisibilityLabel,
  useChannelBrowserView,
} from "../features/channelBrowser/ChannelBrowser"
import { InlinePreviewContext } from "../features/desktop/InlineLivePreview"
import { type PreviewFrame, startInlineFrameSource } from "../features/desktop/inlineFrameSource"
import { useInlinePreviewPreference } from "../features/desktop/inlinePreviewPreference"
import { type Locale, t } from "../i18n"
import { useBrowserActivityControls } from "./BrowserActivityControls"
import { BrowserTakeoverView } from "./BrowserTakeoverView"
import {
  getBrowserActivityCurrentLabel,
  getBrowserActivityIcon,
  getBrowserActivityKind,
  getBrowserActivityLabel,
  getBrowserActivityNotice,
  getBrowserActivityOpenUrl,
  getBrowserActivityScreenshot,
  getBrowserActivityTabId,
  getBrowserActivityTime,
  getBrowserActivityTools,
  getBrowserActivityUrl,
  getBrowserTakeoverReason,
} from "./browserActivityPresentation"
import { StoredToolOutput } from "./ToolOutput"
import "./browser-activity.css"

const MAX_VISIBLE_ACTIONS = 16

const actionIcons: Record<string, string> = {
  open: "M5 19h14M5 5h6l2 3h6v11H5z",
  read: "M5 4h14v16H5zM8 8h8M8 12h8M8 16h5",
  click: "M6 3v15l4-4 3 6 2-1-3-6h5z",
  fill: "M4 6h16M6 3v6m12-6v6M5 12h14v8H5z",
  screenshot: "M4 7h4l2-2h4l2 2h4v12H4zM12 11a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  tabs: "M3 5h8v14H3zM13 5h8v14h-8z",
  other: "M12 3v3m0 12v3m9-9h-3M6 12H3m15.4-6.4-2.1 2.1M7.7 16.3l-2.1 2.1m12.8 0-2.1-2.1m-8.6-8.6L5.6 5.6",
}

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
  finished,
  createdAt,
  botName,
  locale = "pt-BR",
}: {
  parts: readonly MessagePart[]
  finished: boolean
  createdAt: number
  botName: string
  locale?: Locale
}) => {
  const context = useContext(InlinePreviewContext)
  const browserControls = useBrowserActivityControls()
  const previewEnabled = useInlinePreviewPreference()
  const channel = useChannelBrowserView()
  const browserTools = getBrowserActivityTools(parts)
  const tabId = getBrowserActivityTabId(browserTools)
  const resolutionCallId = tabId ? "" : (browserTools.at(-1)?.callId ?? "")
  const [resolvedTab, setResolvedTab] = useState<{ callId: string; tabId: string }>()
  const activeTabId = tabId ?? (resolvedTab?.callId === resolutionCallId ? resolvedTab.tabId : undefined)
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
  const held = heldTab?.tabId === activeTabId && heldTab?.held === true
  const preview = !held && previewFrame?.tabId === activeTabId ? previewFrame?.frame : undefined
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(!finished)
  const [showAllActions, setShowAllActions] = useState(false)
  const [fullView, setFullView] = useState(false)
  const contentId = useId()
  const section = useRef<HTMLElement>(null)
  const [visible, setVisible] = useState(false)
  const [hidden, setHidden] = useState(document.hidden)
  const toggleTakeoverRef = useRef<() => Promise<void>>(async () => {})
  const api = context?.api
  const bot = context?.bot
  const botId = bot?.id
  const machine = bot?.machine
  const canPreview = !!api && !!bot && (bot.machine === "local" || context?.machine?.status === "running")

  useEffect(() => {
    if (takeoverTabId.current === activeTabId) return
    takeoverTabId.current = activeTabId
    setTakeoverSession(null)
    setControlEpoch(null)
    setTakeoverViewEpoch(0)
  }, [activeTabId])

  useEffect(() => {
    const updateVisibility = () => setHidden(document.hidden)
    document.addEventListener("visibilitychange", updateVisibility)

    return () => document.removeEventListener("visibilitychange", updateVisibility)
  }, [])

  useEffect(() => {
    if (finished) setExpanded(false)
  }, [finished])

  useEffect(() => {
    if (held && !finished) setExpanded(true)
  }, [finished, held])

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
    if (!api || !botId || finished) return
    let active = true
    // Events may arrive after the initial snapshot was taken.
    let hasTabEvent = false
    const selectTab = (tabs: Array<BrowserTabInfo & { ownerBotId: Id | null }>) => {
      const candidate = tabs
        .filter((tab) => tab.ownerBotId === botId && tab.state === "live" && (!tabId || tab.tabId === tabId))
        .reduce<(typeof tabs)[number] | undefined>(
          (latest, current) => (!latest || current.lastUsedAt > latest.lastUsedAt ? current : latest),
          undefined,
        )
      if (!candidate || !active) return
      if (!tabId) setResolvedTab({ callId: resolutionCallId, tabId: candidate.tabId })
      setHeldTab({ tabId: candidate.tabId, held: candidate.heldByUser, reason: candidate.takeoverReason ?? null })
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
        if (event.tab.heldByUser) setPreviewFrame(undefined)
        setHeldTab({ tabId: event.tab.tabId, held: event.tab.heldByUser, reason: event.tab.takeoverReason ?? null })
      }
    })
    void api
      .request("GET /browser/tabs", { botId })
      .then(({ tabs }) => {
        if (!hasTabEvent) selectTab(tabs)
      })
      .catch(() => {})

    return () => {
      active = false
      unsubscribe()
    }
  }, [api, botId, finished, resolutionCallId, tabId])

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
      held ||
      finished ||
      channel?.previewHidden ||
      takeoverSession
    )
      return

    return startInlineFrameSource(
      api,
      { id: botId, machine },
      activeTabId,
      (frame) => setPreviewFrame({ tabId: activeTabId, frame }),
      () => setPreviewError(t("Browser preview unavailable. Open the browser to reconnect.", {}, locale)),
      (reason) =>
        setPreviewError(reason ? t("Browser preview unavailable. Open the browser to reconnect.", {}, locale) : null),
      { intervalMs: 700 },
    )
  }, [
    activeTabId,
    api,
    botId,
    machine,
    canPreview,
    channel?.previewHidden,
    finished,
    expanded,
    held,
    hidden,
    locale,
    previewEnabled,
    takeoverSession,
    visible,
  ])

  const toggleTakeover = async (): Promise<void> => {
    if (!api || !activeTabId || busy) return
    setBusy(true)
    setError(null)
    try {
      if (takeoverSession) {
        if (!controlEpoch) throw new Error("Missing browser control epoch")
        await api.request(
          "DELETE /browser/tabs/:id/takeover/session",
          { sessionId: takeoverSession, controlEpoch },
          { id: activeTabId },
        )
        setTakeoverSession(null)
        setControlEpoch(null)
        setTakeoverViewEpoch(0)
        setHeldTab({ tabId: activeTabId, held: false, reason: null })
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
    } catch {
      setError(t("The browser tab could not be updated.", {}, locale))
    } finally {
      setBusy(false)
    }
  }

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
  const actions = browserTools.slice(-MAX_VISIBLE_ACTIONS)
  const completedActions = browserTools.filter((part) => part.ok === true).slice(-MAX_VISIBLE_ACTIONS)
  const currentAction = browserTools.at(-1)
  const title = t("Browser for {name}", { name: botName }, locale)
  const summary = t(
    browserTools.length === 1 ? "Used the browser · 1 action" : "Used the browser · {count} actions",
    { count: browserTools.length },
    locale,
  )
  const url =
    finished || channel?.previewHidden
      ? ""
      : getBrowserActivityUrl(preview?.url || getBrowserActivityOpenUrl(browserTools))
  const takeoverActive = held && !finished
  const takeoverReason = heldTab?.reason ?? "requested"
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
            botName={botName}
            locale={locale}
            reason={getBrowserTakeoverReason(browserTools) ?? reasonCopy}
            actions={browserTools.slice(-5).map((part) => ({
              id: part.callId,
              icon: getBrowserActivityIcon(part),
              label: getBrowserActivityLabel(part, locale),
              time: getBrowserActivityTime(part, createdAt, locale),
              active: part.ok === null,
            }))}
            onHandback={() => {
              setTakeoverSession(null)
              setControlEpoch(null)
              setTakeoverViewEpoch(0)
              setHeldTab({ tabId: activeTabId, held: false, reason: null })
            }}
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
      {completedActions.length > 0 && (
        <ol className="browser-activity-checklist" aria-label={t("Browser steps", {}, locale)}>
          {completedActions.map((part) => (
            <li key={part.callId}>
              <span aria-hidden="true">✓</span>
              <span>{t("Used the browser", {}, locale)}</span>
            </li>
          ))}
        </ol>
      )}
      <article
        className="browser-activity-card"
        ref={section}
        aria-label={title}
        data-finished={finished}
        data-held={held}
        data-expanded={expanded}
        data-show-all-actions={showAllActions}
      >
        {!finished && (
          <span
            className="browser-activity-progress"
            role="progressbar"
            aria-label={t("Browser progress", {}, locale)}
          />
        )}
        {finished ? (
          <button
            type="button"
            className="browser-activity-summary"
            aria-expanded={expanded}
            aria-controls={expanded ? contentId : undefined}
            onClick={() => setExpanded((value) => !value)}
          >
            <span className="browser-activity-summary-copy">
              <strong>{summary}</strong>
              <small>{t("See what it did", {}, locale)}</small>
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
            ) : null}
            <span aria-hidden="true">{expanded ? "−" : "+"}</span>
          </button>
        ) : (
          <header className="browser-activity-header">
            <div className="browser-activity-heading">
              <strong>{title}</strong>
              {currentAction && (
                <span className="browser-activity-subtitle">
                  {t(
                    "{name} · {action}",
                    { name: botName, action: getBrowserActivityCurrentLabel(currentAction, locale) },
                    locale,
                  )}
                </span>
              )}
              {url && (
                <fieldset className="browser-activity-address">
                  <legend className="visually-hidden">{t("Browser address", {}, locale)}</legend>
                  <span className="browser-activity-lock" role="img" aria-label={t("Secure connection", {}, locale)}>
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                      <rect x="3" y="7" width="10" height="7" rx="1.5" />
                      <path d="M5 7V5a3 3 0 0 1 6 0v2" />
                    </svg>
                  </span>
                  <span className="browser-activity-url" title={url}>
                    {url}
                  </span>
                  <span className="browser-activity-live">
                    <span className="channel-dot" aria-hidden="true" />
                    {t("Live preview", {}, locale)}
                  </span>
                </fieldset>
              )}
            </div>
            <ChannelVisibilityLabel locale={locale} />
            <ChannelControlNote locale={locale} />
            <div className="browser-activity-header-actions">
              {activeTabId && channel?.canControl !== false && (
                <button
                  type="button"
                  className="button button-quiet"
                  disabled={busy}
                  onClick={() => void toggleTakeover()}
                >
                  {busy ? (
                    t("Updating browser control…", {}, locale)
                  ) : (
                    <>
                      <span aria-hidden="true">{held ? "↩" : "↗"}</span>
                      {takeoverSession
                        ? t("Hand back to {name}", { name: botName }, locale)
                        : t("Take over browser", {}, locale)}
                    </>
                  )}
                </button>
              )}
              {previewEnabled && (
                <button
                  type="button"
                  className="browser-activity-icon-button"
                  aria-label={fullView ? t("Collapse browser view", {}, locale) : t("Expand browser view", {}, locale)}
                  aria-pressed={fullView}
                  disabled={!preview}
                  onClick={() => setFullView((value) => !value)}
                >
                  <span aria-hidden="true">{fullView ? "↙" : "↗"}</span>
                </button>
              )}
              <button
                type="button"
                className="browser-activity-icon-button"
                aria-label={expanded ? t("Collapse browser card", {}, locale) : t("Expand browser card", {}, locale)}
                aria-expanded={expanded}
                aria-controls={expanded ? contentId : undefined}
                onClick={() => setExpanded((value) => !value)}
              >
                <span aria-hidden="true">{expanded ? "⌃" : "⌄"}</span>
              </button>
            </div>
          </header>
        )}
        {expanded && (
          <div
            id={contentId}
            className={`browser-activity-content${fullView || finished || !previewEnabled ? " browser-activity-content-full" : ""}`}
          >
            {!finished && (channel?.previewHidden || previewEnabled) && (
              <div className={`browser-activity-preview${fullView ? " browser-activity-preview-full" : ""}`}>
                {channel?.previewHidden ? (
                  <ChannelHiddenPreview locale={locale} />
                ) : preview?.src ? (
                  <BrowserPreviewImage src={preview.src} alt={t("Current browser page", {}, locale)} />
                ) : previewEnabled ? (
                  <p className="browser-activity-placeholder">
                    {previewError ?? t("Waiting for the browser page…", {}, locale)}
                  </p>
                ) : null}
                {preview?.src && previewError && <small role="status">{previewError}</small>}
              </div>
            )}
            <div
              className="browser-activity-log"
              role="log"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: The bounded action history needs keyboard scrolling.
              tabIndex={0}
              aria-label={t(takeoverActive ? "Recent actions" : "Browser activity", {}, locale)}
              aria-live={finished ? "off" : "polite"}
            >
              {takeoverActive && (
                <section className="browser-takeover-reason">
                  <strong>{t("Why {name} paused", { name: botName }, locale)}</strong>
                  <p>{reasonCopy}</p>
                  <p>{t("The bot is paused until you hand control back.", {}, locale)}</p>
                </section>
              )}
              <strong>{t(takeoverActive ? "Recent actions" : "Browser activity", {}, locale)}</strong>
              <ol>
                {actions.map((part) => (
                  <li
                    key={part.callId}
                    data-current={part.callId === currentAction?.callId && !finished}
                    data-status={part.ok === null ? "in-progress" : part.ok === false ? "failed" : "complete"}
                  >
                    <span className="browser-activity-action-icon" aria-hidden="true">
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d={actionIcons[getBrowserActivityKind(part)] ?? actionIcons.other} />
                      </svg>
                    </span>
                    <span className="browser-activity-action-label">
                      {getBrowserActivityLabel(part, locale)}
                      {getBrowserActivityNotice(part, locale) && (
                        <small>{getBrowserActivityNotice(part, locale)}</small>
                      )}
                    </span>
                    <span
                      className="browser-activity-action-state"
                      role="img"
                      aria-label={t(
                        part.ok === null
                          ? "Action in progress"
                          : part.ok === false
                            ? "Action failed"
                            : "Action complete",
                        {},
                        locale,
                      )}
                      data-status={part.ok === null ? "in-progress" : part.ok === false ? "failed" : "complete"}
                    >
                      {part.ok === null ? (
                        <span className="browser-activity-action-spinner" aria-hidden="true" />
                      ) : null}
                      {part.ok === false ? "!" : part.ok === true ? "✓" : null}
                    </span>
                    <time dateTime={new Date(part.startedAt ?? part.resolvedAt ?? createdAt).toISOString()}>
                      {getBrowserActivityTime(part, createdAt, locale)}
                    </time>
                  </li>
                ))}
              </ol>
              {actions.length > 3 && (
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
              {takeoverActive && (
                <p className="browser-takeover-privacy">
                  {t("What you type in the browser stays out of chat and the bot's context.", {}, locale)}
                </p>
              )}
              {takeoverSession && held && <p role="status">{t("You have control of this browser tab.", {}, locale)}</p>}
              {error && <p role="alert">{error}</p>}
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

const getTakeoverReasonCopy = (reason: BrowserTakeoverReason, locale: Locale): string => {
  if (reason === "login") return t("The site asked you to sign in before continuing.", {}, locale)
  if (reason === "payment")
    return t("The site asked you to review a purchase or payment before continuing.", {}, locale)
  if (reason === "form_submit") return t("The site asked you to submit a form before continuing.", {}, locale)
  if (reason === "requested") return t("This browser is under your control now.", {}, locale)

  return t("The site needs your confirmation before continuing.", {}, locale)
}
