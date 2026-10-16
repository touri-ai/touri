import type { Bot, ProviderProfile } from "@touri/contracts"
import { useEffect, useState } from "react"
import type { UiApi } from "../api/client"
import { SettingsRow, SettingsSwitch } from "./SettingsLayout"

type ProfileValues = { providerProfile: string | null; claudeAiConnectors: boolean }

/** Per-bot provider account for local bots. Profiles are created with `touri profile login <name>`. */
export const ProviderProfileFields = ({
  api,
  provider,
  values,
  onChange,
}: {
  api: UiApi
  provider: Bot["provider"]
  values: ProfileValues
  onChange: (patch: Partial<ProfileValues>) => void
}) => {
  const [profiles, setProfiles] = useState<Array<ProviderProfile> | null>(null)
  useEffect(() => {
    let current = true
    void api
      .request("GET /provider-profiles", {})
      .then((result) => {
        if (current) setProfiles(result.profiles)
      })
      .catch(() => {
        if (current) setProfiles([])
      })
    return () => {
      current = false
    }
  }, [api])
  if (provider === "opencode") return null
  const options = (profiles ?? []).filter((profile) => profile.provider === provider)
  const missing = values.providerProfile !== null && !options.some((profile) => profile.name === values.providerProfile)
  return (
    <>
      <SettingsRow
        title="Conta do provedor"
        description="Bots locais podem usar uma conta própria. Crie a conta com touri profile login <nome>."
        htmlFor="settings-provider-profile"
      >
        <select
          id="settings-provider-profile"
          value={values.providerProfile ?? ""}
          disabled={profiles === null}
          onChange={(event) => onChange({ providerProfile: event.target.value || null })}
        >
          <option value="">Login padrão deste computador</option>
          {options.map((profile) => (
            <option key={profile.name} value={profile.name}>
              {profile.name}
              {profile.loggedIn ? (profile.account ? ` (${profile.account})` : "") : " (sem login)"}
            </option>
          ))}
          {missing && <option value={values.providerProfile ?? ""}>{values.providerProfile} (não encontrada)</option>}
        </select>
      </SettingsRow>
      {provider === "claude" && (
        <label className="toggle-row" htmlFor="settings-claude-ai-connectors">
          <span>
            <strong>Conectores do claude.ai</strong>
            <small>
              Carrega os conectores da conta, como Gmail e Google Calendar. Eles não passam pelo gateway MCP do touri:
              as chamadas seguem o modo de aprovação do bot.
            </small>
          </span>
          <SettingsSwitch
            id="settings-claude-ai-connectors"
            checked={values.claudeAiConnectors}
            onChange={(event) => onChange({ claudeAiConnectors: event.target.checked })}
          />
        </label>
      )}
    </>
  )
}
