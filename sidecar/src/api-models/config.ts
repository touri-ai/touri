import type { Database } from "bun:sqlite"
import {
  type ApiModel,
  apiModelPresets,
  getApiModelProviderId,
  getApiModelReference,
  type Kernel,
} from "@touri/contracts"

const PREFIX = "api-model:"
export const getApiModelAccount = (id: string): string => `api-model/${id}`

export const getApiModels = (kernel: Kernel): ApiModel[] =>
  (
    (kernel.db as Database)
      .query("SELECT value_json FROM settings WHERE key GLOB 'api-model:*' ORDER BY key")
      .all() as Array<{ value_json: string }>
  ).map((row) => JSON.parse(row.value_json) as ApiModel)

export const getApiModel = (kernel: Kernel, reference: string | null | undefined): ApiModel | null => {
  const id = getApiModelProviderId(reference)
  if (!id) return null
  return getApiModels(kernel).find((model) => model.id === id && getApiModelReference(model) === reference) ?? null
}

export const saveApiModel = (kernel: Kernel, model: ApiModel): void => {
  const database = kernel.db as Database
  database
    .query(
      "INSERT INTO settings(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
    )
    .run(`${PREFIX}${model.id}`, JSON.stringify(model), Date.now())
}

export const deleteApiModel = (kernel: Kernel, id: string): void => {
  const database = kernel.db as Database
  database.query("DELETE FROM settings WHERE key=?").run(`${PREFIX}${id}`)
}

export const getApiBaseUrl = (preset: unknown, custom: unknown): string | null => {
  const entry = apiModelPresets.find((candidate) => candidate.id === preset)
  if (!entry) return null
  if (entry.id !== "custom") return entry.baseUrl
  if (typeof custom !== "string" || custom.length > 512 || /[\s{}]/.test(custom)) return null
  try {
    const url = new URL(custom)
    if (url.username || url.password || url.search || url.hash) return null
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
      return null
    return url.href.replace(/\/+$/, "")
  } catch {
    return null
  }
}

export const isApiModelId = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 200 && /^[a-z0-9][a-z0-9._:/@-]*$/i.test(value)

export const isApiKey = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 6 && value.length <= 4096 && !/\s|[{}]/.test(value)
