import type { Bot, BrowserChannelRun, ChannelPerson } from "@touri/contracts"
import { createContext, type ReactNode, useCallback, useContext } from "react"
import { useBrowserActivityControls } from "../../components/BrowserActivityControls"
import { type Locale, t } from "../../i18n"
import { useBrowserHold } from "../desktop/browserHold"
import {
  type ChannelBrowserState,
  type ChannelBrowserView,
  getChannelBrowserValue,
  getChannelBrowserView,
  getChannelPersonLabel,
  getChannelQueueLabel,
  getChannelWorkingTitle,
} from "./channelBrowserModel"
import "./channel-browser.css"

export type ChannelBrowserValue = {
  state: ChannelBrowserState
  viewerId: string
}

const EMPTY_BROWSER_RUNS: BrowserChannelRun[] = []
const EMPTY_BROWSER_BOTS: Bot[] = []
export const ChannelBrowserRunsContext = createContext({
  runs: EMPTY_BROWSER_RUNS,
  bots: EMPTY_BROWSER_BOTS,
  people: [] as ChannelPerson[],
  threadId: "",
  viewerId: "",
})

export const ChannelBrowserScope = ({ runId, children }: { runId: string | null; children: ReactNode }) => {
  const data = useContext(ChannelBrowserRunsContext)
  const parent = useContext(ChannelBrowserContext)
  const value = getChannelBrowserValue(Object.assign({}, data, { runId })) ?? parent

  return <ChannelBrowserContext.Provider value={value}>{children}</ChannelBrowserContext.Provider>
}

export const ChannelBrowserContext = createContext<ChannelBrowserValue | null>(null)

export const useChannelBrowserView = (
  locale: Locale = "pt-BR",
): (ChannelBrowserView & { state: ChannelBrowserState; selfControl: boolean; controlLabel: string }) | null => {
  const value = useContext(ChannelBrowserContext)
  if (!value) return null

  const getLabel = (id: string | null, name: string) => getChannelPersonLabel(id, name, value.viewerId, locale)
  const state = Object.assign({}, value.state, {
    requesterName: getLabel(value.state.requesterId, value.state.requesterName),
    controllerName: getLabel(value.state.controllerId, value.state.controllerName ?? ""),
    queue: value.state.queue.map((entry) =>
      Object.assign({}, entry, {
        requesterName: getLabel(entry.requesterId, entry.requesterName),
      }),
    ),
  })

  const view = getChannelBrowserView(state, value.viewerId)
  const selfControl = Boolean(state.controllerId) && state.controllerId === value.viewerId
  const controlLabel = selfControl
    ? t("Browser self control", {}, locale)
    : t("{person} is in control", { person: view.controlName }, locale)

  return Object.assign({}, view, { state, selfControl, controlLabel })
}

export const ChannelHeaderChip = ({ locale = "pt-BR" }: { locale?: Locale }) => {
  const channel = useChannelBrowserView(locale)
  if (!channel) return null

  const bot = t("{name} in the browser", { name: channel.state.botName }, locale)
  const request = t("request from {person}", { person: channel.state.requesterName }, locale)
  const controller = channel.state.controllerId ? channel.controlLabel : ""
  const label = [bot, request, controller].filter(Boolean).join(" · ")

  return (
    <span className="channel-chip" role="status" aria-label={label} title={label}>
      <span className="channel-dot" aria-hidden="true" />
      <span className="channel-chip-bot">{bot}</span>
      <span className="channel-chip-separator" aria-hidden="true">
        ·
      </span>
      <span className="channel-chip-muted channel-chip-request">{request}</span>
      {controller && (
        <span className="channel-chip-separator" aria-hidden="true">
          ·
        </span>
      )}
      <span className="channel-chip-muted channel-chip-controller">{controller}</span>
    </span>
  )
}

export const ChannelCardFooter = ({ locale = "pt-BR" }: { locale?: Locale }) => {
  const channel = useChannelBrowserView(locale)
  if (!channel) return null

  const queue = getChannelQueueLabel(channel.state.queue, locale)
  if (!queue) return null

  return (
    <div className="channel-card-footer">
      {queue && (
        <p className="channel-queue" role="status">
          {queue}
        </p>
      )}
    </div>
  )
}

export const ChannelComposerChip = ({
  botName,
  botId,
  onStop,
  onFocusedStopRemoved,
  stopping = false,
  locale = "pt-BR",
}: {
  botName: string
  botId?: string | undefined
  onStop?: (() => void) | undefined
  onFocusedStopRemoved?: (() => void) | undefined
  stopping?: boolean | undefined
  locale?: Locale
}) => {
  const channel = useChannelBrowserView(locale)
  const hold = useBrowserHold(botId)
  const browserControls = useBrowserActivityControls()
  const restoreStopFocus = useCallback(
    (button: HTMLButtonElement | null) => {
      if (!button) return

      return () => {
        if (button.ownerDocument.activeElement !== button) return

        onFocusedStopRemoved?.()
      }
    },
    [onFocusedStopRemoved],
  )
  const canReturnControl = Boolean(hold && (!channel || channel.canControl))
  const base = t("{name} is working · In the browser", { name: botName }, locale)
  const text = canReturnControl
    ? t("You are in control · {name} paused", { name: botName }, locale)
    : getChannelComposerText(channel, base, locale)
  const stopButton =
    onStop && (!channel || channel.canControl) && !channel?.state.controllerId ? (
      <button
        ref={restoreStopFocus}
        type="button"
        className="composer-browser-stop"
        aria-label={stopping ? t("Stopping reply…", {}, locale) : t("Stop {name}", { name: botName }, locale)}
        title={t("Stop {name}", { name: botName }, locale)}
        disabled={stopping}
        onClick={onStop}
      >
        <span aria-hidden="true">{stopping ? "…" : "×"}</span>
      </button>
    ) : null
  const controlButton =
    canReturnControl && hold ? (
      <button type="button" onClick={hold.release}>
        {t("Hand back", {}, locale)}
      </button>
    ) : null

  return (
    <div className="composer-browser-status" data-held={canReturnControl}>
      <span className="composer-browser-status-copy" role="status">
        <span className="composer-browser-status-dot" aria-hidden="true" />
        <span className="composer-browser-status-text">{text}</span>
      </span>
      {controlButton}
      {browserControls.canTakeOver && !canReturnControl && (!channel || channel.canControl) && (
        <button
          type="button"
          className="composer-browser-takeover"
          aria-label={browserControls.label}
          onClick={browserControls.requestTakeover}
        >
          {browserControls.label}
        </button>
      )}
      {!canReturnControl && stopButton}
    </div>
  )
}

const getChannelComposerText = (
  channel: (ChannelBrowserView & { state: ChannelBrowserState; selfControl: boolean; controlLabel: string }) | null,
  base: string,
  locale: Locale,
): string => {
  if (!channel) return base
  if (channel.state.controllerId) return channel.controlLabel
  if (channel.state.status === "needs_you")
    return t(
      "{name} is waiting for {person} in the browser",
      { name: channel.state.botName, person: channel.state.requesterName },
      locale,
    )

  return `${base} · ${t("for {person}", { person: channel.state.requesterName }, locale)}`
}

export const ChannelWorkingMarker = ({ names, locale = "pt-BR" }: { names: readonly string[]; locale?: Locale }) => {
  if (names.length === 0) return null

  return (
    <span className="channel-working" title={getChannelWorkingTitle(names, locale)}>
      <span className="channel-dot" aria-hidden="true" />
      <span className="channel-working-name">{names[0]}</span>
    </span>
  )
}
