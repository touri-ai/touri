import { type Bot, getApiModelProviderId, type Provider } from "@touri/contracts"
import { t } from "../i18n"

export const getBotProviderName = (bot: Pick<Bot, "provider" | "model">): string => {
  if (bot.provider === "opencode" && getApiModelProviderId(bot.model)) return t("API models")
  return providerName(bot.provider)
}

/** Claude Code model aliases; each one always resolves to the latest model of that family. */
export const CLAUDE_MODELS = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
] as const

/** Curated models for providers without a discoverable catalog. Keep this list easy to update. */
export const PROVIDER_MODELS: Record<Provider, ReadonlyArray<{ id: string; label: string }>> = {
  codex: [
    { id: "gpt-6.1-sol", label: "gpt-6.1-sol" },
    { id: "gpt-6-luna", label: "gpt-6-luna" },
  ],
  claude: CLAUDE_MODELS,
  opencode: [],
}

export const getClaudeModelLabel = (id: string): string | undefined =>
  CLAUDE_MODELS.find((model) => model.id === id)?.label

export const getBotModelName = (bot: Pick<Bot, "model"> & Partial<Pick<Bot, "provider">>): string => {
  if (!bot.model) return t("Padrão do provedor")
  if (getApiModelProviderId(bot.model)) return bot.model.slice(bot.model.indexOf("/") + 1)
  if (bot.provider === "claude") return getClaudeModelLabel(bot.model) ?? bot.model
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
