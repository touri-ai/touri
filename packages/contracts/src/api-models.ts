export const apiModelPresets = [
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com" },
  { id: "zai", name: "Z.ai / GLM", baseUrl: "https://api.z.ai/api/paas/v4" },
  { id: "moonshot", name: "Moonshot / Kimi", baseUrl: "https://api.moonshot.ai/v1" },
  { id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1" },
  { id: "custom", name: "OpenAI-compatible", baseUrl: "" },
] as const

export type ApiModelPreset = (typeof apiModelPresets)[number]["id"]

/** Public metadata only. The key belongs exclusively to the host secret store. */
export type ApiModel = {
  id: string
  preset: ApiModelPreset
  name: string
  baseUrl: string
  modelId: string
  browserDecisions?: boolean
}

export type ApiModelConnection = { preset: ApiModelPreset; baseUrl?: string; apiKey: string }
export type ApiModelInput = ApiModelConnection & { name?: string; modelId: string }
export type ApiModelError =
  | "invalid_key"
  | "no_credit"
  | "model_not_found"
  | "rate_limit"
  | "unavailable"
  | "invalid_response"
  | "invalid_settings"
  | "secret_unavailable"
  | "removed"
export type ApiModelTest = { ok: true } | { ok: false; reason: ApiModelError }

export const apiModelErrors = {
  invalid_key: "The provider rejected this API key. Check the key and its permissions.",
  no_credit: "Your API account has no credit. Add credit with the provider and try again.",
  model_not_found: "This model is unavailable for your API key. Check the model ID or choose another model.",
  rate_limit: "The provider's request limit was reached. Wait a moment and try again.",
  unavailable: "Could not reach the provider. Check your connection and the API URL, then try again.",
  invalid_response: "The API returned an unexpected response. Check that it supports chat completions.",
  invalid_settings: "Check the provider, API URL, key and model ID. URLs must not contain credentials.",
  secret_unavailable: "Could not access the secret store. Unlock it and try again.",
  removed: "This API model was removed. Choose another model in the bot settings.",
} as const satisfies Record<ApiModelError, string>

export const getApiModelReference = (model: Pick<ApiModel, "id" | "modelId">): string =>
  `touri-api-${model.id}/${model.modelId}`

export const getApiModelProviderId = (model: string | null | undefined): string | null => {
  if (!model?.startsWith("touri-api-")) return null
  const slash = model.indexOf("/")
  return slash > 10 ? model.slice(10, slash) : null
}
