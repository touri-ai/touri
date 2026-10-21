import { createContext, useContext } from "react"
import { useBrowserActivityControls } from "../../components/BrowserActivityControls"
import { type Locale, t } from "../../i18n"
import { useBrowserHold } from "../desktop/browserHold"
import {
  type ChannelBrowserState,
  type ChannelBrowserView,
  getChannelBrowserView,
  getChannelQueueLabel,
  getChannelWorkingTitle,
} from "./channelBrowserModel"
import "./channel-browser.css"

export type ChannelBrowserValue = {
  state: ChannelBrowserState
  viewerId: string
}

export const ChannelBrowserContext = createContext<ChannelBrowserValue | null>(null)

export const useChannelBrowserView = (): (ChannelBrowserView & { state: ChannelBrowserState }) | null => {
  const value = useContext(ChannelBrowserContext)
  if (!value) return null

  return { ...getChannelBrowserView(value.state, value.viewerId), state: value.state }
}

export const ChannelHeaderChip = ({ locale = "pt-BR" }: { locale?: Locale }) => {
  const channel = useChannelBrowserView()
  if (!channel) return null

  const bot = t("{name} in the browser", { name: channel.state.botName }, locale)
  const request = t("request from {person}", { person: channel.state.requesterName }, locale)

  return (
    <span className="channel-chip" role="status" aria-label={`${bot} · ${request}`}>
      <span className="channel-dot" aria-hidden="true" />
      {bot}
      <span aria-hidden="true">·</span>
      <span className="channel-chip-muted">{request}</span>
    </span>
  )
}

export const ChannelVisibilityLabel = ({ locale = "pt-BR" }: { locale?: Locale }) => {
  if (!useContext(ChannelBrowserContext)) return null

  return <span className="channel-visibility">{t("Everyone in the channel sees", {}, locale)}</span>
}

export const ChannelControlNote = ({ locale = "pt-BR" }: { locale?: Locale }) => {
  const channel = useChannelBrowserView()
  if (!channel || channel.canControl) return null

  return (
    <span className="channel-visibility" role="status">
      {t("{person} is in control", { person: channel.controlName }, locale)}
    </span>
  )
}

export const ChannelHiddenPreview = ({ locale = "pt-BR" }: { locale?: Locale }) => {
  const channel = useChannelBrowserView()
  if (!channel) return null

  return (
    <p className="channel-hidden-preview" role="status">
      {t("Preview hidden for the channel while {person} types", { person: channel.controlName }, locale)}
    </p>
  )
}

export const ChannelCardFooter = ({ locale = "pt-BR" }: { locale?: Locale }) => {
  const channel = useChannelBrowserView()
  if (!channel) return null

  const queue = getChannelQueueLabel(channel.state.queue, locale)

  return (
    <div className="channel-card-footer">
      <p className="channel-banner">
        <svg
          aria-hidden="true"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        >
          <circle cx="8" cy="8" r="6.5" />
          <path d="M8 4.5v4M8 11h.01" />
        </svg>
        <span>
          <strong>{t("If the site asks for a login,", {}, locale)}</strong>{" "}
          {t(
            "{bot} pauses and calls {person}, who asked. The preview stays hidden for the channel while they type.",
            { bot: channel.state.botName, person: channel.state.requesterName },
            locale,
          )}
        </span>
      </p>
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
  stopping = false,
  locale = "pt-BR",
}: {
  botName: string
  botId?: string | undefined
  onStop?: (() => void) | undefined
  stopping?: boolean | undefined
  locale?: Locale
}) => {
  const channel = useChannelBrowserView()
  const hold = useBrowserHold(botId)
  const browserControls = useBrowserActivityControls()
  const canReturnControl = Boolean(hold && (!channel || channel.canControl))
  const base = t("{name} is working · In the browser", { name: botName }, locale)
  const text = canReturnControl
    ? t("You are in control · {name} paused", { name: botName }, locale)
    : getChannelComposerText(channel, base, locale)
  const stopButton =
    onStop && (!channel || channel.canControl) && !channel?.state.controllerId ? (
      <button
        type="button"
        className="composer-browser-stop"
        aria-label={stopping ? t("Stopping reply…", {}, locale) : t("Stop {name}", { name: botName }, locale)}
        title={t("Stop {name}", { name: botName }, locale)}
        disabled={stopping}
        onClick={onStop}
      >
        {t(stopping ? "Stopping reply…" : "Stop browser work", {}, locale)}
        <span aria-hidden="true">×</span>
      </button>
    ) : null
  const controlButton =
    canReturnControl && hold && !browserControls.canTakeOver ? (
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
      {browserControls.canTakeOver && (!channel || channel.canControl) && (
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
  channel: (ChannelBrowserView & { state: ChannelBrowserState }) | null,
  base: string,
  locale: Locale,
): string => {
  if (!channel) return base
  if (!channel.canControl) return t("{person} is in control", { person: channel.controlName }, locale)

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
