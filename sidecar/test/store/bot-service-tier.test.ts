import { afterEach, expect, test } from "bun:test"
import type { ApiRoutes, Bot, CreateBotInput } from "@touri/contracts"
import { init } from "../../src/store"
import { testKernel } from "../kernel/test-kernel"

const fixtures = new Set<ReturnType<typeof testKernel>>()
afterEach(async () => {
  await Promise.all(Array.from(fixtures).map((fixture) => fixture.close()))
  fixtures.clear()
})

const makeFixture = async () => {
  const fixture = testKernel()
  fixtures.add(fixture)
  await init(fixture.kernel)

  return fixture
}

test("contract accepts optional fast tier for creation and nullable PATCH", async () => {
  const fixture = await makeFixture()
  const input: CreateBotInput = { name: "Tier fixture", provider: "codex", serviceTier: "fast" }
  const patch: ApiRoutes["PATCH /bots/:id"]["req"] = { serviceTier: null }

  const created = await fixture.request("POST /bots", input)
  const { bot } = created.json as { bot: Bot }
  const changed = await fixture.request("PATCH /bots/:id", patch, { id: bot.id })

  expect(created.status).toBe(201)
  expect(bot.serviceTier).toBe("fast")
  expect(changed.json).toMatchObject({ bot: { serviceTier: null } })
})

test("tier defaults off, persists fast across unrelated edits and clears when changing provider", async () => {
  const fixture = await makeFixture()
  const created = await fixture.request("POST /bots", { name: "Tier fixture", provider: "codex" })
  const { bot } = created.json as { bot: Bot }

  expect(bot.serviceTier).toBeNull()
  const enabled = await fixture.request("PATCH /bots/:id", { serviceTier: "fast" }, { id: bot.id })
  const renamed = await fixture.request("PATCH /bots/:id", { title: "Example" }, { id: bot.id })
  const stored = fixture.kernel.services.use("store.api")?.getBot({ botId: bot.id })
  const switched = await fixture.request("PATCH /bots/:id", { provider: "claude" }, { id: bot.id })

  expect(enabled.json).toMatchObject({ bot: { serviceTier: "fast" } })
  expect(renamed.json).toMatchObject({ bot: { serviceTier: "fast" } })
  expect(stored?.serviceTier).toBe("fast")
  expect(switched.json).toMatchObject({ bot: { serviceTier: null } })
})

test.each(["priority", "default", "", true, 1, {}, []].map((serviceTier) => ({ serviceTier })))(
  "rejects invalid tier %j on create and PATCH",
  async ({ serviceTier }) => {
    const fixture = await makeFixture()
    const created = await fixture.request("POST /bots", { name: "Tier fixture", provider: "codex" })
    const { bot } = created.json as { bot: Bot }

    const invalidCreate = await fixture.request("POST /bots", { name: "Invalid", provider: "codex", serviceTier })
    const invalidPatch = await fixture.request("PATCH /bots/:id", { serviceTier }, { id: bot.id })

    expect(invalidCreate.status).toBe(400)
    expect(invalidPatch.status).toBe(400)
    expect(fixture.kernel.services.use("store.api")?.getBot({ botId: bot.id })?.serviceTier).toBeNull()
  },
)

test.each(["claude", "opencode"])("rejects fast for %s on creation, validation and PATCH", async (provider) => {
  const fixture = await makeFixture()
  const created = await fixture.request("POST /bots", { name: "Tier fixture", provider })
  const { bot } = created.json as { bot: Bot }

  const invalidCreate = await fixture.request("POST /bots", { name: "Invalid", provider, serviceTier: "fast" })
  const validated = fixture.kernel.services.use("bots.validateCreation")?.({
    name: "Invalid",
    provider,
    serviceTier: "fast",
  })
  const invalidPatch = await fixture.request("PATCH /bots/:id", { serviceTier: "fast" }, { id: bot.id })

  expect(invalidCreate.status).toBe(400)
  expect(validated?.success).toBe(false)
  expect(invalidPatch.status).toBe(400)
  expect(bot.serviceTier).toBeNull()
})
