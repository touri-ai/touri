import { expect, it, vi } from "vitest"
import type { UiApi } from "../src/api/client"
import { getIsGuideBotReady } from "../src/features/onboarding/guide"
import { getGuideBotFixture } from "./fixtures/onboarding-guide"

const getApi = (response: unknown): UiApi => ({
  request: vi.fn(async () => {
    if (response instanceof Error) throw response
    return response
  }) as UiApi["request"],
  isMock: false,
  subscribe: () => () => undefined,
})
it.each([
  { provider: "claude", state: "ready", executable: "missing", expected: false },
  { provider: "claude", state: "idle", executable: "available", expected: false },
  { provider: "codex", state: "ready", executable: "available", expected: false },
  { provider: "claude", state: "ready", executable: "available", expected: true },
])("checks both the selected account and installed program: $state/$executable/$provider", async (status) => {
  const api = getApi(status)

  expect(await getIsGuideBotReady(api, getGuideBotFixture())).toBe(status.expected)
  expect(api.request).toHaveBeenCalledOnce()
  expect(api.request).toHaveBeenCalledWith(
    "GET /bots/:id/provider-login/flow",
    { provider: "claude" },
    { id: "bot-touri" },
  )
})
it.each([false, true])("requires an installed executor for a saved API model: %s", async (executorAvailable) => {
  const api = getApi({ executorAvailable, models: [{ id: "sample", modelId: "example" }] })
  const bot = { ...getGuideBotFixture(), provider: "opencode" as const, model: "touri-api-sample/example" }

  expect(await getIsGuideBotReady(api, bot)).toBe(executorAvailable)
  expect(api.request).toHaveBeenCalledWith("GET /api-models", {})
})
it("rejects a model removed after account setup and a failed readiness request", async () => {
  const bot = { ...getGuideBotFixture(), provider: "opencode" as const, model: "touri-api-removed/example" }

  expect(await getIsGuideBotReady(getApi({ executorAvailable: true, models: [] }), bot)).toBe(false)
  expect(await getIsGuideBotReady(getApi(new Error("Connection interrupted")), getGuideBotFixture())).toBe(false)
})

it("checks the saved login for an isolated machine without requiring the program on the host", async () => {
  const api = getApi({ provider: "claude", ready: true })
  const bot = { ...getGuideBotFixture(), machine: "vm" as const }

  expect(await getIsGuideBotReady(api, bot)).toBe(true)
  expect(api.request).toHaveBeenCalledWith("GET /bots/:id/provider-login", {}, { id: bot.id })
})
it("keeps a saved API model usable in an isolated machine with its bundled executor", async () => {
  const api = getApi({ executorAvailable: false, models: [{ id: "sample", modelId: "example" }] })
  const bot = {
    ...getGuideBotFixture(),
    machine: "vm" as const,
    provider: "opencode" as const,
    model: "touri-api-sample/example",
  }

  expect(await getIsGuideBotReady(api, bot)).toBe(true)
})
