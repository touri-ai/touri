import { afterEach, expect, test } from "bun:test"
import { init } from "../../src/store"
import { testKernel } from "../kernel/test-kernel"

const fixtures = new Set<ReturnType<typeof testKernel>>()
afterEach(() => {
  fixtures.forEach((fixture) => {
    fixture.close()
  })
  fixtures.clear()
})

test("fast conversation defaults on, persists opt-out and rejects non-booleans", async () => {
  const fixture = testKernel()
  fixtures.add(fixture)
  await init(fixture.kernel)
  const created = await fixture.request("POST /bots", { name: "Conversation fixture", provider: "codex" })
  const bot = created.json as { bot: { id: string; fastConversation: boolean } }

  expect(bot.bot.fastConversation).toBe(true)
  const changed = await fixture.request("PATCH /bots/:id", { fastConversation: false }, { id: bot.bot.id })
  const read = fixture.kernel.services.use("store.api")?.getBot({ botId: bot.bot.id })
  const invalid = await fixture.request("PATCH /bots/:id", { fastConversation: "false" }, { id: bot.bot.id })

  expect(changed.json).toMatchObject({ bot: { fastConversation: false } })
  expect(read).toMatchObject({ fastConversation: false })
  expect(invalid.status).toBe(400)
})
