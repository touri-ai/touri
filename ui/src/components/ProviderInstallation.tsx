import type { Bot } from "@touri/contracts"
import { t } from "../i18n"
import { providerName } from "./ProviderMark"

const installationGuides = {
  codex: "https://developers.openai.com/codex/cli/",
  claude: "https://code.claude.com/docs/en/setup",
  opencode: "https://opencode.ai/docs/",
}

export const ProviderInstallation = ({
  provider,
  host,
  busy,
  onRecheck,
}: {
  provider: Bot["provider"]
  host: "mac" | "server"
  busy: boolean
  onRecheck: () => void
}) => (
  <div className="provider-login-flow" role="status">
    <p>
      {t("onboarding.missing", {
        provider: providerName(provider),
        host: host === "mac" ? "Mac" : t("onboarding.server"),
      })}
    </p>
    <a href={installationGuides[provider]} target="_blank" rel="noreferrer">
      {t("onboarding.install")}
    </a>
    <button type="button" className="button button-quiet" disabled={busy} onClick={onRecheck}>
      {t("onboarding.recheck")}
    </button>
  </div>
)
