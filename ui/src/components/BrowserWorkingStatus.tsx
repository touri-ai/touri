import { useBrowserHold } from "../features/desktop/browserHold"
import { type Locale, t } from "../i18n"

export const BrowserWorkingStatus = ({
  name,
  botId,
  onStop,
  locale = "pt-BR",
}: {
  name: string
  botId?: string | undefined
  onStop?: (() => void) | undefined
  locale?: Locale
}) => {
  const hold = useBrowserHold(botId)
  if (hold)
    return (
      <div className="composer-browser-status" data-held="true" role="status">
        <span className="composer-browser-status-dot" aria-hidden="true" />
        <span>{t("You are in control · {name} paused", { name }, locale)}</span>
        <button type="button" onClick={hold.release}>
          {t("Hand back", {}, locale)}
        </button>
      </div>
    )

  return (
    <div className="composer-browser-status" role="status">
      <span className="composer-browser-status-dot" aria-hidden="true" />
      <span>{t("{name} is working · In the browser", { name }, locale)}</span>
      <button type="button" aria-label={t("Stop {name}", { name }, locale)} disabled={!onStop} onClick={onStop}>
        {t("Stop", {}, locale)}
      </button>
    </div>
  )
}
