import { t } from "../i18n"
import "./conversation-loading.css"

export const ConversationLoading = () => (
  <div className="conversation-loading" role="status" aria-label={t("Loading conversations")}>
    {[0, 1, 2].map((row) => (
      <div key={row} className="conversation-loading-row" aria-hidden="true">
        <i />
        <span />
      </div>
    ))}
  </div>
)
