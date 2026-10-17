import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import type { Bot, Kernel, Thread } from "@touri/contracts"
import { composeDeveloperInstructions } from "../../src/runtime/instructions"

for (const provider of ["codex", "claude", "opencode"] as const) {
  test(`${provider}: missing data guidance offers concrete connection options with or without a project`, async () => {
    const db = new Database(":memory:")
    db.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT, updated_at INTEGER);
      CREATE TABLE bots (name TEXT, archived_at INTEGER, sort_order INTEGER);
    `)
    const kernel = {
      db,
      paths: { appData: "/tmp/touri-data-test" },
      services: { use: () => null },
      newId: () => "reference",
    } as unknown as Kernel
    const bot = {
      id: "data-bot",
      name: "Dados",
      provider,
      machine: "local",
      homeDir: "/tmp/touri-data-test/bot",
      access: "read-only",
      approvals: "on-request",
      instructions: "",
      folders: [],
      mcpServers: [],
    } as unknown as Bot
    const thread = { id: "data-thread", title: "Dados", groupId: null } as Thread
    try {
      for (const projectId of [null, "linked-project"]) {
        const instructions = await composeDeveloperInstructions({
          kernel,
          bot: { ...bot, projectId },
          thread,
          cwd: bot.homeDir,
        })
        for (const hint of [
          "attach a file/CSV",
          "grant access to a folder (local or VM bots only)",
          "existing catalog",
          "Ask which option the user prefers",
          "<!-- touri:connect-data --> on its own final line",
          "never for an unrelated error, a denied approval or a successful answer",
        ])
          expect(instructions).toContain(hint)
        expect(instructions.includes("Do not call project_info until a project is linked")).toBe(projectId === null)
      }
    } finally {
      db.close()
    }
  })
}
