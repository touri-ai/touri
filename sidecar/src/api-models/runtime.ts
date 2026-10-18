import {
  type ApiModel,
  apiModelErrors,
  getApiModelProviderId,
  getApiModelReference,
  type Kernel,
  type RunErrorClass,
} from "@touri/contracts"
import { getApiError } from "./client"
import { getApiModel } from "./config"
import { getApiModelKey } from "./index"

export const getApiModelEnv = async (
  kernel: Kernel,
  reference: string | null,
  signal: AbortSignal,
): Promise<Record<string, string>> => {
  if (!reference?.startsWith("touri-api-")) return {}
  const model = getApiModel(kernel, reference)
  if (!model) throw new Error(apiModelErrors.removed)
  const key = await getApiModelKey(kernel, model.id, signal)
  if (!key) throw new Error(apiModelErrors.invalid_key)
  signal.throwIfAborted()
  return { TOURI_MODEL_API_KEY: key }
}

/** The private config contains an environment reference, never the key or a credential file. */
export const getApiOpenCodeConfig = (model: ApiModel | null) => {
  if (!model) return {}
  const providerId = `touri-api-${model.id}`
  return {
    model: getApiModelReference(model),
    small_model: getApiModelReference(model),
    enabled_providers: [providerId],
    provider: {
      [providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: model.name,
        options: { baseURL: model.baseUrl, apiKey: "{env:TOURI_MODEL_API_KEY}" },
        models: { [model.modelId]: { name: model.modelId, tool_call: true, limit: { context: 32768, output: 4096 } } },
      },
    },
  }
}

export const getApiRunError = (detail: string): { message: string; errorClass: RunErrorClass } => {
  const known = Object.entries(apiModelErrors).find(([, message]) => message === detail)
  const status = detail.match(/(?:status(?:Code)?["\s:]*|HTTP\s+)(\d{3})/i)?.[1]
  const reason =
    (known?.[0] as keyof typeof apiModelErrors | undefined) ?? getApiError(status ? Number(status) : 0, detail)
  return {
    message: apiModelErrors[reason],
    errorClass: getApiRunClass(reason),
  }
}

export const getApiRequiredHosts = (kernel: Kernel, reference: string | null): string[] => {
  if (!getApiModelProviderId(reference)) return []
  const model = getApiModel(kernel, reference)
  return model ? [new URL(model.baseUrl).hostname] : []
}

const getApiRunClass = (reason: keyof typeof apiModelErrors): RunErrorClass => {
  if (["invalid_key", "secret_unavailable", "removed"].includes(reason)) return "cli_auth"
  if (["rate_limit", "no_credit"].includes(reason)) return "rate_limit"
  return "cli_protocol"
}
