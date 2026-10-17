import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Bot, ProviderAdapter, StartTurnArgs } from "@touri/contracts"
import { getJobTemplates } from "../../../ui/src/features/jobs/catalog"
import { createRuntimeEngine } from "../../src/runtime/engine"
import { composeDeveloperInstructions } from "../../src/runtime/instructions"
import { init as initStore } from "../../src/store"
import { testKernel } from "../kernel/test-kernel"

for (const provider of ["codex", "claude", "opencode"] as const) {
  for (const jobId of ["notes-in-order", "focused-week", "packing-checklist", "study-blocks"]) {
    test(`${provider}: QA Café keeps ${jobId} from creation through its first provider turn`, async () => {
      const f = testKernel()
      let engine: ReturnType<typeof createRuntimeEngine> | undefined
      try {
        await initStore(f.kernel)
        const job = getJobTemplates().find((job) => job.id === jobId)
        if (!job) throw new Error("Missing catalog job")
        const created = await f.request("POST /bots", {
          name: "QA Café",
          provider,
          roleLine: job.roleLine,
          instructions: job.instructions,
        })
        expect(created.status).toBe(201)
        const { bot } = created.json as { bot: Bot }
        const store = f.kernel.services.use("store.api")
        const thread = store?.getThread({ threadId: bot.mainThreadId ?? "" })
        if (!store || !thread) throw new Error("Missing bot conversation")
        expect(store.getBot({ botId: bot.id })).toMatchObject({
          name: "QA Café",
          roleLine: job.roleLine,
          instructions: job.instructions,
        })
        expect(readFileSync(join(bot.homeDir, "SOUL.md"), "utf8")).toBe(job.instructions)
        expect(store.activePath({ threadId: thread.id })).toEqual([])
        const initial = await composeDeveloperInstructions({ kernel: f.kernel, bot, thread, cwd: bot.homeDir })
        expect(initial).toContain(`Your current job is ${JSON.stringify(job.roleLine)}`)
        expect(initial).toContain(`Bot SOUL:\n${job.instructions}`)
        expect(initial).toContain("including the first greeting")
        expect(initial).toContain("never infer a different job from it")
        expect(initial).not.toContain("including descriptions of your role")
        const legacy = await composeDeveloperInstructions({
          kernel: f.kernel,
          bot: { ...bot, instructions: "Na primeira conversa, apresente brevemente como pode ajudar neste trabalho." },
          thread,
          cwd: bot.homeDir,
        })
        expect(legacy).toContain(`Your current job is ${JSON.stringify(job.roleLine)}`)

        const turns: StartTurnArgs[] = []
        const adapter: ProviderAdapter = {
          provider,
          detect: async () => ({ success: true, path: "/tmp/fake-provider", version: "1", loggedIn: true }),
          startTurn: async (args) => {
            turns.push(args)
            return { success: true, externalSessionId: "catalog-session", rolloutPath: null, status: "succeeded" }
          },
          answerApproval: async () => ({ success: true }),
          shutdown: async () => {},
        }
        engine = createRuntimeEngine({ kernel: f.kernel, providerAdapters: { [provider]: adapter } })
        const message = store.insertMessage({
          message: {
            id: f.kernel.newId(),
            threadId: thread.id,
            parentId: null,
            role: "user",
            kind: "text",
            status: "complete",
            runId: null,
            text: "Oi, quem é você?",
            parts: [{ type: "text", text: "Oi, quem é você?" }],
            sender: null,
            source: "local",
          },
        })
        if (!message.success) throw new Error(message.error)
        const queued = engine.enqueue({ threadId: thread.id, requestMessageId: message.message.id, trigger: "user" })
        expect(queued.success).toBe(true)
        const deadline = Date.now() + 2000
        while (turns.length === 0) {
          if (Date.now() > deadline) throw new Error("First provider turn did not start")
          await Bun.sleep(5)
        }
        expect(turns).toHaveLength(1)
        expect(turns[0]?.session).toBeNull()
        expect(turns[0]?.bot.name).toBe("QA Café")
        expect(turns[0]?.developerInstructions).toContain(`Your current job is ${JSON.stringify(job.roleLine)}`)
        expect(turns[0]?.developerInstructions).toContain(`Bot SOUL:\n${job.instructions}`)
        expect(turns[0]?.developerInstructions).toContain("never infer a different job from it")
        expect(f.spawnTree).not.toHaveBeenCalled()
      } finally {
        await engine?.shutdown()
        f.close()
      }
    })
  }
}
