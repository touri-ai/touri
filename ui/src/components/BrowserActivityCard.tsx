import type { BrowserTabInfo, BrowserTakeoverReason, Id, MessagePart } from "@touri/contracts"
import { type ReactNode, useContext, useEffect, useId, useRef, useState } from "react"
import {
  ChannelCardFooter,
  ChannelControlNote,
  ChannelHiddenPreview,
  ChannelVisibilityLabel,
  useChannelBrowserView,
} from "../features/channelBrowser/ChannelBrowser"
import { clearBrowserHold, setBrowserHold } from "../features/desktop/browserHold"
import { InlinePreviewContext } from "../features/desktop/InlineLivePreview"
import { type PreviewFrame, startInlineFrameSource } from "../features/desktop/inlineFrameSource"
import { useInlinePreviewPreference } from "../features/desktop/inlinePreviewPreference"
import { type Locale, t } from "../i18n"
import { useBrowserActivityControls } from "./BrowserActivityControls"
import { BrowserIcon, getBrowserIconName } from "./BrowserIcon"
import { BrowserTakeoverView } from "./BrowserTakeoverView"
import {
  getBrowserActivityCurrentLabel,
  getBrowserActivityIcon,
  getBrowserActivityKind,
  getBrowserActivityLabel,
  getBrowserActivityNotice,
  getBrowserActivityOpenUrl,
  getBrowserActivityScreenshot,
  getBrowserActivityShortUrl,
  getBrowserActivitySubtitleAction,
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
  const channel = useChannelBrowserView()
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
  const resumedRunId = useRef<string | null>(null)
  const handbackRunId = useRef<Id | null | undefined>(undefined)
  const [privacyPending, setPrivacyPending] = useState(false)
  const held = heldTab?.tabId === activeTabId && heldTab?.held === true
  const heldRef = useRef(held)
  heldRef.current = held
  const finished = sourceFinished && !waitingForPerson && !held && !takeoverSession && !resuming && !queued
  const preview =
    !held && !channel?.previewHidden && previewFrame?.tabId === activeTabId ? previewFrame?.frame : undefined
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(!finished)
  const [showAllActions, setShowAllActions] = useState(false)
  const [fullView, setFullView] = useState(false)
  const [waitedTooLong, setWaitedTooLong] = useState(false)
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
  const canPreview = !queued && !!api && !!bot && (bot.machine === "local" || context?.machine?.status === "running")
  const completedCount = browserTools.filter((part) => !isBrowserActivityRunning(part)).length
  const needsTabRef = useRef(!activeTabId)
  needsTabRef.current = !activeTabId
  useEffect(() => {
    if (takeoverTabId.current === activeTabId) return
    takeoverTabId.current = activeTabId
    setTakeoverSession(null)
    setControlEpoch(null)
    setTakeoverViewEpoch(0)
  }, [activeTabId])

  useEffect(() => {
    if (!sourceFinished || (resuming && runId !== handbackRunId.current)) setResuming(false)
  }, [sourceFinished, resuming, runId])

  useEffect(() => {
    if (!api || !resuming) return
    return api.subscribe(({ event }) => {
      if (event.type !== "run.updated" || event.run.botId !== botId) return
      if (threadId && event.run.threadId !== threadId && event.run.groupThreadId !== threadId) return
      const active = ["queued", "starting", "running"].includes(event.run.status)
      if (!resumedRunId.current && event.run.trigger === "retry" && active) resumedRunId.current = event.run.id
      if (event.run.id !== resumedRunId.current || active) return
      resumedRunId.current = null
      setResuming(false)
    })
  }, [api, botId, resuming, threadId])

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
        if (event.tab.heldByUser) setPreviewFrame(undefined)
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

    const source = startInlineFrameSource(
      api,
      { id: botId, machine },
      activeTabId,
      (frame) => {
        setPrivacyPending(false)
        setPreviewFrame({ tabId: activeTabId, frame })
      },
      () => setPreviewError(t("Browser preview unavailable. Open the browser to reconnect.", {}, locale)),
      (reason) =>
        setPreviewError(reason ? t("Browser preview unavailable. Open the browser to reconnect.", {}, locale) : null),
      { intervalMs: 700 },
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
    channel?.previewHidden,
    expanded,
    finished,
    held,
    hidden,
    locale,
    previewEnabled,
    takeoverSession,
    visible,
  ])

  useEffect(() => {
    if (held || channel?.previewHidden) {
      setPrivacyPending(true)
      setPreviewFrame(undefined)
    }
  }, [channel?.previewHidden, held])

  // Refresh after each completed browser action; the source keeps sampling serial and throttled.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the action count is the trigger
  useEffect(() => {
    frameSource.current?.refresh?.()
  }, [completedCount])

  useEffect(() => {
    setWaitedTooLong(false)
    if (finished || held || preview || !expanded) return
    const timer = window.setTimeout(() => setWaitedTooLong(true), WAITING_TIMEOUT_MS)

    return () => window.clearTimeout(timer)
  }, [expanded, finished, held, preview])

  // Preserve a user's scroll position when they inspect earlier browser actions.
  // biome-ignore lint/correctness/useExhaustiveDependencies: row count changes trigger this check
  useEffect(() => {
    const list = logList.current
    if (!list || finished) return
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 48
    if (nearBottom) list.scrollTop = list.scrollHeight
  }, [browserTools.length, finished])

  const toggleTakeover = async (): Promise<void> => {
    if (!api || !activeTabId || busy || queued) return
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
        handbackRunId.current = runId
        setResuming(sourceFinished && held)
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
  const finalPreview = !held && !channel?.previewHidden ? preview : undefined
  const actions = browserTools.slice(-MAX_VISIBLE_ACTIONS)
  const times = getBrowserActivityTimestamps(actions, createdAt)
  const takeoverActions = browserTools.slice(-5)
  const takeoverTimes = getBrowserActivityTimestamps(takeoverActions, createdAt)
  const currentAction = browserTools.at(-1)
  const previewNotice = privacyPending
    ? t("Your last page stays private until a new safe page is ready.", {}, locale)
    : previewError
  const title = t("Browser for {name}", { name: botName }, locale)
  const summary = t(
    browserTools.length === 1 ? "Used the browser · 1 action" : "Used the browser · {count} actions",
    { count: browserTools.length },
    locale,
  )
  const url =
    finished || channel?.previewHidden
      ? ""
      : getBrowserActivityShortUrl(preview?.url ?? "") || getBrowserActivityOpenUrl(browserTools)
  const subtitle = [
    botName,
    queued
      ? t("Waiting for the other browser request to finish.", {}, locale)
      : currentAction && getBrowserActivitySubtitleAction(currentAction, locale),
    url,
  ]
    .filter(Boolean)
    .join(" · ")
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
            actions={takeoverActions.map((part, index) => ({
              id: part.callId,
              icon: getBrowserActivityIcon(part),
              label: getBrowserActivityLabel(part, locale),
              time: getBrowserActivityTime(takeoverTimes[index] ?? createdAt, locale),
              active: part.ok === null,
            }))}
            onSessionEnded={() => {
              setTakeoverSession(null)
              setControlEpoch(null)
              setTakeoverViewEpoch(0)
              setResuming(false)
              setHeldTab({ tabId: activeTabId, held: false, reason: null })
            }}
            onHandback={() => {
              handbackRunId.current = runId
              setResuming(sourceFinished && held)
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
      <article
        className="browser-activity-card"
        ref={section}
        aria-label={title}
        data-finished={finished}
        data-held={held}
        data-expanded={expanded}
        data-show-all-actions={finished || showAllActions}
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
            className={`browser-activity-summary${screenshot?.outputAttachmentId ? "" : " browser-activity-summary-compact"}`}
            aria-expanded={expanded}
            aria-controls={expanded ? contentId : undefined}
            onClick={() => setExpanded((value) => !value)}
          >
            <span className="browser-activity-summary-copy">
              <strong>{summary}</strong>
              <small>{t("See what the bot did", {}, locale)}</small>
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
          <header className="browser-activity-header">
            <div className="browser-activity-heading">
              <strong>{title}</strong>
              {subtitle && <span className="browser-activity-subtitle">{subtitle}</span>}
            </div>
            <ChannelVisibilityLabel locale={locale} />
            <ChannelControlNote locale={locale} />
            <div className="browser-activity-header-actions">
              {channel?.canControl !== false && (
                <button
                  type="button"
                  className="button button-quiet"
                  disabled={busy || !activeTabId || queued}
                  title={activeTabId ? undefined : t("Preparing the browser…", {}, locale)}
                  onClick={() => void toggleTakeover()}
                >
                  {busy ? (
                    t("Updating browser control…", {}, locale)
                  ) : (
                    <>
                      <BrowserIcon name="person" />
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
                  <BrowserIcon name={fullView ? "collapse" : "expand"} />
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
                <BrowserIcon name={expanded ? "chevronUp" : "chevronDown"} />
              </button>
            </div>
          </header>
        )}
        {expanded && (
          <div
            id={contentId}
            className={`browser-activity-content${fullView || finished || !previewEnabled ? " browser-activity-content-full" : ""}`}
          >
            {finished && children && <div className="browser-activity-history">{children}</div>}
            {!finished && (channel?.previewHidden || previewEnabled) && (
              <div className={`browser-activity-preview${fullView ? " browser-activity-preview-full" : ""}`}>
                {channel?.previewHidden ? (
                  <ChannelHiddenPreview locale={locale} />
                ) : preview?.src ? (
                  <div className="browser-activity-window">
                    <div className="browser-activity-chrome" aria-hidden="true">
                      <span className="browser-activity-chrome-lock" />
                      <span className="browser-activity-chrome-live" />
                      {t("Live", {}, locale)}
                    </div>
                    <BrowserPreviewImage src={preview.src} alt={t("Current browser page", {}, locale)} />
                  </div>
                ) : previewEnabled ? (
                  <p className="browser-activity-placeholder">
                    {previewNotice ??
                      t(
                        waitedTooLong
                          ? "The browser is taking longer than expected. Trying to reconnect…"
                          : activeTabId
                            ? "Waiting for the browser page…"
                            : "Preparing the browser…",
                        {},
                        locale,
                      )}
                  </p>
                ) : null}
                {preview?.src && previewError && <small role="status">{previewError}</small>}
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
              {takeoverActive && (
                <section className="browser-takeover-reason">
                  <strong>{t("Why {name} paused", { name: botName }, locale)}</strong>
                  <p>{reasonCopy}</p>
                  <p>{t("The bot is paused until you hand control back.", {}, locale)}</p>
                </section>
              )}
              <strong>{t(takeoverActive ? "Recent actions" : "Browser activity", {}, locale)}</strong>
              <ol>
                {actions.map((part, index) => (
                  <li
                    key={part.callId}
                    data-current={part.callId === currentAction?.callId && !finished}
                    data-running={!finished && isBrowserActivityRunning(part)}
                    data-status={part.ok === null ? "in-progress" : part.ok === false ? "failed" : "complete"}
                  >
                    <span className="browser-activity-action-icon" aria-hidden="true">
                      <BrowserIcon name={getBrowserIconName(getBrowserActivityKind(part))} />
                    </span>
                    <span className="browser-activity-action-label">
                      {!finished && isBrowserActivityRunning(part)
                        ? getBrowserActivityCurrentLabel(part, locale)
                        : getBrowserActivityLabel(part, locale)}
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
