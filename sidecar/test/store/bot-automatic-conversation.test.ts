import { expect, test } from "bun:test"
import type { Bot } from "@touri/contracts"
import { init } from "../../src/store"
import { testKernel } from "../kernel/test-kernel"

test("automatic conversation mode defaults to main and can be changed through the bot API", async () => {
  const fixture = testKernel()
  try {
    await init(fixture.kernel)
    const created = await fixture.request("POST /bots", { name: "Main bot", provider: "codex" })
    const mainBot = (created.json as { bot: Bot }).bot
    expect(created.status).toBe(201)
    expect(mainBot.automaticConversationMode).toBe("main")

    const taskCreated = await fixture.request("POST /bots", {
      name: "Task bot",
      provider: "codex",
      automaticConversationMode: "task",
    })
    const taskBot = (taskCreated.json as { bot: Bot }).bot
    expect(taskBot.automaticConversationMode).toBe("task")

    const changed = await fixture.request("PATCH /bots/:id", { automaticConversationMode: "main" }, { id: taskBot.id })
    expect(changed.json).toMatchObject({ bot: { automaticConversationMode: "main" } })
    expect(
      (await fixture.request("PATCH /bots/:id", { automaticConversationMode: "unknown" }, { id: taskBot.id })).status,
    ).toBe(400)
  } finally {
    fixture.close()
  }
})
