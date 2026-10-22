import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Run, ToolContext, ToolRegistration } from "@touri/contracts"
import { init } from "../../src/browser"
import { createBrowserEngine } from "../../src/browser/engine"
import { createKernel } from "../../src/kernel"

const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup()
  cleanups.clear()
})

test.each(["browser_submit_secret", "browser_request_takeover"])(
  "a rejected %s does not retain a human wait or block the next request",
  async (toolName) => {
    const root = await mkdtemp(join(tmpdir(), "touri-failed-handoff-"))
    const runtime = createKernel({ appData: root })
    const database = runtime.kernel.db as Database
    const registered = Promise.withResolvers<ToolRegistration[]>()
    const kernel = new Proxy(runtime.kernel, {
      get(target, key) {
        if (key === "registerTools")
          return (input: { tools: ToolRegistration[] }) => {
            registered.resolve(input.tools)
            return target.registerTools(input)
          }
        return Reflect.get(target, key)
      },
    })
    const engine = createBrowserEngine({ kernel })
    cleanups.add(async () => {
      await engine.shutdown()
      await runtime.stop()
      await rm(root, { recursive: true, force: true })
    })
    database.exec(`
      INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at,responsible_person_id)
        VALUES ('leo','Léo','codex','/workspace',1,1,'owner');
      INSERT INTO bot_groups(id,name,color,avatar_shape,avatar_seed,created_at,updated_at)
        VALUES ('travel','Viagens','#888888','circle','travel',1,1);
      INSERT INTO threads(id,bot_id,title,created_at,updated_at,group_id,group_thread_id)
        VALUES ('channel','leo','Viagens',1,1,'travel',NULL), ('child','leo','Viagens',1,1,'travel','channel');
      INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at,requester_person_id)
        VALUES ('first','child','leo','codex','user','running',1,'ana'),
          ('next','child','leo','codex','user','running',2,'ana');
    `)
    kernel.services.provide("work.personChannelIds", () => ["travel"])
    await init(kernel, undefined, { engine })
    const tool = (await registered.promise).find((entry) => entry.name === toolName)
    if (!tool) throw new Error("Missing handoff tool")
    const context: ToolContext = {
      botId: "leo",
      threadId: "child",
      runId: "first",
      projectId: null,
      cwd: root,
      signal: new AbortController().signal,
    }

    const result = await tool.handler({ ctx: context, args: { tabId: "closed-tab" } })

    expect(result.success).toBe(false)
    expect(database.query("SELECT status,needs_you_at FROM browser_channel_runs WHERE run_id = 'first'").get()).toEqual(
      {
        status: "running",
        needs_you_at: null,
      },
    )

    kernel.publish({ type: "run.updated", run: getFinishedRun() })
    const next = await tool.handler({
      ctx: Object.assign({}, context, { runId: "next" }),
      args: { tabId: "closed-tab" },
    })

    expect(next.success).toBe(false)
    expect(database.query("SELECT status FROM browser_channel_runs WHERE run_id = 'first'").get()).toEqual({
      status: "succeeded",
    })
    expect(database.query("SELECT status FROM browser_channel_runs WHERE run_id = 'next'").get()).toEqual({
      status: "running",
    })
  },
)

const getFinishedRun = (): Run => ({
  id: "first",
  threadId: "child",
  botId: "leo",
  provider: "codex",
  trigger: "user",
  status: "succeeded",
  requestMessageId: null,
  replyMessageId: null,
  externalTurnId: null,
  errorClass: null,
  errorMessage: null,
  usage: null,
  routineRunId: null,
  queuedAt: 1,
  startedAt: 1,
  finishedAt: 2,
})
