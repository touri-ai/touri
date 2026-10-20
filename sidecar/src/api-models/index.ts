import {
  type ApiModel,
  type ApiModelConnection,
  type ApiModelError,
  apiModelErrors,
  apiModelPresets,
  type Kernel,
  type RouteModule,
  type RouteResponse,
} from "@touri/contracts"
import { withDeadline } from "../kernel/policy"
import { buildChildEnv } from "../kernel/shell-env"
import { openCodeBinary } from "../runtime/opencode/config"
import { getApiConnection, getDiscoveredModels, isApiCompletion, requestApi } from "./client"
import {
  deleteApiModel,
  getApiModelAccount,
  getApiModelById,
  getApiModels,
  isApiModelId,
  saveApiModel,
  saveBrowserDecisionModel,
} from "./config"

export const name = "api-models"
type Context = { kernel: Kernel; fetchImpl: typeof fetch }

export const createApiModels = (kernel: Kernel, fetchImpl = fetch): RouteModule => {
  const context = { kernel, fetchImpl }

  return {
    name,
    routes: [
      { method: "GET", path: "/api-models", handler: () => listModels(kernel) },
      { method: "POST", path: "/api-models/models", handler: ({ body }) => discoverModels(context, body) },
      { method: "POST", path: "/api-models/test", handler: ({ body }) => testModel(context, body) },
      { method: "POST", path: "/api-models", handler: ({ body }) => addModel(context, body) },
      {
        method: "POST",
        path: "/api-models/:id/test",
        handler: ({ params }) => testSavedModel(context, params.id ?? ""),
      },
      {
        method: "PATCH",
        path: "/api-models/:id/browser-decisions",
        handler: async ({ params, body }) => setBrowserDecisions(kernel, params.id ?? "", body),
      },
      { method: "DELETE", path: "/api-models/:id", handler: ({ params }) => removeModel(kernel, params.id ?? "") },
    ],
  }
}

export const init = async (kernel: Kernel): Promise<void> => {
  kernel.registerRoutes(createApiModels(kernel))
}

export const getApiModelKey = async (kernel: Kernel, id: string, signal?: AbortSignal): Promise<string | null> => {
  try {
    const result = await withDeadline({
      operation: () => kernel.callHost("keychain.get", { account: getApiModelAccount(id) }),
      timeoutMs: 5000,
      signal: signal ?? AbortSignal.timeout(5000),
    })
    if (!result.success) throw new Error(apiModelErrors.secret_unavailable)
    const key = result.value.value
    if (key) kernel.addRedactionValue(key)

    return key
  } catch {
    signal?.throwIfAborted()
    throw new Error(apiModelErrors.secret_unavailable)
  }
}

const json = (status: number, value: unknown): RouteResponse => ({ status, json: value })
const failure = (reason: ApiModelError, status = 400): RouteResponse =>
  json(status, { errorCode: `api_model_${reason}`, error: apiModelErrors[reason] })
const testFailure = (reason: ApiModelError): RouteResponse => json(200, { ok: false, reason })

const listModels = async (kernel: Kernel): Promise<RouteResponse> => {
  const env = buildChildEnv({ base: await kernel.shellEnv() })

  return json(200, { models: getApiModels(kernel), executorAvailable: openCodeBinary(env).success })
}

const prepareConnection = (kernel: Kernel, input: unknown): ApiModelConnection | null => {
  const connection = getApiConnection(input)
  if (connection) kernel.addRedactionValue(connection.apiKey)

  return connection
}

const discoverModels = async ({ kernel, fetchImpl }: Context, body: unknown): Promise<RouteResponse> => {
  const connection = prepareConnection(kernel, body)
  if (!connection) return json(200, { models: [], reason: "invalid_settings" })

  const result = await requestApi({ connection, fetchImpl })
  if ("reason" in result) return json(200, { models: [], reason: result.reason })
  const models = getDiscoveredModels(result.value)
  if (!models) return json(200, { models: [], reason: "invalid_response" })

  return json(200, { models: models.filter((model) => !model.includes(connection.apiKey)) })
}

const testModel = async ({ kernel, fetchImpl }: Context, body: unknown): Promise<RouteResponse> => {
  const connection = prepareConnection(kernel, body)
  const modelId = body && typeof body === "object" && "modelId" in body ? body.modelId : null
  if (!connection || !isApiModelId(modelId)) return testFailure("invalid_settings")

  const result = await requestApi({ connection, modelId, fetchImpl })
  if ("reason" in result) return testFailure(result.reason)
  if (!isApiCompletion(result.value)) return testFailure("invalid_response")

  return json(200, { ok: true })
}

const getDraft = (body: unknown): { connection: ApiModelConnection; name: string; modelId: string } | null => {
  const connection = getApiConnection(body)
  if (!connection || !body || typeof body !== "object" || !("modelId" in body) || !isApiModelId(body.modelId))
    return null
  const defaultName = apiModelPresets.find((preset) => preset.id === connection.preset)?.name
  const name = "name" in body ? body.name : defaultName
  if (typeof name !== "string" || !name.trim() || name.length > 80 || /[\p{Cc}{}]/u.test(name)) return null
  if (name.includes(connection.apiKey) || body.modelId.includes(connection.apiKey)) return null

  return { connection, name: name.trim(), modelId: body.modelId }
}

const storeKey = async (kernel: Kernel, id: string, key: string): Promise<boolean> => {
  try {
    const result = await withDeadline({
      operation: () => kernel.callHost("keychain.set", { account: getApiModelAccount(id), value: key }),
      timeoutMs: 5000,
    })
    return result.success
  } catch {
    return false
  }
}

const removeKey = async (kernel: Kernel, id: string): Promise<boolean> => {
  try {
    const result = await withDeadline({
      operation: () => kernel.callHost("keychain.delete", { account: getApiModelAccount(id) }),
      timeoutMs: 5000,
    })
    return result.success
  } catch {
    return false
  }
}

const addModel = async ({ kernel }: Context, body: unknown): Promise<RouteResponse> => {
  const draft = getDraft(body)
  if (!draft) return failure("invalid_settings")
  const model: ApiModel = {
    id: kernel.newId(),
    preset: draft.connection.preset,
    name: draft.name,
    baseUrl: draft.connection.baseUrl ?? "",
    modelId: draft.modelId,
  }
  kernel.addRedactionValue(draft.connection.apiKey)

  if (!(await storeKey(kernel, model.id, draft.connection.apiKey))) return failure("secret_unavailable", 503)
  try {
    saveApiModel(kernel, model)
  } catch {
    await removeKey(kernel, model.id)
    return failure("secret_unavailable", 503)
  }

  return json(201, { model })
}

const testSavedModel = async (context: Context, id: string): Promise<RouteResponse> => {
  const model = getApiModels(context.kernel).find((candidate) => candidate.id === id)
  if (!model) return testFailure("removed")

  try {
    const apiKey = await getApiModelKey(context.kernel, id)
    if (!apiKey) return testFailure("invalid_key")
    return testModel(context, { preset: model.preset, baseUrl: model.baseUrl, modelId: model.modelId, apiKey })
  } catch {
    return testFailure("secret_unavailable")
  }
}

const removeModel = async (kernel: Kernel, id: string): Promise<RouteResponse> => {
  const model = getApiModelById(kernel, id)
  if (!model) return json(200, {})
  if (!(await removeKey(kernel, id))) return failure("secret_unavailable", 503)

  deleteApiModel(kernel, id)
  if (model.browserDecisions === true) kernel.services.use("browser.updateDecisionModel")?.(null)

  return json(200, {})
}

const setBrowserDecisions = (kernel: Kernel, id: string, body: unknown): RouteResponse => {
  if (!body || typeof body !== "object" || !("enabled" in body) || typeof body.enabled !== "boolean")
    return failure("invalid_settings")

  const selected = getApiModelById(kernel, id)
  if (!selected) return failure("removed", 404)
  if (selected.preset !== "openrouter") return failure("invalid_settings")

  const model = { ...selected, browserDecisions: body.enabled }
  saveBrowserDecisionModel(kernel, model)
  kernel.services.use("browser.updateDecisionModel")?.(body.enabled ? model : null)

  return json(200, { model })
}
