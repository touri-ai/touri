import type { Bot } from "@touri/contracts"
import type { ReactNode } from "react"
import { t } from "../i18n"
import { BotAccessSummary } from "./BotAccessSummary"
import { getBotModelName, getBotProviderName } from "./ProviderMark"

export const BotDetails = ({
  bot,
  onSettings,
  onModel,
  onPermissions,
  children,
}: {
  bot: Bot
  onSettings: () => void
  onModel?: (() => void) | undefined
  onPermissions: () => void
  children: ReactNode
}) => {
  const provider = getBotProviderName(bot)
  return (
    <>
      <section className="bot-details-section" aria-labelledby={`bot-profile-${bot.id}`}>
        <h3 id={`bot-profile-${bot.id}`}>{t("About the bot")}</h3>
        <dl>
          <div>
            <dt>{t("Bot job")}</dt>
            <dd>{bot.roleLine || t("No job yet")}</dd>
          </div>
        </dl>
      </section>
      <section className="bot-details-section" aria-labelledby={`bot-access-${bot.id}`}>
        <h3 id={`bot-access-${bot.id}`}>{t("What it can access")}</h3>
        <BotAccessSummary {...bot} />
        <p className="muted-copy">
          {bot.machine === "local"
            ? t("Works on this Mac.")
            : bot.machine === "vm"
              ? t("Works on its own computer.")
              : t("Works on the cloud computer you connected.")}
        </p>
      </section>
      <section className="bot-details-section bot-details-advanced" aria-labelledby={`bot-advanced-${bot.id}`}>
        <h3 id={`bot-advanced-${bot.id}`}>{t("Bot advanced")}</h3>
        <button type="button" className="text-button bot-model-line" onClick={onModel ?? onSettings}>
          {t("Bot model sentence", { provider, model: getBotModelName(bot) })}
        </button>
        <div className="bot-quick-actions">
          <button className="button button-quiet" type="button" onClick={onPermissions}>
            {t("Bot access settings")}
          </button>
          {children}
        </div>
      </section>
    </>
  )
}
