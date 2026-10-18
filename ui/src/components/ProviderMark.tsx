import { type Bot, getApiModelProviderId, type Provider } from "@touri/contracts"
import { t } from "../i18n"

export const getBotProviderName = (bot: Pick<Bot, "provider" | "model">): string => {
  if (bot.provider === "opencode" && getApiModelProviderId(bot.model)) return t("API models")
  return providerName(bot.provider)
}

export const getBotModelName = (bot: Pick<Bot, "model">): string => {
  if (!bot.model) return t("Padrão do provedor")
  if (getApiModelProviderId(bot.model)) return bot.model.slice(bot.model.indexOf("/") + 1)
  return bot.model
}

export const providerName = (provider: Provider): string =>
  ({ codex: "Codex", claude: "Claude Code", opencode: "OpenCode" })[provider]

/** Original mark: two open brackets enclosing a small diamond. */
export const ProviderMark = ({ provider }: { provider: Provider }) => (
  <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4em" }}>
    {provider === "opencode" && (
      <svg
        viewBox="0 0 24 24"
        width="18"
        height="18"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        aria-hidden="true"
      >
        <path d="M8 4H4v16h4M16 4h4v16h-4M12 8l4 4-4 4-4-4z" strokeLinejoin="round" />
      </svg>
    )}
    {providerName(provider)}
  </span>
)
