import { type ApiModel, type ApiModelError, apiModelErrors } from "@touri/contracts"
import { useEffect, useState } from "react"
import type { UiApi } from "../../api/client"
import { t } from "../../i18n"

export const getApiModelErrorText = (reason: ApiModelError): string => t(apiModelErrors[reason])

export const getApiModelRequestError = (error: unknown): string => {
  const code = error && typeof error === "object" && "errorCode" in error ? error.errorCode : null
  const reason = typeof code === "string" ? code.replace(/^api_model_/, "") : ""
  if (Object.hasOwn(apiModelErrors, reason)) return getApiModelErrorText(reason as ApiModelError)
  return t("Could not save or remove the API model. Try again.")
}

export const useApiModels = (api?: UiApi) => {
  const [models, setModels] = useState<ApiModel[]>([])
  const [error, setError] = useState("")
  const [available, setAvailable] = useState(true)
  const [revision, setRevision] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision retries the executable check after installation.
  useEffect(() => {
    const controller = new AbortController()
    if (!api) return
    void api.request("GET /api-models", {}).then(
      (result) => {
        if (!controller.signal.aborted) {
          setModels(Array.isArray(result.models) ? result.models : [])
          setError("")
          setAvailable(result.executorAvailable !== false)
        }
      },
      () => {
        if (!controller.signal.aborted) setError(t("Could not load API models. Reopen this screen to try again."))
      },
    )
    return () => controller.abort()
  }, [api, revision])
  return { models, error, available, refresh: () => setRevision((current) => current + 1) }
}
