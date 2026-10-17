import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import type { Bot, Kernel, Thread } from "@touri/contracts"
import { composeDeveloperInstructions } from "../../src/runtime/instructions"

for (const provider of ["codex", "claude", "opencode"] as const) {
  test(`${provider}: live reasoning follows the user's language even with a large English SOUL`, async () => {
    const db = new Database(":memory:")
    db.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT, updated_at INTEGER);
      CREATE TABLE bots (name TEXT, archived_at INTEGER, sort_order INTEGER);
    `)
    const kernel = {
      db,
      paths: { appData: "/fixtures/data" },
      services: { use: () => null },
      newId: () => "reference",
    } as unknown as Kernel
    const bot = {
      id: "language-bot",
      name: "Idioma",
      provider,
      machine: "local",
      homeDir: "/fixtures/bot",
      access: "read-only",
      approvals: "on-request",
      instructions: "Introduce yourself in English.\n".repeat(1000),
    } as Bot
    const thread = { id: "language-thread", title: "Idioma", groupId: null } as Thread
    try {
      const instructions = await composeDeveloperInstructions({ kernel, bot, thread, cwd: bot.homeDir })
      expect(instructions.length).toBeLessThanOrEqual(24_000)
      expect(instructions.includes("Respond in pt-BR by default")).toBe(true)
      expect(
        instructions.includes(
          "Think and summarize your reasoning in the user's language (UI locale; pt-BR by default)",
        ),
      ).toBe(true)
      expect(instructions.includes("including live reasoning summaries")).toBe(true)
    } finally {
      db.close()
    }
  })
}
