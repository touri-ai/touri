import type { BrowserTabInfo, Id, MessagePart } from "@touri/contracts"
import { type ReactNode, useContext, useEffect, useId, useRef, useState } from "react"
import { clearBrowserHold, setBrowserHold } from "../features/desktop/browserHold"
import { InlinePreviewContext } from "../features/desktop/InlineLivePreview"
import { type PreviewFrame, startInlineFrameSource } from "../features/desktop/inlineFrameSource"
import { useInlinePreviewPreference } from "../features/desktop/inlinePreviewPreference"
import { type Locale, t } from "../i18n"
import { BrowserIcon, getBrowserIconName } from "./BrowserIcon"
import {
  getBrowserActivityCurrentLabel,
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
  isBrowserActivityRunning,
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
  finished,
  createdAt,
  botName,
  locale = "pt-BR",
  children,
}: {
  parts: readonly MessagePart[]
  finished: boolean
  createdAt: number
  botName: string
  locale?: Locale
  /** Narration and step rows folded into the finished card ("Ver o que ele fez"). */
  children?: ReactNode
}) => {
  const context = useContext(InlinePreviewContext)
  const previewEnabled = useInlinePreviewPreference()
  const browserTools = getBrowserActivityTools(parts)
  const tabId = getBrowserActivityTabId(browserTools)
  const resolutionCallId = tabId ? "" : (browserTools.at(-1)?.callId ?? "")
  const [resolvedTab, setResolvedTab] = useState<{ callId: string; tabId: string }>()
  const activeTabId = tabId ?? (resolvedTab?.callId === resolutionCallId ? resolvedTab.tabId : undefined)
  const [previewFrame, setPreviewFrame] = useState<{ tabId: string; frame: PreviewFrame }>()
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [heldTab, setHeldTab] = useState<{ tabId: string; held: boolean }>()
  const held = heldTab?.tabId === activeTabId && heldTab?.held === true
  // Privacy: while the person controls the tab, no frame is shown or kept.
  const preview = held || previewFrame?.tabId !== activeTabId ? undefined : previewFrame?.frame
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(!finished)
  const [fullView, setFullView] = useState(false)
  const [showAll, setShowAll] = useState(false)
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
  const canPreview = !!api && !!bot && (bot.machine === "local" || context?.machine?.status === "running")
  const completedCount = browserTools.filter((part) => !isBrowserActivityRunning(part)).length
  const needsTabRef = useRef(!activeTabId)
  needsTabRef.current = !activeTabId

  useEffect(() => {
    const updateVisibility = () => setHidden(document.hidden)
    document.addEventListener("visibilitychange", updateVisibility)

    return () => document.removeEventListener("visibilitychange", updateVisibility)
  }, [])

  useEffect(() => {
    if (finished) setExpanded(false)
  }, [finished])

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
      setHeldTab({ tabId: candidate.tabId, held: candidate.heldByUser })
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
        setHeldTab({ tabId: event.tab.tabId, held: event.tab.heldByUser })
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
    // A tab that was not ready on the first read is looked up again until it resolves.
    const poll = window.setInterval(() => {
      if (needsTabRef.current) void loadTabs()
    }, TAB_POLL_MS)

    return () => {
      active = false
      window.clearInterval(poll)
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
      finished ||
      held
    )
      return

    const source = startInlineFrameSource(
      api,
      { id: botId, machine },
      activeTabId,
      (frame) => setPreviewFrame({ tabId: activeTabId, frame }),
      () => setPreviewError(t("Browser preview unavailable. Open the browser to reconnect.", {}, locale)),
      (reason) =>
        setPreviewError(reason ? t("Browser preview unavailable. Open the browser to reconnect.", {}, locale) : null),
      { intervalMs: 3_000 },
    )
    frameSource.current = source

    return () => {
      frameSource.current = undefined
      source()
    }
  }, [activeTabId, api, botId, machine, canPreview, finished, held, hidden, locale, previewEnabled, visible])

  useEffect(() => {
    if (held) setPreviewFrame(undefined)
  }, [held])

  // Each finished action refreshes the thumbnail so it never lags behind the subtitle.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the count is the trigger
  useEffect(() => {
    frameSource.current?.refresh?.()
  }, [completedCount])

  useEffect(() => {
    setWaitedTooLong(false)
    if (finished || held || preview) return
    const timer = window.setTimeout(() => setWaitedTooLong(true), WAITING_TIMEOUT_MS)

    return () => window.clearTimeout(timer)
  }, [finished, held, preview])

  // biome-ignore lint/correctness/useExhaustiveDependencies: the row count is the trigger
  useEffect(() => {
    const list = logList.current
    if (!list || finished) return
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 48
    if (nearBottom) list.scrollTop = list.scrollHeight
  }, [browserTools.length, finished])

  const toggleTakeover = async (): Promise<void> => {
    if (!api || !activeTabId || busy) return
    setBusy(true)
    setError(null)
    try {
      await api.request("POST /browser/tabs/:id/takeover", { hold: !held }, { id: activeTabId })
      setHeldTab({ tabId: activeTabId, held: !held })
      if (!held) context?.onOpenComputer()
    } catch {
      setError(t("The browser tab could not be updated.", {}, locale))
    } finally {
      setBusy(false)
    }
  }
  toggleTakeoverRef.current = toggleTakeover

  useEffect(() => {
    if (!botId || !activeTabId || !held || finished) return
    setBrowserHold(botId, { tabId: activeTabId, release: () => void toggleTakeoverRef.current() })

    return () => clearBrowserHold(botId, activeTabId)
  }, [activeTabId, botId, finished, held])

  if (!browserTools.length) return null

  const screenshot = getBrowserActivityScreenshot(browserTools)
  const actions = browserTools.slice(-MAX_VISIBLE_ACTIONS)
  const times = getBrowserActivityTimestamps(actions, createdAt)
  const currentAction = browserTools.at(-1)
  const title = t("Browser for {name}", { name: botName }, locale)
  const summary = t(
    browserTools.length === 1 ? "Used the browser · 1 action" : "Used the browser · {count} actions",
    { count: browserTools.length },
    locale,
  )
  const shortUrl = getBrowserActivityShortUrl(preview?.url || getBrowserActivityOpenUrl(browserTools))
  const subtitle = [botName, currentAction && getBrowserActivitySubtitleAction(currentAction, locale), shortUrl]
    .filter(Boolean)
    .join(" · ")
  const finalUrl = getBrowserActivityShortUrl(getBrowserActivityOpenUrl(browserTools))

  return (
    <article
      className="browser-activity-card"
      ref={section}
      aria-label={title}
      data-finished={finished}
      data-held={held}
      data-expanded={expanded}
    >
      {!finished && (
        <span className="browser-activity-progress" role="progressbar" aria-label={t("Browser progress", {}, locale)} />
      )}
      {finished ? (
        <button
          type="button"
          className="browser-activity-summary"
          aria-expanded={expanded}
          aria-controls={contentId}
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
              {finalUrl && <small>{finalUrl}</small>}
            </span>
          ) : null}
          <span className="browser-activity-chevron" aria-hidden="true">
            <BrowserIcon name={expanded ? "chevronUp" : "chevronDown"} />
          </span>
        </button>
      ) : (
        <header className="browser-activity-header">
          <div className="browser-activity-heading">
            <strong>{title}</strong>
            <span className="browser-activity-subtitle" title={subtitle}>
              {subtitle}
            </span>
          </div>
          <div className="browser-activity-header-actions">
            <button
              type="button"
              className="button button-quiet browser-activity-takeover-button"
              disabled={busy || !activeTabId}
              title={activeTabId ? undefined : t("Preparing the browser…", {}, locale)}
              aria-label={held ? t("Hand back to {name}", { name: botName }, locale) : undefined}
              onClick={() => void toggleTakeover()}
            >
              <BrowserIcon name="person" />
              {busy
                ? t("Updating browser control…", {}, locale)
                : held
                  ? t("Hand back", {}, locale)
                  : t("Take over tab", {}, locale)}
            </button>
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
              aria-controls={contentId}
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
          {!finished && held && (
            <div className="browser-activity-takeover" role="status">
              <strong>{t("Why {name} stopped", { name: botName }, locale)}</strong>
              <p>{t("{name} paused so you can handle this step in the browser.", { name: botName }, locale)}</p>
              <p className="browser-activity-privacy">
                {t("What you type here does not go to the chat or to {name}.", { name: botName }, locale)}
              </p>
              <small>{t("Preview hidden while you are in control.", {}, locale)}</small>
            </div>
          )}
          {!finished && !held && previewEnabled && (
            <div className={`browser-activity-preview${fullView ? " browser-activity-preview-full" : ""}`}>
              {preview?.src ? (
                <BrowserPreviewImage src={preview.src} alt={t("Current browser page", {}, locale)} />
              ) : (
                <p className="browser-activity-placeholder">
                  {previewError ??
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
              )}
              {preview?.src && previewError && <small role="status">{previewError}</small>}
            </div>
          )}
          <div
            className="browser-activity-log"
            data-all={showAll}
            role="log"
            aria-label={t("Browser activity", {}, locale)}
            aria-live={finished ? "off" : "polite"}
            ref={logList}
          >
            {finished && <strong>{t("Browser activity", {}, locale)}</strong>}
            <ol>
              {actions.map((part, index) => (
                <li
                  key={part.callId}
                  data-current={!finished && index === actions.length - 1}
                  data-running={!finished && isBrowserActivityRunning(part)}
                >
                  <span className="browser-activity-action-icon" aria-hidden="true">
                    <BrowserIcon name={getBrowserIconName(getBrowserActivityKind(part))} />
                  </span>
                  <span className="browser-activity-action-label">
                    {isBrowserActivityRunning(part)
                      ? getBrowserActivityCurrentLabel(part, locale)
                      : getBrowserActivityLabel(part, locale)}
                    {getBrowserActivityNotice(part, locale) && <small>{getBrowserActivityNotice(part, locale)}</small>}
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
                className="text-button browser-activity-show-all"
                aria-pressed={showAll}
                onClick={() => setShowAll((value) => !value)}
              >
                {t(showAll ? "Show fewer" : "Show all", {}, locale)}
              </button>
            )}
            {browserTools.length > MAX_VISIBLE_ACTIONS && (
              <small>{t("Showing the latest {count} browser actions", { count: MAX_VISIBLE_ACTIONS }, locale)}</small>
            )}
            {error && <p role="alert">{error}</p>}
          </div>
        </div>
      )}
    </article>
  )
}
