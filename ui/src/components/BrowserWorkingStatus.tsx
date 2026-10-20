import { type Locale, t } from "../i18n"

export const BrowserWorkingStatus = ({
  name,
  onStop,
  locale = "pt-BR",
}: {
  name: string
  onStop?: (() => void) | undefined
  locale?: Locale
}) => (
  <div className="composer-browser-status" role="status">
    <span>{t("{name} is working · In the browser", { name }, locale)}</span>
    <button type="button" aria-label={t("Stop browser task", {}, locale)} disabled={!onStop} onClick={onStop}>
      ×
    </button>
  </div>
)
