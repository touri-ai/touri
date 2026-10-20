import { type ApiModel, type ApiModelInput, type ApiModelPreset, apiModelPresets } from "@touri/contracts"
import { useEffect, useId, useState } from "react"
import type { UiApi } from "../api/client"
import { getApiModelErrorText, getApiModelRequestError } from "../features/bots/apiModels"
import { t } from "../i18n"
import { useHost } from "../useHost"
import { ProviderInstallation } from "./ProviderInstallation"
import { SettingsGroup } from "./SettingsLayout"

export const ApiModelsSettings = ({ api }: { api: UiApi | undefined }) => {
  const id = useId()
  const [models, setModels] = useState<ApiModel[]>([])
  const [preset, setPreset] = useState<ApiModelPreset>("openrouter")
  const [name, setName] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [modelId, setModelId] = useState("")
  const [catalog, setCatalog] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState("")
  const [error, setError] = useState("")
  const [available, setAvailable] = useState(true)
  const [revision, setRevision] = useState(0)
  const host = useHost(api)
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision retries the executable check after installation.
  useEffect(() => {
    const controller = new AbortController()
    if (!api) return
    void api.request("GET /api-models", {}).then(
      (result) => {
        if (!controller.signal.aborted) {
          setModels(Array.isArray(result.models) ? result.models : [])
          setAvailable(result.executorAvailable !== false)
        }
      },
      () => {
        if (!controller.signal.aborted) setError(t("Could not load API models. Reopen this screen to try again."))
      },
    )
    return () => controller.abort()
  }, [api, revision])

  const getInput = (): ApiModelInput => ({
    preset,
    baseUrl,
    name: name.trim() || apiModelPresets.find((entry) => entry.id === preset)?.name || "API",
    apiKey: apiKey.trim(),
    modelId: modelId.trim(),
  })
  const run = async (action: () => Promise<void>) => {
    if (busy || !api) return
    setBusy(true)
    setError("")
    setNotice("")
    try {
      await action()
    } catch (error) {
      setError(getApiModelRequestError(error))
    } finally {
      setBusy(false)
    }
  }
  const resetFeedback = () => {
    setError("")
    setNotice("")
  }

  return (
    <div className="api-model-settings" aria-busy={busy}>
      <p className="field-help">
        {t(
          "Requests go directly to the provider you choose, which bills API usage. Keys stay in this computer's secret store. On a touri server, they stay in the server's encrypted secret store.",
        )}
      </p>
      {!available && (
        <ProviderInstallation
          provider="opencode"
          host={host}
          busy={busy}
          onRecheck={() => setRevision((current) => current + 1)}
        />
      )}
      <SettingsGroup title={t("Saved API models")}>
        {models.length === 0 && (
          <p className="api-model-empty">{t("No API models yet. Add your first model below.")}</p>
        )}
        <ul className="api-model-list">
          {models.map((model) => (
            <li key={model.id}>
              <div>
                <strong>{model.name}</strong>
                <p>{model.modelId}</p>
                <small>{t("Key saved in secret store")} · ••••••••</small>
              </div>
              <div className="api-model-actions">
                <button
                  className="button button-quiet"
                  type="button"
                  disabled={busy || !api}
                  aria-label={t("Test connection to {name}", { name: model.name })}
                  onClick={() =>
                    void run(async () => {
                      if (!api) return
                      const result = await api.request("POST /api-models/:id/test", {}, { id: model.id })
                      if (result.ok) setNotice(t("Connection worked. The model is ready to use."))
                      else setError(getApiModelErrorText(result.reason))
                    })
                  }
                >
                  {t("Test connection")}
                </button>
                <button
                  className="button button-quiet"
                  type="button"
                  disabled={busy || !api}
                  aria-label={t("Remove {name}", { name: model.name })}
                  onClick={() =>
                    void run(async () => {
                      if (!api) return
                      await api.request("DELETE /api-models/:id", {}, { id: model.id })
                      setModels((current) => current.filter((entry) => entry.id !== model.id))
                      setNotice(t("API model and saved key removed."))
                    })
                  }
                >
                  {t("Remove API model")}
                </button>
              </div>
            </li>
          ))}
        </ul>
        {models.length > 0 && (
          <p className="api-model-empty">
            {t("Removing a model also deletes its key. Bots using it will need another model.")}
          </p>
        )}
      </SettingsGroup>
      <SettingsGroup title={t("Add API model")}>
        <form
          className="api-model-form"
          onSubmit={(event) => {
            event.preventDefault()
            void run(async () => {
              if (!api) return
              const result = await api.request("POST /api-models", getInput())
              setModels((current) => current.concat(result.model))
              setApiKey("")
              setModelId("")
              setCatalog([])
              setName("")
              setNotice(t("API model saved. Choose it when creating a bot or in the bot's model settings."))
            })
          }}
        >
          <fieldset disabled={busy || !api}>
            <label htmlFor={`${id}-preset`}>{t("API provider")}</label>
            <select
              id={`${id}-preset`}
              value={preset}
              onChange={(event) => {
                setPreset(event.target.value as ApiModelPreset)
                setApiKey("")
                setModelId("")
                setCatalog([])
                resetFeedback()
              }}
            >
              {apiModelPresets.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.id === "custom" ? t("Custom compatible API") : entry.name}
                </option>
              ))}
            </select>
            {preset === "custom" && (
              <>
                <label htmlFor={`${id}-url`}>{t("API base URL")}</label>
                <input
                  id={`${id}-url`}
                  type="url"
                  required
                  value={baseUrl}
                  placeholder="https://api.example.com/v1"
                  onChange={(event) => {
                    setBaseUrl(event.target.value)
                    setCatalog([])
                    resetFeedback()
                  }}
                />
                <small>
                  {t("Use the API base URL, including /v1 if required. HTTPS is required except for a local server.")}
                </small>
              </>
            )}
            <label htmlFor={`${id}-key`}>{t("API key")}</label>
            <input
              id={`${id}-key`}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              required
              maxLength={4096}
              value={apiKey}
              onChange={(event) => {
                setApiKey(event.target.value)
                setCatalog([])
                resetFeedback()
              }}
            />
            <button
              className="button button-quiet"
              type="button"
              disabled={!apiKey.trim()}
              onClick={() =>
                void run(async () => {
                  if (!api) return
                  const result = await api.request("POST /api-models/models", getInput())
                  setCatalog(result.models)
                  if (result.reason && result.reason !== "model_not_found" && result.reason !== "invalid_response")
                    setError(getApiModelErrorText(result.reason))
                  else
                    setNotice(
                      t(
                        result.models.length
                          ? "Choose a model from the list or enter its ID."
                          : "This provider did not list models. Enter the model ID from your provider account.",
                      ),
                    )
                })
              }
            >
              {t("Load models")}
            </button>
            <label htmlFor={`${id}-model`}>{t("Model ID")}</label>
            <input
              id={`${id}-model`}
              required
              maxLength={200}
              value={modelId}
              list={`${id}-catalog`}
              placeholder="model-id"
              onChange={(event) => {
                setModelId(event.target.value)
                resetFeedback()
              }}
            />
            <datalist id={`${id}-catalog`}>
              {catalog.map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
            <label htmlFor={`${id}-name`}>{t("Name (optional)")}</label>
            <input
              id={`${id}-name`}
              maxLength={80}
              value={name}
              placeholder={apiModelPresets.find((entry) => entry.id === preset)?.name}
              onChange={(event) => setName(event.target.value)}
            />
            <small>
              {t(
                "Testing sends a short message to the provider and may use a small amount of credit. Choose a model that supports tools for bot tasks.",
              )}
            </small>
            <div className="api-model-actions">
              <button
                className="button button-quiet"
                type="button"
                disabled={!apiKey.trim() || !modelId.trim()}
                onClick={() =>
                  void run(async () => {
                    if (!api) return
                    const result = await api.request("POST /api-models/test", getInput())
                    if (result.ok) setNotice(t("Connection worked. The model is ready to use."))
                    else setError(getApiModelErrorText(result.reason))
                  })
                }
              >
                {t("Test connection")}
              </button>
              <button className="button button-brand" type="submit" disabled={!apiKey.trim() || !modelId.trim()}>
                {t("Save API model")}
              </button>
            </div>
          </fieldset>
        </form>
      </SettingsGroup>
      {busy && <p role="status">{t("Connecting to the provider…")}</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
