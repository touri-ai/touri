import type { Provider } from "@touri/contracts"
import { useEffect, useId, useState } from "react"
import type { UiApi } from "../api/client"
import { t } from "../i18n"
import { providerName } from "./ProviderMark"

export const ProviderModelField = ({
  id,
  api,
  provider,
  botId,
  value,
  onChange,
  picker = false,
  disabled = false,
}: {
  id: string
  api?: UiApi | undefined
  provider: Provider
  botId?: string | undefined
  value: string
  onChange: (value: string) => void
  picker?: boolean
  disabled?: boolean
}) => {
  const listId = useId()
  const [models, setModels] = useState<string[]>([])
  const [defaultModel, setDefaultModel] = useState<string | null>(null)
  const [status, setStatus] = useState("")
  useEffect(() => {
    let current = true
    setModels([])
    setDefaultModel(null)
    setStatus("")
    if (provider !== "opencode") {
      setStatus(
        t(
          "{provider} does not expose a model list in touri. Use the provider default or enter a model ID supported by your CLI.",
          {
            provider: providerName(provider),
          },
        ),
      )
      return
    }
    if (!api) {
      setStatus(t("Enter a provider/model ID, e.g. openrouter/deepseek/deepseek-v3.2."))
      return
    }
    setStatus(t("Loading OpenCode models…"))
    void api
      .request("GET /providers/opencode/models", botId ? { botId } : {})
      .then((result) => {
        if (!current) return
        setModels(result.models)
        setDefaultModel(result.defaultModel)
        setStatus(
          result.available
            ? result.models.length
              ? !picker && result.defaultModel
                ? t("Default model: {model}. You can also enter another model.", { model: result.defaultModel })
                : t("Select a model or use the OpenCode default.")
              : t("OpenCode returned no models. Use the default or enter a provider/model ID.")
            : t("OpenCode is unavailable. Install the CLI and check Doctor; you can enter a model manually."),
        )
      })
      .catch(() => {
        if (current) setStatus(t("Could not list models. Use the default or enter a provider/model ID manually."))
      })
    return () => {
      current = false
    }
  }, [api, provider, botId, picker])
  const showSelect = picker && models.length > 0
  return (
    <>
      {showSelect ? (
        <select
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          aria-describedby={`${listId}-status`}
        >
          <option value="">
            {t("CLI default")}
            {defaultModel ? ` · ${defaultModel}` : ""}
          </option>
          {value && !models.includes(value) && <option value={value}>{value}</option>}
          {models.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          list={provider === "opencode" ? listId : undefined}
          placeholder={defaultModel ?? t("CLI default")}
          aria-describedby={`${listId}-status`}
          disabled={disabled}
        />
      )}
      {provider === "opencode" && !showSelect && (
        <datalist id={listId}>
          {models.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
      )}
      <small id={`${listId}-status`} role={provider === "opencode" ? "status" : undefined}>
        {status}
      </small>
    </>
  )
}
