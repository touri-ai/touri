import type { ApiModelConnection, ApiModelError } from "@touri/contracts"
import { getApiBaseUrl, isApiKey, isApiModelId } from "./config"

export const getApiError = (status: number, detail = ""): ApiModelError => {
  if (
    status === 402 ||
    /insufficient[_ -]?(quota|balance|credit|funds)|no[_ -]?credit|credit.*(exhaust|insufficient)|balance.*(low|insufficient)|\b1113\b/i.test(
      detail,
    )
  )
    return "no_credit"
  if (
    status === 401 ||
    status === 403 ||
    /invalid[_ -]?(api[_ -]?)?key|authentication|ProviderAuthError|\b100[0-4]\b/i.test(detail)
  )
    return "invalid_key"
  if (status === 429 || /rate[_ -]?limit|too many requests|\b130[25]\b/i.test(detail)) return "rate_limit"
  if (
    status === 404 ||
    /model[_ -]?(not[_ -]?found|not[_ -]?exist)|(?:unknown|invalid|unavailable) model|no endpoints found/i.test(detail)
  )
    return "model_not_found"
  return "unavailable"
}

export const getApiConnection = (input: unknown): ApiModelConnection | null => {
  if (!input || typeof input !== "object") return null
  const row = input as Record<string, unknown>
  const baseUrl = getApiBaseUrl(row.preset, row.baseUrl)
  if (!baseUrl || !isApiKey(row.apiKey) || baseUrl.includes(row.apiKey)) return null
  return { preset: row.preset as ApiModelConnection["preset"], baseUrl, apiKey: row.apiKey }
}

/** No redirects: credentials must only reach the endpoint the owner chose. Never surface response bodies. */
export const requestApi = async ({
  connection,
  modelId,
  fetchImpl = fetch,
}: {
  connection: ApiModelConnection
  modelId?: string
  fetchImpl?: typeof fetch
}): Promise<{ value: unknown } | { reason: ApiModelError }> => {
  try {
    const response = await fetchImpl(`${connection.baseUrl}/${modelId === undefined ? "models" : "chat/completions"}`, {
      method: modelId === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${connection.apiKey}`, "Content-Type": "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      body:
        modelId === undefined
          ? null
          : JSON.stringify(
              Object.assign(
                { model: modelId, messages: [{ role: "user", content: "Reply OK." }], max_tokens: 32, stream: false },
                ["zai", "moonshot"].includes(connection.preset) ? { thinking: { type: "disabled" } } : {},
              ),
            ),
    })
    const text = await response.text()
    if (text.length > 2_000_000) return { reason: "invalid_response" }
    if (!response.ok) return { reason: getApiError(response.status, text.slice(0, 65_536)) }
    try {
      const value: unknown = JSON.parse(text)
      if (value && typeof value === "object" && "error" in value) return { reason: getApiError(400, text) }
      return { value }
    } catch {
      return { reason: "invalid_response" }
    }
  } catch {
    return { reason: "unavailable" }
  }
}

export const getDiscoveredModels = (value: unknown): string[] | null => {
  if (!value || typeof value !== "object" || !("data" in value) || !Array.isArray(value.data)) return null
  return Array.from(
    new Set(
      value.data
        .flatMap((row: unknown) =>
          row && typeof row === "object" && "id" in row && isApiModelId(row.id) ? [row.id] : [],
        )
        .slice(0, 2000),
    ),
  )
}

export const isApiCompletion = (value: unknown): boolean => {
  if (!value || typeof value !== "object" || !("choices" in value) || !Array.isArray(value.choices)) return false
  const message = value.choices[0]?.message
  return typeof message?.content === "string" || typeof message?.reasoning_content === "string"
}
