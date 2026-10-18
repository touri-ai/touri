import { getApiModelReference } from "@touri/contracts"
import type { UiApi } from "../api/client"
import { useApiModels } from "../features/bots/apiModels"
import { t } from "../i18n"
import { useHost } from "../useHost"
import { ProviderInstallation } from "./ProviderInstallation"

export const ApiModelPicker = ({
  api,
  id,
  value,
  onChange,
  disabled = false,
}: {
  api?: UiApi | undefined
  id: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}) => {
  const { models, error, available, refresh } = useApiModels(api)
  const host = useHost(api)
  if (!models.length && !value) return error ? <small>{error}</small> : null

  return (
    <div className="api-model-picker">
      <label htmlFor={id}>{t("API models")}</label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        aria-describedby={`${id}-help`}
      >
        <option value="">{t("Use a connected account")}</option>
        {value && !models.some((model) => getApiModelReference(model) === value) && (
          <option value={value}>{value}</option>
        )}
        {models.map((model) => (
          <option key={model.id} value={getApiModelReference(model)}>
            {model.name} · {model.modelId}
          </option>
        ))}
      </select>
      <small id={`${id}-help`}>
        {error || t("Add API models in Settings → API models. Your provider bills API usage directly.")}
      </small>
      {value && !available && <ProviderInstallation provider="opencode" host={host} busy={false} onRecheck={refresh} />}
    </div>
  )
}
