import type { BrowserTabInfo, Id, MessagePart } from "@touri/contracts"
import { useContext, useEffect, useRef, useState } from "react"
import { ApiError, userFacingError } from "../errors"
import { InlinePreviewContext } from "../features/desktop/InlineLivePreview"
import { type PreviewFrame, startInlineFrameSource } from "../features/desktop/inlineFrameSource"
import { type Locale, t } from "../i18n"
import {
  getBrowserActivityLabel,
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
  const browserTools = getBrowserActivityTools(parts)
  const tabId = getBrowserActivityTabId(browserTools)
  const [resolvedTabId, setResolvedTabId] = useState<string>()
  const activeTabId = tabId ?? resolvedTabId
  const [preview, setPreview] = useState<PreviewFrame>()
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [held, setHeld] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(!finished)
  const [fullView, setFullView] = useState(false)
  const section = useRef<HTMLElement>(null)
  const [visible, setVisible] = useState(false)
  const api = context?.api
  const bot = context?.bot
  const canPreview = !!api && !!bot && (bot.machine === "local" || context?.machine?.status === "running")

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
    if (!api || !bot) return
    let active = true
    const selectTab = (tabs: Array<BrowserTabInfo & { ownerBotId: Id | null }>) => {
      const candidate = tabs
        .filter((tab) => tab.ownerBotId === bot.id && tab.state === "live" && (!tabId || tab.tabId === tabId))
        .reduce<(typeof tabs)[number] | undefined>(
          (latest, current) => (!latest || current.lastUsedAt > latest.lastUsedAt ? current : latest),
          undefined,
        )
      if (!candidate || !active) return
      if (!tabId) setResolvedTabId(candidate.tabId)
      setHeld(candidate.heldByUser)
    }
    const unsubscribe = api.subscribe(({ event }) => {
      if (event.type === "browser.tab" && event.tab.ownerBotId === bot.id && (!tabId || event.tab.tabId === tabId)) {
        if (!tabId) setResolvedTabId(event.tab.tabId)
        setHeld(event.tab.heldByUser)
      }
    })
    void api
      .request("GET /browser/tabs", { botId: bot.id })
      .then(({ tabs }) => selectTab(tabs))
      .catch(() => {})

    return () => {
      active = false
      unsubscribe()
    }
  }, [api, bot, tabId])

  useEffect(() => {
    if (!api || !bot || !canPreview || !visible) return

    setPreviewError(null)
    return startInlineFrameSource(
      api,
      { id: bot.id, machine: bot.machine },
      activeTabId,
      (frame) => setPreview(frame),
      (reason) => setPreviewError(reason ?? null),
      setPreviewError,
      { intervalMs: 3_000, once: finished },
    )
  }, [activeTabId, api, bot, canPreview, finished, visible])

  const toggleTakeover = async (): Promise<void> => {
    if (!api || !activeTabId || busy) return
    setBusy(true)
    setError(null)
    try {
      await api.request("POST /browser/tabs/:id/takeover", { hold: !held }, { id: activeTabId })
      setHeld(!held)
      if (!held) context?.onOpenComputer()
    } catch (reason) {
      setError(reason instanceof ApiError ? userFacingError(reason) : t("The browser tab could not be updated."))
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
  const url = getBrowserActivityUrl(preview?.url ?? "")

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
            <StoredToolOutput
              key={screenshot.outputAttachmentId}
              api={api}
              attachmentId={screenshot.outputAttachmentId}
              preview={screenshot.outputPreview}
              callId={screenshot.callId}
              browser
              autoOpen
              thumbnail
              thumbnailFallback={preview?.src}
            />
          ) : (
            preview?.src && <img src={preview.src} alt={t("Final browser screenshot", {}, locale)} />
          )}
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
        <div className="browser-activity-content">
          <div className={`browser-activity-preview${fullView ? " browser-activity-preview-full" : ""}`}>
            {preview?.src ? (
              <img src={preview.src} alt={t("Current browser page", {}, locale)} />
            ) : (
              <p>{previewError ?? t("Waiting for the browser page…", {}, locale)}</p>
            )}
            {url && <span title={url}>{url}</span>}
            <div className="browser-activity-preview-actions">
              <button type="button" disabled={!preview} onClick={() => setFullView((value) => !value)}>
                {fullView ? t("Collapse browser view", {}, locale) : t("Expand browser view", {}, locale)}
              </button>
              {activeTabId && finished && (
                <button type="button" disabled={busy} onClick={() => void toggleTakeover()}>
                  {busy
                    ? t("Updating browser control…", {}, locale)
                    : held
                      ? t("Hand back to {name}", { name: botName }, locale)
                      : t("Take over", {}, locale)}
                </button>
              )}
            </div>
          </div>
          <div className="browser-activity-log">
            <strong>{t("Browser activity", {}, locale)}</strong>
            <ol>
              {actions.map((part) => (
                <li key={part.callId}>
                  <time dateTime={new Date(part.startedAt ?? part.resolvedAt ?? createdAt).toISOString()}>
                    {getBrowserActivityTime(part, createdAt, locale)}
                  </time>
                  <span>{getBrowserActivityLabel(part, locale)}</span>
                </li>
              ))}
            </ol>
            {browserTools.length > MAX_VISIBLE_ACTIONS && (
              <small>{t("Showing the latest {count} browser actions", { count: MAX_VISIBLE_ACTIONS }, locale)}</small>
            )}
            {held && <p role="status">{t("You have control of this browser tab.", {}, locale)}</p>}
            {error && <p role="alert">{error}</p>}
            {screenshot?.outputAttachmentId && (
              <section className="browser-activity-final-shot" aria-label={t("Final browser screenshot", {}, locale)}>
                <strong>{t("Final browser screenshot", {}, locale)}</strong>
                <StoredToolOutput
                  key={screenshot.outputAttachmentId}
                  api={api}
                  attachmentId={screenshot.outputAttachmentId}
                  preview={screenshot.outputPreview}
                  callId={screenshot.callId}
                  browser
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
