import { getApiModelReference, type Provider } from "@touri/contracts"
import { useEffect, useId, useState } from "react"
import type { UiApi } from "../api/client"
import { useApiModels } from "../features/bots/apiModels"
import { t } from "../i18n"
import { CLAUDE_MODELS, getBotModelName, getClaudeModelLabel, providerName } from "./ProviderMark"

const CUSTOM_MODEL = "__custom-model__"

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
  const [typing, setTyping] = useState(false)
  const apiSelection = value.startsWith("touri-api-")
  const [apiLabels, setApiLabels] = useState<Record<string, string>>({})
  const saved = useApiModels(provider === "opencode" ? api : undefined)
  const options = models.concat(saved.models.map(getApiModelReference).filter((model) => !models.includes(model)))
  const getLabel = (reference: string) => {
    const model = saved.models.find((candidate) => getApiModelReference(candidate) === reference)
    return model
      ? `${model.name} · ${model.modelId}`
      : (apiLabels[reference] ?? getClaudeModelLabel(reference) ?? reference)
  }
  useEffect(() => {
    const controller = new AbortController()
    setModels([])
    setDefaultModel(null)
    setStatus("")
    setTyping(false)
    if (provider === "claude") {
      setModels(CLAUDE_MODELS.map((model) => model.id))
      setStatus(t("Choose a Claude Code model. Each option uses the latest version of that model."))
      return
    }
    if (provider !== "opencode") {
      setStatus(
        t(
          "{provider} does not expose a model list in touri. Use the provider default or enter a model name that {provider} accepts.",
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
    if (apiSelection) {
      void api
        .request("GET /api-models", {})
        .then((result) => {
          if (controller.signal.aborted) return
          setModels(result.models.map(getApiModelReference))
          setApiLabels(
            Object.fromEntries(
              result.models.map((model) => [getApiModelReference(model), `${model.name} · ${model.modelId}`]),
            ),
          )
          setStatus(t("Add API models in Settings → API models. Your provider bills API usage directly."))
        })
        .catch(() => {
          if (!controller.signal.aborted) setStatus(t("Could not load API models. Reopen this screen to try again."))
        })
      return () => {
        controller.abort()
      }
    }
    void api
      .request("GET /providers/opencode/models", botId ? { botId } : {})
      .then((result) => {
        if (controller.signal.aborted) return
        setModels(result.models)
        setDefaultModel(result.defaultModel)
        setStatus(
          result.available
            ? result.models.length
              ? !picker && result.defaultModel
                ? t("Default model: {model}. You can also enter another model.", { model: result.defaultModel })
                : t("Select a model or use the OpenCode default.")
              : t("OpenCode returned no models. Use the default or enter a provider/model ID.")
            : t("OpenCode is unavailable. Install OpenCode and check Doctor; you can enter a model manually."),
        )
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setStatus(t("Could not list models. Use the default or enter a provider/model ID manually."))
      })
    return () => {
      controller.abort()
    }
  }, [api, provider, botId, picker, apiSelection])
  const showSelect = apiSelection || ((picker || provider === "claude") && options.length > 0)
  return (
    <>
      {showSelect ? (
        <select
          id={id}
          value={typing ? CUSTOM_MODEL : value}
          onChange={(event) => {
            const next = event.target.value
            setTyping(next === CUSTOM_MODEL)
            // A custom name starts empty, or keeps the last custom name, never the selected alias.
            if (next === CUSTOM_MODEL && getClaudeModelLabel(value)) onChange("")
            if (next !== CUSTOM_MODEL) onChange(next)
          }}
          disabled={disabled}
          aria-describedby={`${listId}-status`}
        >
          <option value="">
            {t("Padrão do provedor")}
            {defaultModel ? ` · ${defaultModel}` : ""}
          </option>
          {value && !options.includes(value) && <option value={value}>{getBotModelName({ model: value })}</option>}
          {options.map((model) => (
            <option key={model} value={model}>
              {getLabel(model)}
            </option>
          ))}
          {provider === "claude" && <option value={CUSTOM_MODEL}>{t("Other model…")}</option>}
        </select>
      ) : (
        <input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          list={provider === "opencode" ? listId : undefined}
          placeholder={defaultModel ?? t("Padrão do provedor")}
          aria-describedby={`${listId}-status`}
          disabled={disabled}
        />
      )}
      {showSelect && typing && (
        <input
          aria-label={t("Model name")}
          placeholder={t("Model name")}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          // biome-ignore lint/a11y/noAutofocus: the user just asked to type a model name
          autoFocus
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
