import type { BrowserTabInfo, Id, MessagePart } from "@touri/contracts"
import { useContext, useEffect, useRef, useState } from "react"
import { InlinePreviewContext } from "../features/desktop/InlineLivePreview"
import { type PreviewFrame, startInlineFrameSource } from "../features/desktop/inlineFrameSource"
import { useInlinePreviewPreference } from "../features/desktop/inlinePreviewPreference"
import { type Locale, t } from "../i18n"
import {
  getBrowserActivityLabel,
  getBrowserActivityNotice,
  getBrowserActivityScreenshot,
  getBrowserActivityTabId,
  getBrowserActivityTime,
  getBrowserActivityTools,
  getBrowserActivityUrl,
} from "./browserActivityPresentation"
import { StoredToolOutput } from "./ToolOutput"
import "./browser-activity.css"

const MAX_VISIBLE_ACTIONS = 16

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
  const previewEnabled = useInlinePreviewPreference()
  const browserTools = getBrowserActivityTools(parts)
  const tabId = getBrowserActivityTabId(browserTools)
  const resolutionCallId = tabId ? "" : (browserTools.at(-1)?.callId ?? "")
  const [resolvedTab, setResolvedTab] = useState<{ callId: string; tabId: string }>()
  const activeTabId = tabId ?? (resolvedTab?.callId === resolutionCallId ? resolvedTab.tabId : undefined)
  const [previewFrame, setPreviewFrame] = useState<{ tabId: string; frame: PreviewFrame }>()
  const preview = previewFrame?.tabId === activeTabId ? previewFrame?.frame : undefined
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [heldTab, setHeldTab] = useState<{ tabId: string; held: boolean }>()
  const held = heldTab?.tabId === activeTabId && heldTab?.held === true
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(!finished)
  const [fullView, setFullView] = useState(false)
  const section = useRef<HTMLElement>(null)
  const [visible, setVisible] = useState(false)
  const [hidden, setHidden] = useState(document.hidden)
  const api = context?.api
  const bot = context?.bot
  const botId = bot?.id
  const machine = bot?.machine
  const canPreview = !!api && !!bot && (bot.machine === "local" || context?.machine?.status === "running")

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
    if (!api || !botId || !machine || !activeTabId || !canPreview || !previewEnabled || !visible || hidden || finished)
      return

    return startInlineFrameSource(
      api,
      { id: botId, machine },
      activeTabId,
      (frame) => setPreviewFrame({ tabId: activeTabId, frame }),
      () => setPreviewError(t("Browser preview unavailable. Open the browser to reconnect.", {}, locale)),
      (reason) =>
        setPreviewError(reason ? t("Browser preview unavailable. Open the browser to reconnect.", {}, locale) : null),
      { intervalMs: 3_000 },
    )
  }, [activeTabId, api, botId, machine, canPreview, finished, hidden, locale, previewEnabled, visible])

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

  if (!browserTools.length) return null

  const screenshot = getBrowserActivityScreenshot(browserTools)
  const actions = browserTools.slice(-MAX_VISIBLE_ACTIONS)
  const title = t("Browser for {name}", { name: botName }, locale)
  const summary = t(
    browserTools.length === 1 ? "Used the browser · 1 action" : "Used the browser · {count} actions",
    { count: browserTools.length },
    locale,
  )
  const url = finished ? "" : getBrowserActivityUrl(preview?.url ?? "")

  return (
    <article
      className="browser-activity-card"
      ref={section}
      aria-label={title}
      data-finished={finished}
      data-held={held}
    >
      {finished ? (
        <button
          type="button"
          className="browser-activity-summary"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <span className="browser-activity-summary-copy">
            <strong>{summary}</strong>
            {url && <small>{url}</small>}
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
          <div>
            <strong>{title}</strong>
            {url && <span title={url}>{url}</span>}
          </div>
          {activeTabId && (
            <button type="button" className="button button-quiet" disabled={busy} onClick={() => void toggleTakeover()}>
              {busy
                ? t("Updating browser control…", {}, locale)
                : held
                  ? t("Hand back to {name}", { name: botName }, locale)
                  : t("Take over", {}, locale)}
            </button>
          )}
        </header>
      )}
      {expanded && (
        <div
          className={`browser-activity-content${fullView || finished || !previewEnabled ? " browser-activity-content-full" : ""}`}
        >
          {!finished && previewEnabled && (
            <div className={`browser-activity-preview${fullView ? " browser-activity-preview-full" : ""}`}>
              {preview?.src ? (
                <img src={preview.src} alt={t("Current browser page", {}, locale)} />
              ) : (
                <p className="browser-activity-placeholder">
                  {previewError ?? t("Waiting for the browser page…", {}, locale)}
                </p>
              )}
              {preview?.src && previewError && <small role="status">{previewError}</small>}
              {url && <span title={url}>{url}</span>}
              <div className="browser-activity-preview-actions">
                <button type="button" disabled={!preview} onClick={() => setFullView((value) => !value)}>
                  {fullView ? t("Collapse browser view", {}, locale) : t("Expand browser view", {}, locale)}
                </button>
                <button type="button" onClick={() => context?.onOpenComputer()} disabled={!context}>
                  {t("Open browser", {}, locale)}
                </button>
              </div>
            </div>
          )}
          <div
            className="browser-activity-log"
            role="log"
            aria-label={t("Browser activity", {}, locale)}
            aria-live={finished ? "off" : "polite"}
          >
            <strong>{t("Browser activity", {}, locale)}</strong>
            <ol>
              {actions.map((part) => (
                <li key={part.callId}>
                  <time dateTime={new Date(part.startedAt ?? part.resolvedAt ?? createdAt).toISOString()}>
                    {getBrowserActivityTime(part, createdAt, locale)}
                  </time>
                  <span>
                    {getBrowserActivityLabel(part, locale)}
                    {getBrowserActivityNotice(part, locale) && <small>{getBrowserActivityNotice(part, locale)}</small>}
                  </span>
                </li>
              ))}
            </ol>
            {browserTools.length > MAX_VISIBLE_ACTIONS && (
              <small>{t("Showing the latest {count} browser actions", { count: MAX_VISIBLE_ACTIONS }, locale)}</small>
            )}
            {held && <p role="status">{t("You have control of this browser tab.", {}, locale)}</p>}
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
  )
}
