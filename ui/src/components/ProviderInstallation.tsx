import type { Bot, HostKind } from "@touri/contracts"
import { useState } from "react"
import { CloudLink } from "../features/cloud/CloudLink"
import { getHostLabel, t } from "../i18n"
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
  host: HostKind
  busy: boolean
  onRecheck: () => void
}) => {
  const [error, setError] = useState(false)
  return (
    <div className="provider-login-flow" role="status">
      <p>
        {t("onboarding.missing", {
          provider: providerName(provider),
          host: getHostLabel(host),
        })}
      </p>
      <CloudLink href={installationGuides[provider]} className="" onError={() => setError(true)}>
        {t("onboarding.install")}
      </CloudLink>
      {error && <p role="alert">{t("onboarding.installLinkError")}</p>}
      <button type="button" className="button button-quiet" disabled={busy} onClick={onRecheck}>
        {t("onboarding.recheck")}
      </button>
    </div>
  )
}
