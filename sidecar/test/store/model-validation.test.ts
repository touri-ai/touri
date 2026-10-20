import { afterEach, beforeEach, expect, test } from "bun:test"
import { type ApiModel, type Bot, getApiModelReference } from "@touri/contracts"
import { deleteApiModel, saveApiModel } from "../../src/api-models/config"
import { init } from "../../src/store"
import { testKernel } from "../kernel/test-kernel"

let fixture: ReturnType<typeof testKernel>
beforeEach(async () => {
  fixture = testKernel()
  await init(fixture.kernel)
})
afterEach(() => fixture.close())

const invalidModels = [
  "--help",
  " -config ",
  "demo\u0000model",
  "demo\tmodel",
  "demo\n",
  "demo\u007fmodel",
  "demo\u0085model",
  "demo\u200bmodel",
  "demo\u202emodel",
  "demo\u2028model",
  "demo\u2029model",
  "demo\ud800model",
  "demo\u034fmodel",
  "demo\ufe0fmodel",
  "m".repeat(257),
  42,
  false,
  {},
  ["demo-model"],
]

test.each(invalidModels.map((model) => [model]))(
  "rejects unsafe model values on create and update: %j",
  async (model) => {
    const { bot } = (await fixture.request("POST /bots", { name: "Demo", provider: "codex", model: "demo-model" }))
      .json as { bot: Bot }

    const created = await fixture.request("POST /bots", { name: "Invalid", provider: "codex", model })
    const updated = await fixture.request("PATCH /bots/:id", { model }, { id: bot.id })
    const stored = await fixture.request("GET /bots")

    expect(created.status).toBe(400)
    expect(updated.status).toBe(400)
    expect(stored.json).toMatchObject({ bots: [{ id: bot.id, model: "demo-model" }] })
    expect(fixture.spawnTree).not.toHaveBeenCalled()
  },
)

test.each([null, "", "   ", " demo-model ", "sonnet", "provider/model:latest", "m".repeat(256)])(
  "normalizes valid models on create and update and preserves omitted fields: %j",
  async (model) => {
    const expected = model?.trim() || null

    const created = await fixture.request("POST /bots", { name: "Demo", provider: "codex", model })
    const { bot } = created.json as { bot: Bot }
    const changed = await fixture.request("PATCH /bots/:id", { model: "other-model" }, { id: bot.id })
    const updated = await fixture.request("PATCH /bots/:id", { model }, { id: bot.id })
    const renamed = await fixture.request("PATCH /bots/:id", { name: "Renamed" }, { id: bot.id })

    expect(created.status).toBe(201)
    expect(bot.model).toBe(expected)
    expect(changed.status).toBe(200)
    expect(updated.status).toBe(200)
    expect(updated.json).toMatchObject({ bot: { model: expected } })
    expect(renamed.json).toMatchObject({ bot: { model: expected } })
  },
)

test("validates team creation before writing a bot", async () => {
  const validate = fixture.kernel.services.use("bots.validateCreation")
  if (!validate) throw new Error("Missing creation validator")

  const result = validate({ name: "Demo", provider: "codex", model: "--help" })
  const stored = await fixture.request("GET /bots")

  expect(result).toMatchObject({ success: false })
  expect(stored.json).toMatchObject({ bots: [] })
})

test("preserves long saved API references and rejects missing or mismatched references", async () => {
  const model: ApiModel = {
    id: "12345678-1234-1234-1234-123456789012",
    preset: "custom",
    name: "Demo API",
    modelId: "m".repeat(200),
    baseUrl: "https://example.com/v1",
  }
  saveApiModel(fixture.kernel, model)
  const reference = getApiModelReference(model)

  const created = await fixture.request("POST /bots", { name: "Demo", provider: "opencode", model: reference })
  const { bot } = created.json as { bot: Bot }
  const updated = await fixture.request("PATCH /bots/:id", { model: ` ${reference} ` }, { id: bot.id })
  const wrongProvider = await fixture.request("PATCH /bots/:id", { provider: "codex" }, { id: bot.id })
  const tampered = await fixture.request("PATCH /bots/:id", { model: `${reference}x` }, { id: bot.id })
  deleteApiModel(fixture.kernel, model.id)
  const removed = await fixture.request("PATCH /bots/:id", { model: reference }, { id: bot.id })
  const cleared = await fixture.request("PATCH /bots/:id", { model: null }, { id: bot.id })

  expect(reference.length).toBe(247)
  expect(created.status).toBe(201)
  expect(bot.model).toBe(reference)
  expect(updated.json).toMatchObject({ bot: { model: reference } })
  expect(wrongProvider.status).toBe(400)
  expect(tampered.status).toBe(400)
  expect(removed.status).toBe(400)
  expect(cleared.json).toMatchObject({ bot: { model: null } })
})
