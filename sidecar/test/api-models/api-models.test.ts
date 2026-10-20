import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type ApiModel,
  apiModelErrors,
  apiModelPresets,
  type Bot,
  getApiModelReference,
  type Kernel,
  type ProviderEvent,
} from "@touri/contracts"
import { getApiError } from "../../src/api-models/client"
import {
  getApiBaseUrl,
  getApiModelAccount,
  getApiModels,
  getBrowserDecisionModel,
  saveApiModel,
} from "../../src/api-models/config"
import { createApiModels } from "../../src/api-models/index"
import { getApiModelEnv, getApiOpenCodeConfig, getApiRequiredHosts, getApiRunError } from "../../src/api-models/runtime"
import { createHeadlessHost } from "../../src/cli/host/headlessHost"
import { createSecretStore } from "../../src/cli/host/secretStore"
import { createKernel } from "../../src/kernel"
import { openCodeEvents } from "../../src/runtime/opencode/events"
import { init as initStore } from "../../src/store"

const cleanups = new Set<() => void>()
afterEach(() => {
  cleanups.forEach((close) => {
    close()
  })
  cleanups.clear()
})

const key = "fixture-api-key-only-for-tests"
const makeApiFixture = async (
  respond: (request: Request) => Response = () => Response.json({ choices: [{ message: { content: "OK" } }] }),
) => {
  const root = mkdtempSync(join(tmpdir(), "touri-api-models-"))
  const runtime = createKernel({ appData: join(root, "data") })
  const secrets = createSecretStore({ dir: join(root, "vault"), env: { TOURI_SECRETS_KEY: "fixture-encryption-key" } })
  const kernel = runtime.kernel
  kernel.callHost = createHeadlessHost({ secrets })({ publish: kernel.publish, log: kernel.log })
  const logs = new Set<string>()
  const events = new Set<string>()
  const decisionModels: Array<ApiModel | null> = []
  kernel.services.provide("browser.updateDecisionModel", (model) => {
    decisionModels.push(model)
  })
  kernel.log = (entry) => {
    logs.add(JSON.stringify(entry))
  }
  kernel.subscribe((event) => {
    events.add(JSON.stringify(event))
  })
  await initStore(kernel)
  const requests = new Set<Request>()
  const fetchImpl = (async (request: string | URL | Request, options?: RequestInit) => {
    const outgoing = new Request(request, options)
    requests.add(outgoing)
    return respond(outgoing)
  }) as typeof fetch
  kernel.registerRoutes(createApiModels(kernel, fetchImpl))
  cleanups.add(() => {
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  const api = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1${path}`, {
      method,
      headers: {
        Authorization: "Bearer dev-ui-token",
        Origin: "tauri://localhost",
        "Content-Type": "application/json",
      },
      body: body === undefined ? null : JSON.stringify(body),
    })
  const add = async () => {
    const response = await api("/api-models", {
      preset: "deepseek",
      apiKey: key,
      modelId: "test-model",
      name: "Modelo de teste",
    })
    expect(response.status).toBe(201)
    return ((await response.json()) as { model: ApiModel }).model
  }
  return { api, add, root, kernel, secrets, logs, events, requests, decisionModels, port: runtime.handshake.port }
}

test("saved keys require explicit browser consent and disabling stops decision use", async () => {
  const f = await makeApiFixture()
  const response = await f.api("/api-models", {
    preset: "openrouter",
    apiKey: key,
    modelId: "typesafe/jev-1.13",
    name: "Decisão do navegador",
  })
  expect(response.status).toBe(201)
  const model = ((await response.json()) as { model: ApiModel }).model
  expect(f.decisionModels).toEqual([])

  const unauthorized = await fetch(`http://127.0.0.1:${f.port}/api/v1/api-models/${model.id}/browser-decisions`, {
    method: "PATCH",
  })
  expect(unauthorized.status).toBe(401)
  expect(getBrowserDecisionModel(f.kernel)).toBeNull()
  Array.from({ length: 40 }, (_, index) => `a-${index}`).forEach((id) => {
    saveApiModel(f.kernel, { ...model, id })
  })

  const enabled = await f.api(`/api-models/${model.id}/browser-decisions`, { enabled: true }, "PATCH")

  expect(enabled.status).toBe(200)
  expect(f.decisionModels).toEqual([{ ...model, browserDecisions: true }])
  expect(getBrowserDecisionModel(f.kernel)?.id).toBe(model.id)
  expect((await f.api(`/api-models/${model.id}/browser-decisions`, { enabled: false }, "PATCH")).status).toBe(200)
  expect(f.decisionModels.at(-1)).toBeNull()
  expect(getBrowserDecisionModel(f.kernel)).toBeNull()

  expect((await f.api(`/api-models/${model.id}`, {}, "DELETE")).status).toBe(200)
  expect(f.decisionModels.at(-1)).toBeNull()
})

test("API model keys only enter the encrypted server secret store; metadata and events never contain them", async () => {
  const f = await makeApiFixture()
  const model = await f.add()
  expect(f.secrets.get(getApiModelAccount(model.id))).toBe(key)
  expect(readFileSync(join(f.root, "vault/secrets.enc"), "utf8")).not.toContain(key)
  expect(JSON.stringify(getApiModels(f.kernel))).not.toContain(key)
  expect(JSON.stringify((f.kernel.db as Database).query("SELECT * FROM settings").all())).not.toContain(key)
  expect(await (await f.api("/api-models")).text()).not.toContain(key)
  expect(Array.from(f.logs).join("\n")).not.toContain(key)
  expect(Array.from(f.events).join("\n")).not.toContain(key)
  expect(f.kernel.redact(key)).not.toContain(key)
  expect(JSON.stringify(getApiOpenCodeConfig(model))).not.toContain(key)
  expect(getApiOpenCodeConfig(model)).toMatchObject({
    model: getApiModelReference(model),
    small_model: getApiModelReference(model),
    enabled_providers: [`touri-api-${model.id}`],
    provider: {
      [`touri-api-${model.id}`]: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: model.baseUrl, apiKey: "{env:TOURI_MODEL_API_KEY}" },
      },
    },
  })
  expect(await getApiModelEnv(f.kernel, getApiModelReference(model), new AbortController().signal)).toEqual({
    TOURI_MODEL_API_KEY: key,
  })
  expect(getApiRequiredHosts(f.kernel, getApiModelReference(model))).toEqual(["api.deepseek.com"])
})

test("testing performs a small authenticated completion without saving the draft or returning upstream text", async () => {
  const f = await makeApiFixture(() => Response.json({ choices: [{ message: { content: key } }] }))
  const response = await f.api("/api-models/test", { preset: "groq", apiKey: key, modelId: "test-model" })
  expect(await response.json()).toEqual({ ok: true })
  const outgoing = Array.from(f.requests)[0]
  expect(outgoing?.url).toBe("https://api.groq.com/openai/v1/chat/completions")
  expect(outgoing?.headers.get("Authorization")).toBe(`Bearer ${key}`)
  expect(await outgoing?.json()).toMatchObject({ model: "test-model", max_tokens: 32, stream: false })
  expect(outgoing?.redirect).toBe("error")
  expect(getApiModels(f.kernel)).toEqual([])
  expect(Array.from(f.logs).join("\n")).not.toContain(key)
})

test("model discovery filters malformed IDs and any echoed key and does not persist drafts", async () => {
  const f = await makeApiFixture(() =>
    Response.json({
      data: [{ id: "model-b" }, { id: key }, { id: "model-a" }, { id: "model-a" }, { id: "{env:PRIVATE}" }],
    }),
  )
  expect(await (await f.api("/api-models/models", { preset: "openrouter", apiKey: key })).json()).toEqual({
    models: ["model-b", "model-a"],
  })
  expect(getApiModels(f.kernel)).toEqual([])
})

test("failed vault writes create no model; failed deletion preserves metadata and can be retried", async () => {
  const f = await makeApiFixture()
  const model = await f.add()
  const callHost = f.kernel.callHost
  f.kernel.callHost = (async () => ({
    success: false,
    errorCode: "HOST_UNAVAILABLE",
    error: key,
  })) as Kernel["callHost"]
  expect((await f.api("/api-models", { preset: "deepseek", apiKey: key, modelId: "another-model" })).status).toBe(503)
  expect(getApiModels(f.kernel)).toHaveLength(1)
  expect((await f.api(`/api-models/${model.id}`, {}, "DELETE")).status).toBe(503)
  expect(getApiModels(f.kernel)).toHaveLength(1)
  f.kernel.callHost = callHost
  expect((await f.api(`/api-models/${model.id}`, {}, "DELETE")).status).toBe(200)
  expect(getApiModels(f.kernel)).toEqual([])
  expect(f.secrets.get(getApiModelAccount(model.id))).toBeNull()
  await expect(getApiModelEnv(f.kernel, getApiModelReference(model), new AbortController().signal)).rejects.toThrow(
    apiModelErrors.removed,
  )
})

test("saved models can be chosen for bots and deleted models never fall back to another account", async () => {
  const f = await makeApiFixture()
  const model = await f.add()
  const reference = getApiModelReference(model)
  const response = await f.api("/bots", { name: "Assistente", provider: "opencode", model: reference })
  expect(response.status).toBe(201)
  const bot = ((await response.json()) as { bot: Bot }).bot
  expect(bot.model).toBe(reference)
  expect((await f.api("/bots", { name: "Assistente", provider: "codex", model: reference })).status).toBe(400)
  await f.api(`/api-models/${model.id}`, {}, "DELETE")
  expect((await f.api(`/bots/${bot.id}`, { model: reference }, "PATCH")).status).toBe(400)
  expect(await (await f.api(`/api-models/${model.id}/test`, {})).json()).toEqual({ ok: false, reason: "removed" })
})

test.each([
  [401, "bad key", "invalid_key"],
  [403, "forbidden", "invalid_key"],
  [402, "payment required", "no_credit"],
  [429, "insufficient_quota", "no_credit"],
  [400, "insufficient balance", "no_credit"],
  [400, "1113", "no_credit"],
  [404, "not found", "model_not_found"],
  [400, "model_not_found", "model_not_found"],
  [400, "model does not exist", "model_not_found"],
  [400, "1211", "model_not_found"],
  [429, "too many requests", "rate_limit"],
  [500, "internal error", "unavailable"],
] as const)("API HTTP %i maps %s to %s without exposing response bodies", async (status, detail, reason) => {
  const f = await makeApiFixture(() => Response.json({ error: { message: `${detail} ${key}` } }, { status }))
  expect(await (await f.api("/api-models/test", { preset: "deepseek", apiKey: key, modelId: "model" })).json()).toEqual(
    { ok: false, reason },
  )
  expect(getApiError(status, detail)).toBe(reason)
  expect(getApiRunError(`HTTP ${status}: ${detail}`).message).toBe(apiModelErrors[reason])
})

test("provider presets and custom URLs cannot embed credentials or config substitutions", async () => {
  expect(apiModelPresets.map((preset) => preset.id)).toEqual([
    "openrouter",
    "deepseek",
    "zai",
    "moonshot",
    "groq",
    "custom",
  ])
  expect(getApiBaseUrl("deepseek", "https://untrusted.example/v1")).toBe("https://api.deepseek.com")
  expect(getApiBaseUrl("custom", "https://api.example.com/v1/")).toBe("https://api.example.com/v1")
  for (const url of [
    "https://user:secret@api.example.com/v1",
    "https://api.example.com/v1?key=secret",
    "https://api.example.com/{env:SECRET}",
    "http://api.example.com/v1",
    "file:///secrets",
  ])
    expect(getApiBaseUrl("custom", url)).toBeNull()
  const f = await makeApiFixture()
  for (const patch of [{ modelId: key }, { name: key }, { modelId: "{env:SECRET}" }, { preset: "unknown" }]) {
    expect(
      (await f.api("/api-models", Object.assign({ preset: "deepseek", apiKey: key, modelId: "model" }, patch))).status,
    ).toBe(400)
  }
  expect(getApiModels(f.kernel)).toEqual([])
})

test.each([
  [401, "invalid_key"],
  [402, "no_credit"],
  [404, "model_not_found"],
  [429, "rate_limit"],
] as const)("runtime API HTTP %i emits a safe %s notice", (status, reason) => {
  const events = new Set<ProviderEvent>()
  const translate = openCodeEvents(
    "api-session",
    (event) => {
      events.add(event)
    },
    undefined,
    getApiRunError,
  )

  const result = translate({
    type: "session.error",
    properties: {
      sessionID: "api-session",
      error: { name: "APIError", data: { statusCode: status, message: `upstream echoed ${key}` } },
    },
  })

  expect(result.error).toBe(apiModelErrors[reason])
  expect(JSON.stringify(Array.from(events))).not.toContain(key)
  expect(Array.from(events)).toContainEqual(
    expect.objectContaining({ type: "turn_completed", status: "failed", errorMessage: apiModelErrors[reason] }),
  )
})
